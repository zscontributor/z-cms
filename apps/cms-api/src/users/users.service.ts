import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { db, getSystemDb } from "@zcmsorg/database";
import {
  canGrantRole,
  PASSWORD_MIN,
  ROLE_RANK,
  type CreateUserInput,
  type InvitationCreatedDto,
  type InvitationDto,
  type InviteUserInput,
  type Role,
  type SetMembershipInput,
  type UserCreatedDto,
  type UpdateProfileInput,
  type UserDto,
} from "@zcmsorg/schemas";
import { createHash, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { AuditService } from "../audit/audit.module";
import { AuthService } from "../auth/auth.service";
import { MfaService } from "../auth/mfa.service";
import { t } from "../common/i18n";
import type { RequestActor } from "../common/request-context";
import { MailService } from "../mail/mail.service";
import { toInvitationDto, toUserDto } from "./users.mappers";

/** Long enough that guessing is hopeless; short enough to paste into a chat. */
const INVITE_TOKEN_BYTES = 32;
const INVITE_TTL_DAYS = 7;

/**
 * Who may act on whom.
 *
 * Permissions say what a role may *do*; they cannot say who it may do it *to*.
 * `user:manage` alone would let an OWNER remove the only other OWNER, or let an
 * ADMIN with `user:invite` mint an OWNER and inherit the tenant. Those are not
 * permission questions, they are relationship questions, and they live here — in
 * the service, where the target is known — rather than in the guard, which only
 * ever sees the caller.
 *
 * Four rules, each earning its place:
 *
 *   1. You may not grant a role above your own.  (privilege escalation)
 *   2. You may not act on someone who outranks you.  (an ADMIN cannot remove an OWNER)
 *   3. You may not change your own role or remove yourself.  (self-lockout, and
 *      the sideways version of rule 1: promoting yourself)
 *   4. The last OWNER cannot be demoted or removed.  (a tenant nobody can
 *      administer is unrecoverable without database access)
 */
@Injectable()
export class UsersService {
  constructor(
    private readonly audit: AuditService,
    private readonly auth: AuthService,
    private readonly mfa: MfaService,
    private readonly mail: MailService,
  ) {}

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  /**
   * Everyone in the tenant. No `where: { tenantId }` and none needed — this runs
   * inside withTenant(), so RLS has already drawn the boundary.
   */
  async list(): Promise<UserDto[]> {
    const users = await db().user.findMany({
      include: { memberships: { include: { site: { select: { name: true } } } } },
      orderBy: { createdAt: "asc" },
    });
    return users.map(toUserDto);
  }

  async findOne(id: string): Promise<UserDto> {
    const user = await db().user.findUnique({
      where: { id },
      include: { memberships: { include: { site: { select: { name: true } } } } },
    });
    if (!user) throw new NotFoundException(t()("errors.users.notFound"));
    return toUserDto(user);
  }

  /** Invitations still awaiting an answer. Spent and withdrawn ones are history, not work. */
  async listPendingInvitations(): Promise<InvitationDto[]> {
    const invitations = await db().invitation.findMany({
      where: { acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
      include: {
        site: { select: { name: true } },
        invitedBy: { select: { name: true } },
      },
      orderBy: { createdAt: "desc" },
    });
    return invitations.map(toInvitationDto);
  }

  // -------------------------------------------------------------------------
  // Profile — the caller acting on themselves. No permission, by design: a
  // VIEWER who cannot change their own name would have to ask an admin to.
  // -------------------------------------------------------------------------

  async updateProfile(actor: RequestActor, input: UpdateProfileInput): Promise<UserDto> {
    const updated = await db().user.update({
      where: { id: actor.userId },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.avatarUrl !== undefined ? { avatarUrl: input.avatarUrl } : {}),
      },
      include: { memberships: { include: { site: { select: { name: true } } } } },
    });
    return toUserDto(updated);
  }

  async update(actor: RequestActor, userId: string, input: UpdateProfileInput): Promise<UserDto> {
    const target = await this.loadTarget(actor, userId);

    const updated = await db().user.update({
      where: { id: userId },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.avatarUrl !== undefined ? { avatarUrl: input.avatarUrl } : {}),
      },
      include: { memberships: { include: { site: { select: { name: true } } } } },
    });

    await this.audit.record(actor, "user.updated", "user", userId, {
      email: target.email,
      fields: Object.keys(input),
    });

    return toUserDto(updated);
  }

  // -------------------------------------------------------------------------
  // Invitations
  // -------------------------------------------------------------------------

  async create(actor: RequestActor, input: CreateUserInput): Promise<UserCreatedDto> {
    const email = input.email.toLowerCase();
    const password = input.password ?? randomPassword();

    this.assertMayGrant(actor, input.role);
    await this.assertMayActOnSite(actor, input.siteId);

    const existing = await getSystemDb().user.findUnique({
      where: { email },
      select: { id: true },
    });
    if (existing) throw new ConflictException(t()("errors.users.emailTaken", { email }));

    const passwordHash = await bcrypt.hash(password, 12);

    const created = await getSystemDb().$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          tenantId: actor.tenantId,
          email,
          name: input.name,
          passwordHash,
        },
      });

      await tx.membership.create({
        data: {
          tenantId: actor.tenantId,
          userId: user.id,
          siteId: input.siteId,
          role: input.role,
        },
      });

      return user;
    });

    await this.audit.record(actor, "user.created", "user", created.id, {
      email,
      role: input.role,
      siteId: input.siteId,
    });

    const user = await this.findOne(created.id);
    const loginPageUrl = accountLoginUrl();
    const emailQueued = await this.queueAccountCreatedMail(actor, input.siteId, {
      email,
      name: input.name,
      password,
      loginUrl: loginPageUrl,
    });

    return { user, password, loginUrl: loginPageUrl, emailQueued };
  }

  /**
   * Creates an invitation and returns its token — once.
   *
   * Only the hash is stored, so this response is the only place the raw token
   * ever exists. That is deliberate (see the Invitation model), and it is why the
   * caller must be told to copy the link now rather than come back for it.
   */
  async invite(actor: RequestActor, input: InviteUserInput): Promise<InvitationCreatedDto> {
    const email = input.email.toLowerCase();

    this.assertMayGrant(actor, input.role);
    await this.assertMayActOnSite(actor, input.siteId);

    // The email is unique across the whole installation, so an existing account
    // cannot be invited into a second one. Changing what an existing user may do
    // is a membership change, not an invitation — and it is a different
    // permission (`user:manage`), which is exactly why this is not silently
    // treated as one.
    const existing = await getSystemDb().user.findUnique({
      where: { email },
      select: { id: true },
    });
    if (existing) throw new ConflictException(t()("errors.users.emailTaken", { email }));

    const pending = await db().invitation.findFirst({
      where: { email, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
    });
    if (pending) throw new ConflictException(t()("errors.users.alreadyInvited", { email }));

    const token = randomBytes(INVITE_TOKEN_BYTES).toString("base64url");
    const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 86_400_000);

    const invitation = await db().invitation.create({
      data: {
        tenantId: actor.tenantId,
        siteId: input.siteId,
        email,
        role: input.role,
        tokenHash: hashToken(token),
        invitedById: actor.userId,
        expiresAt,
      },
      include: {
        site: { select: { name: true } },
        invitedBy: { select: { name: true } },
      },
    });

    await this.audit.record(actor, "user.invited", "invitation", invitation.id, {
      email,
      role: input.role,
      siteId: input.siteId,
    });

    return { invitation: toInvitationDto(invitation), token };
  }

  /**
   * Withdraws an invitation. The row survives with `revokedAt` set rather than
   * being deleted: a link that was sent out and then pulled back is a thing that
   * happened, and the token hash has to keep existing for the redemption path to
   * recognise it as dead rather than as unknown.
   */
  async revokeInvitation(actor: RequestActor, id: string): Promise<void> {
    const invitation = await db().invitation.findUnique({ where: { id } });
    if (!invitation) throw new NotFoundException(t()("errors.users.inviteNotFound"));

    if (invitation.acceptedAt) {
      throw new BadRequestException(t()("errors.users.inviteAlreadyAccepted"));
    }
    if (invitation.revokedAt) return;

    await db().invitation.update({ where: { id }, data: { revokedAt: new Date() } });

    await this.audit.record(actor, "user.invite_revoked", "invitation", id, {
      email: invitation.email,
      role: invitation.role,
    });
  }

  // -------------------------------------------------------------------------
  // Memberships
  // -------------------------------------------------------------------------

  /**
   * Sets a user's role, either on one site or across the tenant.
   *
   * An upsert on (userId, siteId): granting EDITOR on a site the user is already
   * an AUTHOR on replaces the row rather than adding a second one, because two
   * memberships with the same scope would make "what is their role here?"
   * ambiguous, and AuthGuard would answer it by whichever row Postgres returned
   * first.
   *
   * A demotion revokes their sessions. Not because the old role would survive —
   * roles are resolved from the database on every request, so a demotion bites
   * immediately — but because the *reason* one demotes someone in a hurry is that
   * they should not be in the building, and leaving their tabs open is not the
   * message anyone intends to send. A promotion leaves the session alone: there
   * is nothing to take away.
   */
  async setMembership(
    actor: RequestActor,
    userId: string,
    input: SetMembershipInput,
  ): Promise<UserDto> {
    const target = await this.loadTarget(actor, userId);

    this.assertMayGrant(actor, input.role);
    await this.assertMayActOnSite(actor, input.siteId);

    const previous = target.memberships.find((m) => m.siteId === input.siteId)?.role as
      | Role
      | undefined;

    // Rule 4, checked BEFORE the write and against the whole tenant: this is the
    // only role change that can make a tenant unadministrable.
    if (previous === "OWNER" && input.role !== "OWNER") {
      await this.assertNotLastOwner(userId);
    }

    // Prisma cannot upsert on (userId, siteId) when siteId is NULL — the unique
    // index does not cover it (Postgres treats NULLs as distinct; a partial index
    // does the job at the database level). Find-then-write, inside the request's
    // transaction, so the two halves cannot interleave with another admin's.
    const existing = target.memberships.find((m) => m.siteId === input.siteId);
    if (existing) {
      await db().membership.update({
        where: { id: existing.id },
        data: { role: input.role },
      });
    } else {
      await db().membership.create({
        data: {
          tenantId: actor.tenantId,
          userId,
          siteId: input.siteId,
          role: input.role,
        },
      });
    }

    await this.audit.record(actor, "user.role_changed", "user", userId, {
      email: target.email,
      siteId: input.siteId,
      from: previous ?? null,
      to: input.role,
    });

    if (previous && isDemotion(previous, input.role)) {
      await this.auth.revokeAllSessions(userId);
    }

    return this.findOne(userId);
  }

  /**
   * Removes one membership — a user's role on a single site, or their tenant-wide
   * role. The account itself survives, and so does everything they wrote.
   */
  async removeMembership(actor: RequestActor, userId: string, membershipId: string): Promise<UserDto> {
    const target = await this.loadTarget(actor, userId);

    const membership = target.memberships.find((m) => m.id === membershipId);
    if (!membership) throw new NotFoundException(t()("errors.users.membershipNotFound"));

    if (membership.role === "OWNER") await this.assertNotLastOwner(userId);

    await db().membership.delete({ where: { id: membershipId } });

    await this.audit.record(actor, "user.membership_removed", "user", userId, {
      email: target.email,
      siteId: membership.siteId,
      role: membership.role,
    });

    await this.auth.revokeAllSessions(userId);

    return this.findOne(userId);
  }

  /**
   * Strips another user's second factor.
   *
   * Routed through `loadTarget` like every other act-on-a-person operation, and
   * that is not ceremony: it means an ADMIN cannot reset an OWNER's 2FA, and
   * nobody can reset their own (which would be a way to drop the factor without
   * the password `disable` demands). The rules that govern who may demote whom
   * are exactly the rules that should govern who may unlock whom.
   *
   * Their sessions die. Not to lock them out — they are about to sign in again —
   * but so that a person whose protection was removed without their asking finds
   * out on the very next screen, rather than in a month.
   */
  async resetTwoFactor(actor: RequestActor, userId: string): Promise<void> {
    const target = await this.loadTarget(actor, userId);

    await this.mfa.reset(actor.userId, userId, actor.tenantId);
    await this.auth.revokeAllSessions(userId);

    await this.audit.record(actor, "user.two_factor_reset", "user", userId, {
      email: target.email,
    });
  }

  /**
   * Removes the user from the tenant entirely.
   *
   * What survives them is deliberate and is enforced by the schema, not here:
   * their posts, their uploads and their audit rows all reference them with
   * `onDelete: SetNull`. Deleting an author has never been a reason to unpublish
   * their work — a CMS that took the homepage down because someone left the
   * company would be unusable.
   *
   * Their sessions are revoked BEFORE the row goes. Cascade would delete the
   * refresh tokens either way, which stops the session being extended, but an
   * access token already in flight is a stateless JWT: without the deny-list
   * entry it would keep opening doors for the rest of its TTL, for an account
   * that no longer exists.
   */
  async remove(actor: RequestActor, userId: string): Promise<void> {
    const target = await this.loadTarget(actor, userId);

    if (target.memberships.some((m) => m.role === "OWNER")) {
      await this.assertNotLastOwner(userId);
    }

    await this.auth.revokeAllSessions(userId);

    await this.audit.record(actor, "user.removed", "user", userId, {
      email: target.email,
      roles: target.memberships.map((m) => m.role),
    });

    await db().user.delete({ where: { id: userId } });
  }

  // -------------------------------------------------------------------------
  // The rules
  // -------------------------------------------------------------------------

  /**
   * Loads the user being acted on, and applies rules 2 and 3 while doing it —
   * every caller needs both, so neither can be forgotten by omission.
   */
  private async loadTarget(actor: RequestActor, userId: string) {
    if (userId === actor.userId) {
      throw new ForbiddenException(t()("errors.users.notYourself"));
    }

    const target = await db().user.findUnique({
      where: { id: userId },
      include: { memberships: true },
    });
    if (!target) throw new NotFoundException(t()("errors.users.notFound"));

    // Their strongest role anywhere in the tenant, not their role on the site the
    // actor happens to be looking at. An ADMIN on the marketing site must not be
    // able to remove someone who is an OWNER of the tenant merely because that
    // OWNER holds no site-specific membership here.
    const targetRoles = target.memberships.map((m) => m.role as Role);
    if (targetRoles.some((role) => !canGrantRole(actor.role, role))) {
      throw new ForbiddenException(t()("errors.users.outranked"));
    }

    return target;
  }

  /** Rule 1: you may hand out your own role, or one below it. Never one above. */
  private assertMayGrant(actor: RequestActor, role: Role): void {
    if (!canGrantRole(actor.role, role)) {
      throw new ForbiddenException(
        t()("errors.users.cannotGrant", { role, actorRole: actor.role }),
      );
    }
  }

  /**
   * A role is granted somewhere, and the granter must have standing there.
   *
   * Without this, an ADMIN of one site could invite themselves an accomplice as
   * ADMIN of a site they have never been given access to — the permission check
   * passes (they do hold `user:invite`), and the site id is just a field in a
   * body they control. A tenant-wide grant (siteId null) is the strongest kind,
   * so only a tenant-wide member may make one.
   */
  private async assertMayActOnSite(actor: RequestActor, siteId: string | null): Promise<void> {
    const memberships = await db().membership.findMany({
      where: { userId: actor.userId },
      select: { siteId: true },
    });
    const tenantWide = memberships.some((m) => m.siteId === null);

    if (siteId === null) {
      if (!tenantWide) throw new ForbiddenException(t()("errors.users.needTenantWide"));
      return;
    }

    const site = await db().site.findUnique({ where: { id: siteId }, select: { id: true } });
    if (!site) throw new NotFoundException(t()("errors.users.siteNotFound"));

    if (!tenantWide && !memberships.some((m) => m.siteId === siteId)) {
      throw new ForbiddenException(t()("errors.users.notYourSite"));
    }
  }

  /**
   * Rule 4: a tenant must never be left with nobody who can administer it.
   *
   * Worth being honest about: as the routes stand today this check cannot fire.
   * `user:manage` is an OWNER-only permission, so every caller who reaches here
   * holds an OWNER membership, and rule 3 has already established they are not
   * the target — so the count below is at least one, always. Rule 3 *implies*
   * rule 4 for every path that exists right now.
   *
   * It is kept anyway, and it is not dead weight: the implication holds only
   * because every route into this service goes through `loadTarget`. The first
   * "leave this tenant" button, platform-operator override, or bulk import that
   * does not is where a tenant quietly loses its last owner — and the only tool
   * that can undo that is `psql`. This is the assertion that turns a silent
   * unrecoverable state into a 400.
   */
  private async assertNotLastOwner(userId: string): Promise<void> {
    const others = await db().membership.count({
      where: { role: "OWNER", userId: { not: userId } },
    });
    if (others === 0) throw new BadRequestException(t()("errors.users.lastOwner"));
  }

  private async queueAccountCreatedMail(
    actor: RequestActor,
    siteId: string | null,
    account: { email: string; name: string; password: string; loginUrl: string },
  ): Promise<boolean> {
    const mailSiteId = siteId ?? (await this.firstSiteId());
    if (!mailSiteId) return false;

    try {
      await this.mail.enqueue(actor.tenantId, mailSiteId, null, {
        to: [account.email],
        subject: "Your Z-CMS account has been created",
        text:
          `Hello ${account.name},\n\n` +
          "An administrator created a Z-CMS account for you.\n\n" +
          `Login: ${account.loginUrl}\n` +
          `Email: ${account.email}\n` +
          `Temporary password: ${account.password}\n\n` +
          "Please sign in and change your password from your profile.",
        html:
          `<p>Hello ${escapeHtml(account.name)},</p>` +
          "<p>An administrator created a Z-CMS account for you.</p>" +
          "<p>" +
          `<strong>Login:</strong> <a href="${escapeAttr(account.loginUrl)}">${escapeHtml(account.loginUrl)}</a><br>` +
          `<strong>Email:</strong> ${escapeHtml(account.email)}<br>` +
          `<strong>Temporary password:</strong> <code>${escapeHtml(account.password)}</code>` +
          "</p>" +
          "<p>Please sign in and change your password from your profile.</p>",
      });
      return true;
    } catch {
      return false;
    }
  }

  private async firstSiteId(): Promise<string | null> {
    const site = await db().site.findFirst({ select: { id: true }, orderBy: { createdAt: "asc" } });
    return site?.id ?? null;
  }
}

/** The same SHA-256 AuthService matches on redemption. The raw token is never stored. */
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function isDemotion(from: Role, to: Role): boolean {
  return ROLE_RANK[to] < ROLE_RANK[from];
}

function randomPassword(): string {
  const password = randomBytes(18).toString("base64url");
  return password.length >= PASSWORD_MIN ? password : `${password}x`.padEnd(PASSWORD_MIN, "x");
}

function accountLoginUrl(): string {
  const base = process.env.ADMIN_WEB_URL ?? process.env.NEXT_PUBLIC_ADMIN_URL ?? "http://localhost:3300";
  return `${base.replace(/\/+$/, "")}/login`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function escapeAttr(value: string): string {
  return escapeHtml(value);
}
