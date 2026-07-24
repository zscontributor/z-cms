import {
  BadRequestException,
  ConflictException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { getSystemDb } from "@zcmsorg/database";
import {
  highestRole,
  permissionsForRole,
  type AcceptInviteInput,
  type AccessTokenClaims,
  type AuthResult,
  type ChangePasswordInput,
  type LoginInput,
  type LoginResult,
  type MfaChallenge,
  type MfaVerifyInput,
  type Role,
  type SessionUser,
} from "@zcmsorg/schemas";
import bcrypt from "bcryptjs";
import { createHash, randomUUID } from "node:crypto";
import type { SignOptions } from "jsonwebtoken";
import { t } from "../common/i18n";
import { MfaService } from "./mfa.service";
import { RevocationService } from "./revocation.service";
import { SecurityEventService } from "../audit/security-event.service";

/** Metadata recorded with a refresh token, for auditing a theft after the fact. */
export interface SessionContext {
  ip?: string;
  userAgent?: string;
}

/**
 * What the challenge ticket carries. `purpose` is the field that keeps it from
 * ever being mistaken for a session.
 */
interface MfaChallengeClaims {
  sub: string;
  tid: string;
  purpose: "mfa";
}

/**
 * Five minutes to produce a code.
 *
 * Long enough to unlock a phone and find the app; short enough that a challenge
 * ticket left in a proxy log, a browser history or an abandoned tab is worthless
 * by the time anyone reads it. It is a password check that has already happened —
 * it should not keep being true for an hour.
 */
const MFA_CHALLENGE_TTL_SECONDS = 300;

@Injectable()
export class AuthService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly revocations: RevocationService,
    private readonly events: SecurityEventService,
    private readonly mfa: MfaService,
  ) {}

  /**
   * The password step.
   *
   * Answers with tokens only when the account has no second factor. When it does,
   * the password alone buys nothing but a short-lived ticket — see MfaChallenge —
   * and `lastLoginAt` is deliberately NOT stamped: the login has not happened yet,
   * and a "last sign-in" that moves every time someone types a right password and
   * then fails the code would be a lie in the one column an admin reads to spot a
   * compromised account.
   */
  async login(input: LoginInput, ctx: SessionContext = {}): Promise<LoginResult> {
    // Login is inherently cross-tenant: we do not know the tenant until we know
    // the user, so this is one of the few places the system client is correct.
    const db = getSystemDb();
    const user = await db.user.findUnique({
      where: { email: input.email.toLowerCase() },
      include: { tenant: true },
    });

    // Hash even when the user does not exist, so that a missing account and a
    // wrong password take the same time. Otherwise the endpoint tells an
    // attacker which emails are registered.
    const hash = user?.passwordHash ?? "$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidi";
    const ok = await bcrypt.compare(input.password, hash);

    if (!user || !ok) {
      throw new UnauthorizedException(t()("errors.auth.invalidCredentials"));
    }

    if (user.totpEnabledAt) {
      return this.issueMfaChallenge(user.id, user.tenantId);
    }

    await db.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    // A fresh login starts a new rotation family.
    return this.issueTokens(user.id, user.tenantId, randomUUID(), ctx);
  }

  /**
   * The code step: trade a challenge ticket plus a valid second factor for real
   * tokens.
   *
   * The ticket carries the user id, so the code is checked against the account
   * the password was checked against — the client never gets to say who it is
   * claiming to be at this step. That matters: a verify endpoint taking an email
   * and a code would let anyone who has a leaked code try it against any account.
   */
  async verifyMfa(input: MfaVerifyInput, ctx: SessionContext = {}): Promise<AuthResult> {
    let claims: MfaChallengeClaims;
    try {
      claims = await this.jwt.verifyAsync<MfaChallengeClaims>(input.challengeToken, {
        secret: this.mfaSecret(),
      });
    } catch {
      throw new UnauthorizedException(t()("errors.mfa.challengeExpired"));
    }

    // Belt and braces. The signature already proves this token came from us, but
    // a claim saying what a token is FOR is what stops a future token signed with
    // the same key from being usable here by accident.
    if (claims.purpose !== "mfa") {
      throw new UnauthorizedException(t()("errors.mfa.challengeExpired"));
    }

    await this.mfa.verifySecondFactor(claims.sub, claims.tid, input.code);

    await getSystemDb().user.update({
      where: { id: claims.sub },
      data: { lastLoginAt: new Date() },
    });

    return this.issueTokens(claims.sub, claims.tid, randomUUID(), ctx);
  }

  private async issueMfaChallenge(userId: string, tenantId: string): Promise<MfaChallenge> {
    const claims: MfaChallengeClaims = { sub: userId, tid: tenantId, purpose: "mfa" };

    const challengeToken = await this.jwt.signAsync(claims, {
      secret: this.mfaSecret(),
      expiresIn: MFA_CHALLENGE_TTL_SECONDS,
    });

    return {
      mfaRequired: true,
      challengeToken,
      expiresIn: MFA_CHALLENGE_TTL_SECONDS,
    };
  }

  /**
   * Rotates a refresh token, and detects theft while doing it.
   *
   * A refresh token is meant to be used exactly once. The sequence:
   *
   *   1. verify the JWT (signature + expiry) — a cheap gate before any DB hit
   *   2. look it up by hash. Unknown → reject.
   *   3. already REVOKED, or already CONSUMED → someone is replaying a token that
   *      was retired. We cannot tell the legitimate client from a thief, so we
   *      kill the entire family. Both are logged out; the real user logs back in,
   *      the thief is left holding dead tokens.
   *   4. otherwise: mark it consumed, issue a new pair in the same family.
   */
  async refresh(refreshToken: string, ctx: SessionContext = {}): Promise<AuthResult> {
    let claims: AccessTokenClaims;
    try {
      claims = await this.jwt.verifyAsync<AccessTokenClaims>(refreshToken, {
        secret: this.refreshSecret(),
      });
    } catch {
      throw new UnauthorizedException(t()("errors.auth.invalidRefreshToken"));
    }

    const db = getSystemDb();
    const tokenHash = this.hash(refreshToken);
    const stored = await db.refreshToken.findUnique({ where: { tokenHash } });

    if (!stored) {
      throw new UnauthorizedException(t()("errors.auth.invalidRefreshToken"));
    }

    if (stored.revokedAt || stored.consumedAt) {
      // Reuse of a retired token. Revoke the whole family — this is the theft
      // response, and it deliberately errs toward logging everyone out.
      await db.refreshToken.updateMany({
        where: { familyId: stored.familyId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      // Kill the access tokens too, not just the ability to get new ones. A thief
      // holding a valid access token would otherwise keep the session for another
      // full TTL after we detected the theft.
      await this.revocations.revoke(stored.familyId);

      // This is the one auth event that means "a credential has been stolen and
      // is being used". It alerts, it does not merely log.
      this.events.record("auth.session_theft_detected", {
        userId: stored.userId,
        tenantId: stored.tenantId,
        familyId: stored.familyId,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        tokenIssuedTo: stored.ip,
      });

      throw new UnauthorizedException(t()("errors.auth.refreshReused"));
    }

    if (stored.expiresAt.getTime() < Date.now()) {
      throw new UnauthorizedException(t()("errors.auth.invalidRefreshToken"));
    }

    await db.refreshToken.update({
      where: { id: stored.id },
      data: { consumedAt: new Date() },
    });

    return this.issueTokens(claims.sub, claims.tid, stored.familyId, ctx);
  }

  /** Revokes the family a refresh token belongs to. Logout, everywhere. */
  async logout(refreshToken: string): Promise<void> {
    let claims: AccessTokenClaims;
    try {
      claims = await this.jwt.verifyAsync<AccessTokenClaims>(refreshToken, {
        secret: this.refreshSecret(),
      });
    } catch {
      // A logout with a bad token is a no-op, not an error — the caller wanted to
      // be logged out and, as far as this token goes, they are.
      return;
    }

    const db = getSystemDb();
    const stored = await db.refreshToken.findUnique({
      where: { tokenHash: this.hash(refreshToken) },
    });
    if (!stored) return;

    await db.refreshToken.updateMany({
      where: { familyId: stored.familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await this.revocations.revoke(stored.familyId);

    // Belt and braces: the JWT claims agree with the row, so nothing to cross-check.
    void claims;
  }

  /**
   * Redeems an invitation: creates the account, grants the invited role, and
   * signs the new user in.
   *
   * Public by necessity — the invitee has no session, that is the point of the
   * invitation. What stands in for one is the token: single-use, expiring, and
   * matched by hash. Everything that decides *what access this produces* comes
   * from the stored row (tenant, site, role), never from the request body, so a
   * crafted payload cannot upgrade an invitation to something it was not.
   *
   * The whole redemption is one transaction. If the membership insert fails, the
   * user is not left existing-but-role-less, and the token is not left consumed
   * for an account that was never created.
   */
  async acceptInvite(input: AcceptInviteInput, ctx: SessionContext = {}): Promise<AuthResult> {
    const db = getSystemDb();

    const invite = await db.invitation.findUnique({
      where: { tokenHash: this.hash(input.token) },
    });

    // One message for "no such token", "already used", "withdrawn" and "expired".
    // Distinguishing them would let someone with a list of guesses learn which
    // ones were ever real.
    const usable =
      invite &&
      !invite.acceptedAt &&
      !invite.revokedAt &&
      invite.expiresAt.getTime() > Date.now();
    if (!invite || !usable) {
      throw new BadRequestException(t()("errors.users.inviteInvalid"));
    }

    // The email is globally unique, so an invitation sent to someone who has
    // since signed up (or was invited twice and redeemed the other link) cannot
    // become a second account. Say so plainly: there is nothing secret about an
    // address the invitee just typed a token for.
    if (await db.user.findUnique({ where: { email: invite.email } })) {
      throw new ConflictException(t()("errors.users.alreadyRegistered"));
    }

    const passwordHash = await bcrypt.hash(input.password, 12);

    const user = await db.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          tenantId: invite.tenantId,
          email: invite.email,
          name: input.name,
          passwordHash,
        },
      });

      await tx.membership.create({
        data: {
          tenantId: invite.tenantId,
          userId: created.id,
          siteId: invite.siteId,
          role: invite.role,
        },
      });

      // Consumed inside the transaction and guarded by the `acceptedAt IS NULL`
      // filter: two requests racing the same link produce one account, not two,
      // because the loser updates zero rows and rolls back.
      const consumed = await tx.invitation.updateMany({
        where: { id: invite.id, acceptedAt: null },
        data: { acceptedAt: new Date() },
      });
      if (consumed.count === 0) {
        throw new BadRequestException(t()("errors.users.inviteInvalid"));
      }

      return created;
    });

    this.events.record("auth.invite_accepted", {
      userId: user.id,
      tenantId: user.tenantId,
      invitationId: invite.id,
      role: invite.role,
      siteId: invite.siteId,
      ip: ctx.ip,
    });

    return this.issueTokens(user.id, user.tenantId, randomUUID(), ctx);
  }

  /**
   * Changes the caller's own password, and signs them out everywhere.
   *
   * The current password is required even though the request is authenticated:
   * being signed in proves someone has the laptop, not that they are the account
   * holder.
   *
   * Every session dies, including the one that made the request. That is the
   * point — the usual reason to change a password is that you think someone else
   * has it, and a change that leaves the intruder's session alive has done
   * nothing. The caller is told to sign in again; the intruder simply cannot.
   */
  async changePassword(
    userId: string,
    tenantId: string,
    input: ChangePasswordInput,
  ): Promise<void> {
    const db = getSystemDb();
    const user = await db.user.findFirst({ where: { id: userId, tenantId } });
    if (!user) throw new UnauthorizedException(t()("errors.auth.accountNotFound"));

    if (!(await bcrypt.compare(input.currentPassword, user.passwordHash))) {
      throw new UnauthorizedException(t()("errors.users.wrongPassword"));
    }

    await db.user.update({
      where: { id: user.id },
      data: { passwordHash: await bcrypt.hash(input.newPassword, 12) },
    });

    await this.revokeAllSessions(user.id);

    this.events.record("auth.password_changed", { userId: user.id, tenantId });
  }

  /**
   * Ends every session a user has, everywhere.
   *
   * Both halves are needed and neither is sufficient. Revoking the refresh rows
   * stops the session being *extended*; deny-listing the families stops the
   * access tokens already in flight, which are stateless JWTs and would otherwise
   * keep working for the rest of their TTL. Used on password change, on removal
   * from the tenant, and on a demotion — the three moments where "they still have
   * a valid token for the next fifteen minutes" is the wrong answer.
   */
  async revokeAllSessions(userId: string): Promise<void> {
    const db = getSystemDb();

    const families = await db.refreshToken.findMany({
      where: { userId, revokedAt: null },
      select: { familyId: true },
      distinct: ["familyId"],
    });

    await db.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    await Promise.all(families.map(({ familyId }) => this.revocations.revoke(familyId)));
  }

  async sessionUser(userId: string, tenantId: string): Promise<SessionUser> {
    const db = getSystemDb();
    const user = await db.user.findFirst({
      where: { id: userId, tenantId },
      include: { tenant: true },
    });
    if (!user) throw new UnauthorizedException(t()("errors.auth.accountNotFound"));

    // The highest role the user holds anywhere in the tenant. Site-specific
    // roles are resolved per request by AuthGuard using X-Site-Id; this is the
    // baseline the admin UI uses to decide what to even show.
    const memberships = await db.membership.findMany({
      where: { userId: user.id, tenantId },
    });
    const role = highestRole(memberships.map((m) => m.role as Role));

    return {
      id: user.id,
      email: user.email,
      name: user.name,
      avatarUrl: user.avatarUrl,
      tenantId: user.tenantId,
      tenantSlug: user.tenant.slug,
      role,
      permissions: [...permissionsForRole(role)],
      twoFactorEnabled: user.totpEnabledAt !== null,
    };
  }

  private async issueTokens(
    userId: string,
    tenantId: string,
    familyId: string,
    ctx: SessionContext,
  ): Promise<AuthResult> {
    const user = await this.sessionUser(userId, tenantId);
    const claims: AccessTokenClaims = {
      sub: userId,
      tid: tenantId,
      email: user.email,
      // Names the session, so revoking it can reach an access token already issued.
      fid: familyId,
    };

    // `expiresIn` is typed as a template literal ("15m", "30d"...) rather than a
    // plain string, but ours comes from the environment, so it is only a string
    // at compile time. The value is validated by jsonwebtoken at signing.
    const accessTtl = (this.config.get<string>("JWT_ACCESS_TTL") ??
      "15m") as SignOptions["expiresIn"];
    const refreshTtl = (this.config.get<string>("JWT_REFRESH_TTL") ??
      "30d") as SignOptions["expiresIn"];

    // A per-token jti makes each refresh token unique even for the same user in
    // the same second, so two logins never collide on the tokenHash unique index.
    const jti = randomUUID();

    const [accessToken, refreshToken] = await Promise.all([
      this.jwt.signAsync(claims, {
        secret: this.config.getOrThrow<string>("JWT_SECRET"),
        expiresIn: accessTtl,
      }),
      this.jwt.signAsync({ ...claims, jti }, {
        secret: this.refreshSecret(),
        expiresIn: refreshTtl,
      }),
    ]);

    await getSystemDb().refreshToken.create({
      data: {
        tenantId,
        userId,
        tokenHash: this.hash(refreshToken),
        familyId,
        expiresAt: this.refreshExpiry(refreshTtl),
        ip: ctx.ip,
        userAgent: ctx.userAgent?.slice(0, 512),
      },
    });

    return { accessToken, refreshToken, user };
  }

  /** SHA-256 of the token. Only the hash is stored, like a password. */
  private hash(token: string): string {
    return createHash("sha256").update(token).digest("hex");
  }

  private refreshExpiry(ttl: SignOptions["expiresIn"]): Date {
    // Mirror the JWT's own expiry so the row and the token agree. Supports the
    // "30d" / "12h" / "15m" forms the config uses; falls back to 30 days.
    const raw = String(ttl ?? "30d");
    const match = /^(\d+)\s*([smhd])$/.exec(raw);
    const seconds = match
      ? Number(match[1]) * { s: 1, m: 60, h: 3600, d: 86_400 }[match[2] as "s" | "m" | "h" | "d"]
      : 30 * 86_400;
    return new Date(Date.now() + seconds * 1000);
  }

  /**
   * Refresh tokens are signed with a *different* key than access tokens.
   * If they shared one, a leaked access token could be replayed against
   * /auth/refresh to mint fresh credentials forever.
   */
  private refreshSecret(): string {
    return `${this.config.getOrThrow<string>("JWT_SECRET")}:refresh`;
  }

  /**
   * And the challenge ticket gets a third key, for the same reason again.
   *
   * If it shared the access-token key, a stolen access token could be presented
   * at /auth/mfa/verify — an endpoint whose entire job is to hand out sessions —
   * and the second factor would be a formality. Three purposes, three keys.
   */
  private mfaSecret(): string {
    return `${this.config.getOrThrow<string>("JWT_SECRET")}:mfa`;
  }
}
