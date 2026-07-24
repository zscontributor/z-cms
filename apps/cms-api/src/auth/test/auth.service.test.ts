import { JwtService } from "@nestjs/jwt";
import bcrypt from "bcryptjs";
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isMfaChallenge } from "@zcmsorg/schemas";
import { AuthService } from "../auth.service";

/**
 * The session layer, attacked from the outside.
 *
 * Everything cryptographic here is REAL: bcrypt really hashes, jsonwebtoken
 * really signs. A suite that mocks the hash and then asserts the mock was called
 * proves that the code calls a function, not that a wrong password is refused —
 * and the second is the only claim worth making. Only Prisma is faked, and it is
 * faked with enough state (a token table that actually remembers consumedAt and
 * revokedAt) that rotation and theft detection are genuinely exercised.
 */

const state = vi.hoisted(() => ({ db: null as unknown as FakeDb }));
vi.mock("@zcmsorg/database", () => ({ getSystemDb: () => state.db }));

const PASSWORD = "correct horse battery staple";
const JWT_SECRET = "test-access-secret";
const REFRESH_SECRET = `${JWT_SECRET}:refresh`;

interface TokenRow {
  id: string;
  tenantId: string;
  userId: string;
  tokenHash: string;
  familyId: string;
  expiresAt: Date;
  consumedAt: Date | null;
  revokedAt: Date | null;
  ip?: string;
  userAgent?: string;
}

type FakeDb = ReturnType<typeof fakeDb>;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** A Prisma stand-in that remembers what happened to a refresh token. */
function fakeDb() {
  const users = [
    {
      id: "user-1",
      tenantId: "tenant-1",
      email: "owner@example.test",
      name: "Owner",
      avatarUrl: null,
      passwordHash: bcrypt.hashSync(PASSWORD, 10),
      lastLoginAt: null as Date | null,
      tenant: { slug: "acme" },
    },
  ];
  const memberships = [
    { id: "m1", userId: "user-1", tenantId: "tenant-1", siteId: null, role: "OWNER" },
  ];
  const tokens: TokenRow[] = [];
  const invitations = [
    {
      id: "inv-1",
      tenantId: "tenant-1",
      siteId: "site-1",
      email: "invitee@example.test",
      role: "AUTHOR",
      tokenHash: sha256("invite-token"),
      acceptedAt: null as Date | null,
      revokedAt: null as Date | null,
      expiresAt: new Date(Date.now() + 86_400_000),
    },
  ];

  const matches = (row: TokenRow, where: Record<string, unknown>) =>
    (where.familyId === undefined || row.familyId === where.familyId) &&
    (where.userId === undefined || row.userId === where.userId) &&
    (where.revokedAt !== null || row.revokedAt === null);

  let seq = 0;

  return {
    tokens,
    invitations,
    memberships,
    users,
    user: {
      findUnique: vi.fn(async ({ where }: any) =>
        users.find((u) => u.email === where.email) ?? null,
      ),
      findFirst: vi.fn(async ({ where }: any) =>
        users.find((u) => u.id === where.id && u.tenantId === where.tenantId) ?? null,
      ),
      update: vi.fn(async ({ where, data }: any) => {
        const user = users.find((u) => u.id === where.id)!;
        Object.assign(user, data);
        return user;
      }),
      create: vi.fn(async ({ data }: any) => {
        const created = { id: `user-${++seq}`, tenant: { slug: "acme" }, ...data };
        users.push(created);
        return created;
      }),
    },
    membership: {
      findMany: vi.fn(async () => memberships),
      create: vi.fn(async ({ data }: any) => {
        memberships.push({ id: `m-${++seq}`, ...data });
        return data;
      }),
    },
    invitation: {
      findUnique: vi.fn(async ({ where }: any) =>
        invitations.find((i) => i.tokenHash === where.tokenHash) ?? null,
      ),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const hit = invitations.filter(
          (i) => i.id === where.id && (where.acceptedAt !== null || i.acceptedAt === null),
        );
        hit.forEach((i) => Object.assign(i, data));
        return { count: hit.length };
      }),
    },
    refreshToken: {
      create: vi.fn(async ({ data }: any) => {
        const row: TokenRow = {
          id: `rt-${++seq}`,
          consumedAt: null,
          revokedAt: null,
          ...data,
        };
        tokens.push(row);
        return row;
      }),
      findUnique: vi.fn(async ({ where }: any) =>
        tokens.find((row) => row.tokenHash === where.tokenHash) ?? null,
      ),
      findMany: vi.fn(async ({ where }: any) =>
        tokens.filter((row) => matches(row, where)),
      ),
      update: vi.fn(async ({ where, data }: any) => {
        const row = tokens.find((r) => r.id === where.id)!;
        Object.assign(row, data);
        return row;
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const hit = tokens.filter((row) => matches(row, where));
        hit.forEach((row) => Object.assign(row, data));
        return { count: hit.length };
      }),
    },
    $transaction: vi.fn(async (fn: any) => fn(state.db)),
  };
}

function makeService() {
  state.db = fakeDb();

  const env: Record<string, string> = {
    JWT_SECRET,
    JWT_ACCESS_TTL: "15m",
    JWT_REFRESH_TTL: "30d",
  };
  const config = {
    get: (key: string) => env[key],
    getOrThrow: (key: string) => {
      const value = env[key];
      if (!value) throw new Error(`missing ${key}`);
      return value;
    },
  } as any;

  const revocations = { revoke: vi.fn(), isRevoked: vi.fn(async () => false) } as any;
  const events = { record: vi.fn() } as any;

  // The second factor is covered elsewhere: totp.test.ts for the algorithm (against
  // the RFC 6238 vectors), test/verify-mfa.ts for the feature, over real HTTP. Here
  // it is a double, because these tests are about what a *session* is — and no
  // account in this fixture has 2FA on, so it is never called.
  const mfa = { verifySecondFactor: vi.fn() } as any;

  // The real signer. A JWT test against a mocked signer tests nothing.
  const jwt = new JwtService();
  const service = new AuthService(jwt, config, revocations, events, mfa);

  /**
   * Login, asserting it produced a session rather than an MFA challenge.
   *
   * `login()` returns a union now — tokens, or "prove the second factor" — and a
   * caller that assumes the first is exactly the bug the union exists to catch.
   * The tests below are all about the token half, so they narrow here, once,
   * loudly: a fixture that quietly grew a second factor would fail with a
   * sentence rather than an undefined.
   */
  async function signIn(input: unknown) {
    const result = await service.login(input as any);
    if (isMfaChallenge(result)) {
      throw new Error("Expected a token pair, got an MFA challenge.");
    }
    return result;
  }

  return { service, signIn, jwt, revocations, events, mfa, db: state.db };
}

/**
 * Awaits a call that MUST reject, and hands back the error it rejected with.
 *
 * The tests below compare two failures to each other — that is how a user
 * enumeration oracle is caught — so they need the error object, not just the fact
 * that one was thrown. A `.catch(err => err)` would give it, but it types as
 * "error OR the successful result", and a resolved promise would then sail
 * silently into an assertion about `.message` that is comparing two undefineds
 * and passing.
 */
async function rejection(promise: Promise<unknown>): Promise<any> {
  const outcome = await promise.then(
    () => REJECTION_DID_NOT_HAPPEN,
    (err: unknown) => err,
  );
  if (outcome === REJECTION_DID_NOT_HAPPEN) {
    throw new Error("Expected this call to reject, and it resolved.");
  }
  return outcome;
}
const REJECTION_DID_NOT_HAPPEN = Symbol("resolved");

/** Re-encodes a JWT's payload while keeping the original signature. */
function tamper(token: string, mutate: (claims: any) => void): string {
  const [header, payload, signature] = token.split(".");
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
  mutate(claims);
  const forged = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${header}.${forged}.${signature}`;
}

/** An unsigned token that claims the signature algorithm is "none". */
function algNone(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString(
    "base64url",
  );
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${header}.${payload}.`;
}

describe("AuthService", () => {
  let ctx: ReturnType<typeof makeService>;

  beforeEach(() => {
    ctx = makeService();
  });

  describe("login", () => {
    it("issues an access token and a refresh token for the right password", async () => {
      const result = await ctx.signIn({
        email: "owner@example.test",
        password: PASSWORD,
      } as any);

      expect(result.user.email).toBe("owner@example.test");
      await expect(
        ctx.jwt.verifyAsync(result.accessToken, { secret: JWT_SECRET }),
      ).resolves.toMatchObject({ sub: "user-1", tid: "tenant-1" });
      await expect(
        ctx.jwt.verifyAsync(result.refreshToken, { secret: REFRESH_SECRET }),
      ).resolves.toMatchObject({ sub: "user-1" });
    });

    it("refuses a wrong password", async () => {
      // The whole product hangs off this line being true.
      await expect(
        ctx.signIn({
          email: "owner@example.test",
          password: "not the password",
        } as any),
      ).rejects.toThrow();
    });

    it("refuses a password that differs from the real one only in case", async () => {
      await expect(
        ctx.signIn({
          email: "owner@example.test",
          password: PASSWORD.toUpperCase(),
        } as any),
      ).rejects.toThrow();
    });

    it("accepts the email in a different case, since addresses are case-insensitive", async () => {
      const result = await ctx.signIn({
        email: "OWNER@Example.TEST",
        password: PASSWORD,
      } as any);

      expect(result.user.id).toBe("user-1");
    });

    it("gives an unknown email exactly the error a wrong password gets", async () => {
      // USER ENUMERATION. If a missing account said "no such user" and a bad
      // password said "wrong password", an attacker could sift a leaked address
      // list down to the addresses that hold accounts here — and then spend all
      // their guesses on those. The two paths must be indistinguishable.
      const wrongPassword = await rejection(
        ctx.signIn({ email: "owner@example.test", password: "wrong" } as any),
      );
      const noSuchUser = await rejection(
        ctx.signIn({ email: "nobody@example.test", password: "wrong" } as any),
      );

      expect((wrongPassword as any).getStatus()).toBe((noSuchUser as any).getStatus());
      expect(wrongPassword.message).toBe(noSuchUser.message);
    });

    it("still runs a password comparison for an email that has no account", async () => {
      // The timing half of the same oracle: returning early for an unknown email
      // would answer in a millisecond while a real account costs a bcrypt round,
      // and the difference is measurable over the network. The service hashes
      // against a dummy hash instead — so the comparison must actually happen.
      const compare = vi.spyOn(bcrypt, "compare");

      await expect(
        ctx.signIn({ email: "nobody@example.test", password: "wrong" } as any),
      ).rejects.toThrow();

      expect(compare).toHaveBeenCalledTimes(1);
      expect(compare.mock.calls[0][1]).toMatch(/^\$2[aby]\$/);
    });

    it("stores a refresh token only as a hash, never as the token itself", async () => {
      // The refresh token is a bearer credential. A dump of this table must not
      // hand the reader working sessions.
      const { refreshToken } = await ctx.signIn({
        email: "owner@example.test",
        password: PASSWORD,
      } as any);

      const [row] = ctx.db.tokens;
      expect(row.tokenHash).not.toContain(refreshToken);
      expect(row.tokenHash).toBe(sha256(refreshToken));
    });

    it("starts a new rotation family per login, so one logout cannot end them all", async () => {
      const first = await ctx.signIn({
        email: "owner@example.test",
        password: PASSWORD,
      } as any);
      const second = await ctx.signIn({
        email: "owner@example.test",
        password: PASSWORD,
      } as any);

      void first;
      void second;
      expect(ctx.db.tokens[0].familyId).not.toBe(ctx.db.tokens[1].familyId);
    });
  });

  describe("refresh", () => {
    async function loggedIn() {
      return ctx.signIn({
        email: "owner@example.test",
        password: PASSWORD,
      } as any);
    }

    it("exchanges a refresh token for a new pair", async () => {
      const { refreshToken } = await loggedIn();

      const rotated = await ctx.service.refresh(refreshToken);

      expect(rotated.refreshToken).not.toBe(refreshToken);
      await expect(
        ctx.jwt.verifyAsync(rotated.accessToken, { secret: JWT_SECRET }),
      ).resolves.toMatchObject({ sub: "user-1" });
    });

    it("consumes the refresh token it was given, so it cannot be used twice", async () => {
      const { refreshToken } = await loggedIn();

      await ctx.service.refresh(refreshToken);

      const used = ctx.db.tokens.find((row) => row.tokenHash === sha256(refreshToken))!;
      expect(used.consumedAt).toBeInstanceOf(Date);
    });

    it("keeps the rotated token in the same family, so revoking it reaches both", async () => {
      const { refreshToken } = await loggedIn();
      const familyBefore = ctx.db.tokens[0].familyId;

      await ctx.service.refresh(refreshToken);

      expect(ctx.db.tokens[1].familyId).toBe(familyBefore);
    });

    it("refuses a refresh token that has already been rotated", async () => {
      // REPLAY. The token is genuine and its signature is valid; it has simply
      // been spent. A refresh token accepted twice is a refresh token a thief can
      // ride forever alongside the real user.
      const { refreshToken } = await loggedIn();
      await ctx.service.refresh(refreshToken);

      await expect(ctx.service.refresh(refreshToken)).rejects.toThrow();
    });

    it("invalidates the whole token family when a used refresh token is replayed", async () => {
      // THEFT DETECTION, the reason rotation is worth the trouble. A stolen token
      // and the real one are indistinguishable — but only one of them can be used
      // first, and the loser's attempt to spend a consumed token is the tell. We
      // cannot know which side is the thief, so we end the session for both: the
      // user signs in again, the thief is left with nothing.
      const { refreshToken: stolen } = await loggedIn();
      const rotated = await ctx.service.refresh(stolen); // the real user rotates

      await expect(ctx.service.refresh(stolen)).rejects.toThrow(); // the thief replays

      // The descendant the legitimate client is holding is dead too.
      await expect(ctx.service.refresh(rotated.refreshToken)).rejects.toThrow();
      expect(ctx.db.tokens.every((row) => row.revokedAt !== null)).toBe(true);
    });

    it("deny-lists the family on a replay, killing access tokens already in flight", async () => {
      // Revoking the refresh rows alone would leave the thief's ACCESS token
      // working for the rest of its TTL — up to fifteen minutes of admin session
      // after we detected the theft.
      const { refreshToken } = await loggedIn();
      const familyId = ctx.db.tokens[0].familyId;
      await ctx.service.refresh(refreshToken);

      await expect(ctx.service.refresh(refreshToken)).rejects.toThrow();

      expect(ctx.revocations.revoke).toHaveBeenCalledWith(familyId);
    });

    it("raises a session_theft_detected event when a retired token is replayed", async () => {
      // The one auth event that means a credential has been stolen and is in use.
      // If it stops firing, the theft happens in silence.
      const { refreshToken } = await loggedIn();
      await ctx.service.refresh(refreshToken);

      await expect(
        ctx.service.refresh(refreshToken, { ip: "9.9.9.9", userAgent: "thief" }),
      ).rejects.toThrow();

      expect(ctx.events.record).toHaveBeenCalledWith(
        "auth.session_theft_detected",
        expect.objectContaining({ userId: "user-1", ip: "9.9.9.9" }),
      );
    });

    it("refuses a refresh token signed with a secret we do not use", async () => {
      // FORGERY. An attacker who knows the claim shape can mint whatever they
      // like; without the key it must be worthless.
      const forged = await new JwtService().signAsync(
        { sub: "user-1", tid: "tenant-1", fid: "any", email: "owner@example.test" },
        { secret: "the-attackers-own-secret", expiresIn: "30d" },
      );

      await expect(ctx.service.refresh(forged)).rejects.toThrow();
    });

    it("refuses a refresh token signed with the ACCESS secret", async () => {
      // KEY SEPARATION. Access tokens are handed to the browser on every request
      // and leak far more easily than refresh tokens. If the two shared a key, one
      // leaked access token could be replayed here to mint fresh sessions forever.
      const accessSigned = await new JwtService().signAsync(
        { sub: "user-1", tid: "tenant-1", fid: "any", email: "owner@example.test" },
        { secret: JWT_SECRET, expiresIn: "30d" },
      );

      await expect(ctx.service.refresh(accessSigned)).rejects.toThrow();
    });

    it("refuses an expired refresh token", async () => {
      const expired = await new JwtService().signAsync(
        { sub: "user-1", tid: "tenant-1", fid: "any", email: "owner@example.test" },
        { secret: REFRESH_SECRET, expiresIn: "-1s" },
      );

      await expect(ctx.service.refresh(expired)).rejects.toThrow();
    });

    it("refuses an alg:none token that carries no signature at all", async () => {
      // The classic JWT bypass: claim the token is unsigned and hope the library
      // takes the header's word for it.
      const unsigned = algNone({
        sub: "user-1",
        tid: "tenant-1",
        fid: "any",
        email: "owner@example.test",
        exp: Math.floor(Date.now() / 1000) + 3600,
      });

      await expect(ctx.service.refresh(unsigned)).rejects.toThrow();
    });

    it("refuses a genuine token whose payload was edited to name another user", async () => {
      // PRIVILEGE ESCALATION by payload swap: take your own valid token, point
      // `sub` at the owner, keep the signature. The signature covers the payload,
      // so it must no longer verify.
      const { refreshToken } = await loggedIn();
      const swapped = tamper(refreshToken, (claims) => {
        claims.sub = "user-victim";
        claims.tid = "tenant-victim";
      });

      await expect(ctx.service.refresh(swapped)).rejects.toThrow();
    });

    it("refuses a validly-signed token that was never issued by us", async () => {
      // Defence in depth: even holding the signing key, a token with no row in the
      // refresh table is not a session. (This is what makes logout stick.)
      const orphan = await new JwtService().signAsync(
        { sub: "user-1", tid: "tenant-1", fid: "ghost", email: "owner@example.test" },
        { secret: REFRESH_SECRET, expiresIn: "30d" },
      );

      await expect(ctx.service.refresh(orphan)).rejects.toThrow();
    });

    it("refuses a refresh token whose stored row has passed its expiry", async () => {
      const { refreshToken } = await loggedIn();
      ctx.db.tokens[0].expiresAt = new Date(Date.now() - 1000);

      await expect(ctx.service.refresh(refreshToken)).rejects.toThrow();
    });

    it("refuses a refresh token whose family was revoked by a logout elsewhere", async () => {
      const { refreshToken } = await loggedIn();
      await ctx.service.logout(refreshToken);

      await expect(ctx.service.refresh(refreshToken)).rejects.toThrow();
    });
  });

  describe("logout", () => {
    it("revokes every live token in the family", async () => {
      const { refreshToken } = await ctx.signIn({
        email: "owner@example.test",
        password: PASSWORD,
      } as any);

      await ctx.service.logout(refreshToken);

      expect(ctx.db.tokens[0].revokedAt).toBeInstanceOf(Date);
    });

    it("deny-lists the family, so the access token dies with the session", async () => {
      // Without this, "log out" means "stop being able to renew" while the current
      // access token keeps working — which is not what any user believes it means.
      const { refreshToken } = await ctx.signIn({
        email: "owner@example.test",
        password: PASSWORD,
      } as any);
      const familyId = ctx.db.tokens[0].familyId;

      await ctx.service.logout(refreshToken);

      expect(ctx.revocations.revoke).toHaveBeenCalledWith(familyId);
    });

    it("treats a garbage token as an already-completed logout rather than an error", async () => {
      await expect(ctx.service.logout("not.a.jwt")).resolves.toBeUndefined();
      expect(ctx.revocations.revoke).not.toHaveBeenCalled();
    });

    it("does nothing for a signed token that has no row", async () => {
      const orphan = await new JwtService().signAsync(
        { sub: "user-1", tid: "tenant-1", fid: "ghost", email: "owner@example.test" },
        { secret: REFRESH_SECRET, expiresIn: "30d" },
      );

      await expect(ctx.service.logout(orphan)).resolves.toBeUndefined();
      expect(ctx.revocations.revoke).not.toHaveBeenCalled();
    });
  });

  describe("changePassword", () => {
    it("refuses the change when the current password is wrong", async () => {
      // Someone who walked up to an unlocked laptop has the session but not the
      // password. Re-asking for it is what stops them locking the owner out.
      await expect(
        ctx.service.changePassword("user-1", "tenant-1", {
          currentPassword: "guess",
          newPassword: "a new long password",
        } as any),
      ).rejects.toThrow();

      expect(ctx.db.user.update).not.toHaveBeenCalled();
    });

    it("stores the new password as a bcrypt hash that verifies against it", async () => {
      // Real bcrypt: the stored value must not be the password, and must verify.
      await ctx.service.changePassword("user-1", "tenant-1", {
        currentPassword: PASSWORD,
        newPassword: "a new long password",
      } as any);

      const { passwordHash } = ctx.db.users[0];
      expect(passwordHash).not.toContain("a new long password");
      expect(passwordHash).toMatch(/^\$2[aby]\$/);
      await expect(bcrypt.compare("a new long password", passwordHash)).resolves.toBe(true);
      await expect(bcrypt.compare(PASSWORD, passwordHash)).resolves.toBe(false);
    });

    it("ends every session, including the intruder's, when the password changes", async () => {
      // The usual reason to change a password is that someone else has it. A change
      // that leaves their session alive has achieved nothing.
      await ctx.signIn({ email: "owner@example.test", password: PASSWORD } as any);
      const familyId = ctx.db.tokens[0].familyId;

      await ctx.service.changePassword("user-1", "tenant-1", {
        currentPassword: PASSWORD,
        newPassword: "a new long password",
      } as any);

      expect(ctx.db.tokens[0].revokedAt).toBeInstanceOf(Date);
      expect(ctx.revocations.revoke).toHaveBeenCalledWith(familyId);
    });

    it("refuses to change the password of a user in another tenant", async () => {
      // CROSS-TENANT. The user id alone must never be enough; the tenant from the
      // caller's own token has to match, or one tenant's admin could reset another
      // tenant's account.
      await expect(
        ctx.service.changePassword("user-1", "tenant-other", {
          currentPassword: PASSWORD,
          newPassword: "a new long password",
        } as any),
      ).rejects.toThrow();
    });
  });

  describe("revokeAllSessions", () => {
    it("revokes every live family the user holds", async () => {
      await ctx.signIn({ email: "owner@example.test", password: PASSWORD } as any);
      await ctx.signIn({ email: "owner@example.test", password: PASSWORD } as any);
      const families = ctx.db.tokens.map((row) => row.familyId);

      await ctx.service.revokeAllSessions("user-1");

      expect(ctx.db.tokens.every((row) => row.revokedAt !== null)).toBe(true);
      for (const familyId of families) {
        expect(ctx.revocations.revoke).toHaveBeenCalledWith(familyId);
      }
    });
  });

  describe("acceptInvite", () => {
    it("creates the account with a bcrypt hash and signs the invitee in", async () => {
      const result = await ctx.service.acceptInvite({
        token: "invite-token",
        name: "Invitee",
        password: "a perfectly fine password",
      } as any);

      expect(result.accessToken).toBeTruthy();
      const created = ctx.db.users.find((u) => u.email === "invitee@example.test")!;
      expect(created.passwordHash).toMatch(/^\$2[aby]\$/);
      await expect(
        bcrypt.compare("a perfectly fine password", created.passwordHash),
      ).resolves.toBe(true);
    });

    it("takes the role from the invitation row, not from the request body", async () => {
      // PRIVILEGE ESCALATION. The invitee is unauthenticated by definition, so the
      // body is entirely attacker-controlled. Everything that decides what access
      // the redemption produces — tenant, site, role — must come from the stored
      // invitation, never from what the invitee typed.
      await ctx.service.acceptInvite({
        token: "invite-token",
        name: "Invitee",
        password: "a perfectly fine password",
        role: "OWNER",
        tenantId: "tenant-victim",
        siteId: "site-victim",
      } as any);

      const membership = ctx.db.memberships.at(-1)!;
      expect(membership.role).toBe("AUTHOR");
      expect(membership.tenantId).toBe("tenant-1");
      expect(membership.siteId).toBe("site-1");
    });

    it("refuses an invitation token that does not exist", async () => {
      await expect(
        ctx.service.acceptInvite({
          token: "guessed-token",
          name: "Nobody",
          password: "a perfectly fine password",
        } as any),
      ).rejects.toThrow();
    });

    it("refuses an invitation that has already been redeemed", async () => {
      // Otherwise an invitation link forwarded, leaked, or found in an old inbox
      // mints a second account forever.
      ctx.db.invitations[0].acceptedAt = new Date();

      await expect(
        ctx.service.acceptInvite({
          token: "invite-token",
          name: "Nobody",
          password: "a perfectly fine password",
        } as any),
      ).rejects.toThrow();
    });

    it("refuses an expired invitation", async () => {
      ctx.db.invitations[0].expiresAt = new Date(Date.now() - 1000);

      await expect(
        ctx.service.acceptInvite({
          token: "invite-token",
          name: "Nobody",
          password: "a perfectly fine password",
        } as any),
      ).rejects.toThrow();
    });

    it("refuses a withdrawn invitation", async () => {
      ctx.db.invitations[0].revokedAt = new Date();

      await expect(
        ctx.service.acceptInvite({
          token: "invite-token",
          name: "Nobody",
          password: "a perfectly fine password",
        } as any),
      ).rejects.toThrow();
    });

    it("gives the same refusal for an unknown token as for an expired one", async () => {
      // Distinguishing them would let someone with a list of guesses learn which
      // invitation tokens were ever real.
      const unknown = await rejection(
        ctx.service.acceptInvite({
          token: "nope",
          name: "n",
          password: "a fine password",
        } as any),
      );

      ctx.db.invitations[0].expiresAt = new Date(Date.now() - 1000);
      const expired = await rejection(
        ctx.service.acceptInvite({
          token: "invite-token",
          name: "n",
          password: "a fine password",
        } as any),
      );

      expect(unknown.message).toBe(expired.message);
    });

    it("refuses to redeem an invitation for an address that already has an account", async () => {
      ctx.db.invitations[0].email = "owner@example.test";

      await expect(
        ctx.service.acceptInvite({
          token: "invite-token",
          name: "Nobody",
          password: "a perfectly fine password",
        } as any),
      ).rejects.toThrow();
    });
  });

  describe("sessionUser", () => {
    it("reports the highest role the user holds and the permissions it grants", async () => {
      const user = await ctx.service.sessionUser("user-1", "tenant-1");

      expect(user.role).toBe("OWNER");
      expect(user.permissions).toContain("user:manage");
      expect(user.tenantSlug).toBe("acme");
    });

    it("never returns the password hash", async () => {
      // It would otherwise ride out to the browser on every /auth/me.
      const user = await ctx.service.sessionUser("user-1", "tenant-1");

      expect(JSON.stringify(user)).not.toContain("$2");
      expect(user).not.toHaveProperty("passwordHash");
    });

    it("refuses to describe a user from another tenant", async () => {
      // The tenant id comes from the caller's token; a user id alone must not
      // resolve across tenant boundaries.
      await expect(ctx.service.sessionUser("user-1", "tenant-other")).rejects.toThrow();
    });
  });
});
