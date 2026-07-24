import { JwtService } from "@nestjs/jwt";
import type { ExecutionContext } from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthGuard } from "../auth.guard";
import {
  INTERNAL_KEY,
  PERMISSIONS_KEY,
  PUBLIC_KEY,
  SITE_SCOPED_KEY,
} from "../decorators";

/**
 * The one gate every non-public request passes through. It authenticates AND
 * authorises, so its tests are written the way an attacker would probe it: no
 * token, a forged token, a valid token for the wrong permission, a header
 * pointing at someone else's site.
 *
 * The JWT signing is real. Only Prisma and Redis (via RevocationService) are
 * mocked — a guard that trusts a mocked verifier proves nothing.
 */

const state = vi.hoisted(() => ({ db: null as any }));
vi.mock("@zcmsorg/database", () => ({ getSystemDb: () => state.db }));

const JWT_SECRET = "test-access-secret";
const INTERNAL_TOKEN = "the-shared-internal-token";
const VALID_UUID = "11111111-1111-4111-8111-111111111111";
const SITE_UUID = "22222222-2222-4222-8222-222222222222";

function fakeDb() {
  return {
    users: [
      {
        id: "user-1",
        tenantId: "tenant-1",
        email: "owner@example.test",
        tenant: { slug: "acme" },
      },
    ],
    memberships: [
      { id: "m1", userId: "user-1", tenantId: "tenant-1", siteId: null, role: "EDITOR" },
    ],
    sites: [{ id: SITE_UUID, tenantId: "tenant-1" }],
    user: {
      findFirst: vi.fn(async function (this: any, { where }: any) {
        return (
          state.db.users.find(
            (u: any) => u.id === where.id && u.tenantId === where.tenantId,
          ) ?? null
        );
      }),
    },
    membership: {
      findMany: vi.fn(async ({ where }: any) =>
        state.db.memberships.filter(
          (m: any) => m.userId === where.userId && m.tenantId === where.tenantId,
        ),
      ),
      findFirst: vi.fn(async ({ where }: any) =>
        state.db.memberships.find(
          (m: any) => m.userId === where.userId && m.tenantId === where.tenantId,
        ) ?? null,
      ),
    },
    site: {
      findFirst: vi.fn(async ({ where }: any) =>
        state.db.sites.find(
          (s: any) => s.id === where.id && s.tenantId === where.tenantId,
        ) ?? null,
      ),
    },
  };
}

function makeGuard(metadata: Record<string, unknown> = {}) {
  state.db = fakeDb();

  const reflector = {
    // getAllAndOverride is called once per metadata key; return the value for
    // whichever key is asked about.
    getAllAndOverride: vi.fn((key: string) => metadata[key]),
  } as any;

  const env: Record<string, string> = {
    JWT_SECRET,
    CMS_INTERNAL_TOKEN: INTERNAL_TOKEN,
  };
  const config = {
    get: (k: string) => env[k],
    getOrThrow: (k: string) => {
      if (!env[k]) throw new Error(`missing ${k}`);
      return env[k];
    },
  } as any;

  const revocations = { isRevoked: vi.fn(async () => false), revoke: vi.fn() } as any;
  const events = { record: vi.fn() } as any;
  const jwt = new JwtService();

  const guard = new AuthGuard(reflector, jwt, config, revocations, events);
  return { guard, jwt, revocations, events, db: state.db };
}

/** A fake ExecutionContext exposing just the request the guard reads. */
function contextFor(req: any): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => () => undefined,
    getClass: () => class {},
  } as any;
}

function requestWith(headers: Record<string, string> = {}, extra: Record<string, unknown> = {}) {
  return {
    headers,
    path: "/api/v1/things",
    method: "GET",
    ip: "1.2.3.4",
    socket: { remoteAddress: "1.2.3.4" },
    ...extra,
  };
}

async function accessTokenFor(
  claims: Record<string, unknown>,
  secret = JWT_SECRET,
): Promise<string> {
  return new JwtService().signAsync(claims, { secret, expiresIn: "15m" });
}

const BASE_CLAIMS = {
  sub: "user-1",
  tid: "tenant-1",
  email: "owner@example.test",
  fid: "family-1",
};

describe("AuthGuard", () => {
  describe("public routes", () => {
    it("lets a request with no token through when the route is @Public", async () => {
      const { guard } = makeGuard({ [PUBLIC_KEY]: true });

      await expect(
        guard.canActivate(contextFor(contextRequest())),
      ).resolves.toBe(true);
    });
  });

  describe("bearer token", () => {
    it("refuses a request with no Authorization header", async () => {
      // No credential, no entry. The most basic property, and the easiest to
      // regress when a refactor moves the check.
      const { guard } = makeGuard();

      await expect(guard.canActivate(contextFor(contextRequest()))).rejects.toThrow();
    });

    it("refuses an Authorization header that is not a Bearer scheme", async () => {
      const { guard } = makeGuard();
      const req = contextRequest({ authorization: "Basic dXNlcjpwYXNz" });

      await expect(guard.canActivate(contextFor(req))).rejects.toThrow();
    });

    it("refuses a Bearer header with an empty token", async () => {
      const { guard } = makeGuard();
      const req = contextRequest({ authorization: "Bearer   " });

      await expect(guard.canActivate(contextFor(req))).rejects.toThrow();
    });

    it("refuses a token signed with the wrong secret", async () => {
      // FORGERY. A token minted with the attacker's own key must not verify.
      const { guard } = makeGuard();
      const forged = await accessTokenFor(BASE_CLAIMS, "attacker-secret");
      const req = contextRequest({ authorization: `Bearer ${forged}` });

      await expect(guard.canActivate(contextFor(req))).rejects.toThrow();
    });

    it("refuses an expired token", async () => {
      const { guard } = makeGuard();
      const expired = await new JwtService().signAsync(BASE_CLAIMS, {
        secret: JWT_SECRET,
        expiresIn: "-1s",
      });
      const req = contextRequest({ authorization: `Bearer ${expired}` });

      await expect(guard.canActivate(contextFor(req))).rejects.toThrow();
    });

    it("refuses an alg:none token", async () => {
      // The unsigned-token bypass, at the request gate this time.
      const { guard } = makeGuard();
      const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString(
        "base64url",
      );
      const payload = Buffer.from(
        JSON.stringify({ ...BASE_CLAIMS, exp: Math.floor(Date.now() / 1000) + 3600 }),
      ).toString("base64url");
      const req = contextRequest({ authorization: `Bearer ${header}.${payload}.` });

      await expect(guard.canActivate(contextFor(req))).rejects.toThrow();
    });

    it("admits a valid token and populates the request with the resolved actor", async () => {
      const { guard } = makeGuard();
      const token = await accessTokenFor(BASE_CLAIMS);
      const req = contextRequest({ authorization: `Bearer ${token}` });

      await expect(guard.canActivate(contextFor(req))).resolves.toBe(true);
      expect((req as any).actor).toMatchObject({
        userId: "user-1",
        tenantId: "tenant-1",
        role: "EDITOR",
      });
    });

    it("resolves the actor's permissions from their role, not from the token", async () => {
      // The token carries only sub/tid/fid; permissions are derived server-side.
      // A token that tried to smuggle its own `permissions` array would be ignored.
      const { guard } = makeGuard();
      const token = await accessTokenFor({
        ...BASE_CLAIMS,
        permissions: ["user:manage", "site:delete"],
      });
      const req = contextRequest({ authorization: `Bearer ${token}` });

      await guard.canActivate(contextFor(req));

      expect((req as any).actor.permissions).not.toContain("user:manage");
      expect((req as any).actor.permissions).toContain("content:publish");
    });

    it("refuses a token whose user no longer exists", async () => {
      const { guard, db } = makeGuard();
      db.users.length = 0;
      const token = await accessTokenFor(BASE_CLAIMS);
      const req = contextRequest({ authorization: `Bearer ${token}` });

      await expect(guard.canActivate(contextFor(req))).rejects.toThrow();
    });
  });

  describe("revocation", () => {
    it("refuses a signature-valid token whose session was revoked", async () => {
      // The stolen-session case. The JWT is perfectly valid and unexpired; the
      // only thing wrong with it is that its family was deny-listed (logout, or a
      // theft response). A stateless token cannot know that, so the guard asks —
      // and if the answer is not honoured, revocation is a lie.
      const { guard, revocations } = makeGuard();
      revocations.isRevoked.mockResolvedValue(true);
      const token = await accessTokenFor(BASE_CLAIMS);
      const req = contextRequest({ authorization: `Bearer ${token}` });

      await expect(guard.canActivate(contextFor(req))).rejects.toThrow();
    });

    it("records a revoked_token_used event when a killed session is replayed", async () => {
      const { guard, revocations, events } = makeGuard();
      revocations.isRevoked.mockResolvedValue(true);
      const token = await accessTokenFor(BASE_CLAIMS);
      const req = contextRequest({ authorization: `Bearer ${token}` });

      await guard.canActivate(contextFor(req)).catch(() => undefined);

      expect(events.record).toHaveBeenCalledWith(
        "auth.revoked_token_used",
        expect.objectContaining({ userId: "user-1", familyId: "family-1" }),
      );
    });
  });

  describe("permissions", () => {
    it("refuses a user whose role lacks a required permission", async () => {
      // PRIVILEGE ESCALATION is the bug this prevents. An EDITOR asking for an
      // OWNER-only action must be turned away at the gate, before any service runs.
      const { guard } = makeGuard({ [PERMISSIONS_KEY]: ["user:manage"] });
      const token = await accessTokenFor(BASE_CLAIMS);
      const req = contextRequest({ authorization: `Bearer ${token}` });

      await expect(guard.canActivate(contextFor(req))).rejects.toThrow();
    });

    it("records a permission_denied event so a probing user leaves a trail", async () => {
      // A denied request never reaches a service, so this is the only place the
      // attempt can be recorded at all.
      const { guard, events } = makeGuard({ [PERMISSIONS_KEY]: ["user:manage"] });
      const token = await accessTokenFor(BASE_CLAIMS);
      const req = contextRequest({ authorization: `Bearer ${token}` });

      await guard.canActivate(contextFor(req)).catch(() => undefined);

      expect(events.record).toHaveBeenCalledWith(
        "auth.permission_denied",
        expect.objectContaining({ missing: ["user:manage"], role: "EDITOR" }),
      );
    });

    it("admits a user whose role grants every required permission", async () => {
      const { guard } = makeGuard({ [PERMISSIONS_KEY]: ["content:publish"] });
      const token = await accessTokenFor(BASE_CLAIMS);
      const req = contextRequest({ authorization: `Bearer ${token}` });

      await expect(guard.canActivate(contextFor(req))).resolves.toBe(true);
    });

    it("refuses a user with no membership at all in the tenant", async () => {
      const { guard, db } = makeGuard();
      db.memberships.length = 0;
      const token = await accessTokenFor(BASE_CLAIMS);
      const req = contextRequest({ authorization: `Bearer ${token}` });

      await expect(guard.canActivate(contextFor(req))).rejects.toThrow();
    });
  });

  describe("site scoping", () => {
    it("refuses a malformed X-Site-Id header before it reaches the database", async () => {
      // The header is attacker-controlled. A non-UUID must be rejected as a 403,
      // not passed to Prisma to surface as a 500.
      const { guard } = makeGuard();
      const token = await accessTokenFor(BASE_CLAIMS);
      const req = contextRequest({
        authorization: `Bearer ${token}`,
        "x-site-id": "'; drop table sites; --",
      });

      await expect(guard.canActivate(contextFor(req))).rejects.toThrow();
    });

    it("refuses a site-scoped route when no site is proven", async () => {
      const { guard } = makeGuard({ [SITE_SCOPED_KEY]: true });
      const token = await accessTokenFor(BASE_CLAIMS);
      const req = contextRequest({ authorization: `Bearer ${token}` });

      await expect(guard.canActivate(contextFor(req))).rejects.toThrow();
    });

    it("does not grant a site the user only claims via header but has no role on", async () => {
      // CROSS-SITE. The header names a real site in the same tenant, but the user
      // holds no membership there. Because the membership query returns nothing,
      // no role is attached for that site and the site-scoped gate refuses.
      const { guard, db } = makeGuard({ [SITE_SCOPED_KEY]: true });
      db.memberships.length = 0; // user has no role anywhere
      const token = await accessTokenFor(BASE_CLAIMS);
      const req = contextRequest({
        authorization: `Bearer ${token}`,
        "x-site-id": SITE_UUID,
      });

      await expect(guard.canActivate(contextFor(req))).rejects.toThrow();
    });

    it("does not resolve a site id that belongs to another tenant", async () => {
      // CROSS-TENANT. The site lookup is filtered by the token's tenant, so a
      // header pointing at another tenant's real site finds nothing and grants no
      // siteId — even though the id exists in the database.
      const { guard, db } = makeGuard({ [SITE_SCOPED_KEY]: true });
      db.sites[0].tenantId = "tenant-other";
      const token = await accessTokenFor(BASE_CLAIMS);
      const req = contextRequest({
        authorization: `Bearer ${token}`,
        "x-site-id": SITE_UUID,
      });

      await expect(guard.canActivate(contextFor(req))).rejects.toThrow();
    });

    it("attaches the site id when the user holds a tenant-wide role", async () => {
      const { guard } = makeGuard({ [SITE_SCOPED_KEY]: true });
      const token = await accessTokenFor(BASE_CLAIMS);
      const req = contextRequest({
        authorization: `Bearer ${token}`,
        "x-site-id": SITE_UUID,
      });

      await expect(guard.canActivate(contextFor(req))).resolves.toBe(true);
      expect((req as any).actor.siteId).toBe(SITE_UUID);
    });
  });

  describe("internal routes", () => {
    it("admits a request carrying the correct internal token", async () => {
      const { guard } = makeGuard({ [INTERNAL_KEY]: true });
      const req = contextRequest({ "x-internal-token": INTERNAL_TOKEN });

      await expect(guard.canActivate(contextFor(req))).resolves.toBe(true);
    });

    it("refuses a request whose internal token is wrong", async () => {
      const { guard } = makeGuard({ [INTERNAL_KEY]: true });
      const req = contextRequest({ "x-internal-token": "not-the-token" });

      await expect(guard.canActivate(contextFor(req))).rejects.toThrow();
    });

    it("refuses a request that is missing the internal token entirely", async () => {
      const { guard } = makeGuard({ [INTERNAL_KEY]: true });
      const req = contextRequest();

      await expect(guard.canActivate(contextFor(req))).rejects.toThrow();
    });

    it("refuses an internal token that is a prefix of the real one", async () => {
      // Length is checked before the constant-time compare, so a shorter guess
      // cannot slip through as a partial match.
      const { guard } = makeGuard({ [INTERNAL_KEY]: true });
      const req = contextRequest({
        "x-internal-token": INTERNAL_TOKEN.slice(0, -1),
      });

      await expect(guard.canActivate(contextFor(req))).rejects.toThrow();
    });
  });
});

/** A request whose headers merge over the base. */
function contextRequest(headers: Record<string, string> = {}) {
  return requestWith(headers);
}
