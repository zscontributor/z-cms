import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { createHash } from "node:crypto";
import type { RequestActor } from "../../common/request-context";

const holder = vi.hoisted(() => ({ db: null as any, systemDb: null as any }));
vi.mock("@zcmsorg/database", () => ({
  db: () => holder.db,
  getSystemDb: () => holder.systemDb,
}));

import { UsersService } from "../users.service";

function makeDb() {
  const database: any = {
    $transaction: vi.fn((fn: any) => fn(database)),
    user: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn().mockResolvedValue({}),
    },
    invitation: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
    },
    membership: {
      findMany: vi.fn().mockResolvedValue([{ siteId: null }]), // actor is tenant-wide
      count: vi.fn().mockResolvedValue(5),
      create: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
    },
    site: {
      findFirst: vi.fn().mockResolvedValue({ id: "s1" }),
      findUnique: vi.fn().mockResolvedValue({ id: "s1" }),
    },
    domain: {
      findFirst: vi.fn().mockResolvedValue({ hostname: "z-cms.org" }),
    },
  };
  return database;
}

const audit = { record: vi.fn().mockResolvedValue(undefined) };
const auth = { revokeAllSessions: vi.fn().mockResolvedValue(undefined) };
const mfa = { reset: vi.fn().mockResolvedValue(undefined) };
const mail = { enqueue: vi.fn().mockResolvedValue({ queued: true }) };

function makeService() {
  return new UsersService(audit as any, auth as any, mfa as any, mail as any);
}

function ownerActor(): RequestActor {
  return {
    userId: "owner",
    tenantId: "t1",
    email: "owner@x.com",
    role: "OWNER",
    permissions: ["user:invite", "user:manage"],
    siteId: "s1",
  };
}

function adminActor(): RequestActor {
  return { ...ownerActor(), userId: "admin", role: "ADMIN" };
}

/**
 * An administrator of one site and nothing else.
 *
 * `siteIds` is the whole difference: AuthGuard leaves it undefined for a
 * tenant-wide member (the two actors above) and fills it in for anyone whose
 * memberships are all per-site. Rule 5 reads exactly that field.
 */
function siteAdminActor(): RequestActor {
  return { ...ownerActor(), userId: "site-admin", role: "ADMIN", siteIds: ["s1"] };
}

describe("UsersService", () => {
  beforeEach(() => {
    holder.db = makeDb();
    holder.systemDb = {
      $transaction: vi.fn((fn: any) => fn(holder.db)),
      user: { findUnique: vi.fn().mockResolvedValue(null) },
    };
    audit.record.mockClear();
    auth.revokeAllSessions.mockClear();
    mail.enqueue.mockClear();
  });

  describe("create", () => {
    it("creates an immediately usable account and queues a notification email", async () => {
      holder.db.user.create.mockResolvedValue({ id: "u1" });
      holder.db.user.findUnique.mockResolvedValue({
        id: "u1",
        email: "new@x.com",
        name: "New User",
        avatarUrl: null,
        lastLoginAt: null,
        totpEnabledAt: null,
        createdAt: new Date(),
        memberships: [{ id: "m1", role: "EDITOR", siteId: "s1", site: { name: "Main" } }],
      });

      const res = await makeService().create(ownerActor(), {
        email: "New@x.com",
        name: "New User",
        password: "a perfectly fine password",
        role: "EDITOR",
        siteId: "s1",
      } as any);

      expect(holder.db.invitation.create).not.toHaveBeenCalled();
      expect(holder.db.user.create.mock.calls[0][0].data.email).toBe("new@x.com");
      expect(holder.db.membership.create.mock.calls[0][0].data).toMatchObject({
        userId: "u1",
        role: "EDITOR",
        siteId: "s1",
      });
      expect(res.password).toBe("a perfectly fine password");
      expect(res.emailQueued).toBe(true);
      expect(mail.enqueue).toHaveBeenCalledWith(
        "t1",
        "s1",
        null,
        expect.objectContaining({
          to: ["new@x.com"],
          text: expect.stringContaining("Temporary password: a perfectly fine password"),
        }),
      );
    });

    it("still returns credentials when mail cannot be queued", async () => {
      holder.db.user.create.mockResolvedValue({ id: "u1" });
      holder.db.user.findUnique.mockResolvedValue({
        id: "u1",
        email: "new@x.com",
        name: "New User",
        avatarUrl: null,
        lastLoginAt: null,
        totpEnabledAt: null,
        createdAt: new Date(),
        memberships: [{ id: "m1", role: "EDITOR", siteId: null, site: null }],
      });
      mail.enqueue.mockRejectedValueOnce(new Error("smtp not configured"));

      const res = await makeService().create(ownerActor(), {
        email: "new@x.com",
        name: "New User",
        role: "EDITOR",
        siteId: null,
      } as any);

      expect(res.password.length).toBeGreaterThanOrEqual(12);
      expect(res.emailQueued).toBe(false);
    });

    /**
     * The link the new user is handed — in the drawer and in the email — has to be
     * one that actually loads. admin-web mounts at basePath /admin in production,
     * so a bare `<origin>/login` is a 404, and `/admin` is routed on the tenant's
     * own hostname rather than on a separate admin host.
     */
    describe("the login URL it hands out", () => {
      beforeEach(() => {
        holder.db.user.create.mockResolvedValue({ id: "u1" });
        holder.db.user.findUnique.mockResolvedValue({
          id: "u1",
          email: "new@x.com",
          name: "New User",
          avatarUrl: null,
          lastLoginAt: null,
          totpEnabledAt: null,
          createdAt: new Date(),
          memberships: [{ id: "m1", role: "EDITOR", siteId: "s1", site: { name: "Main" } }],
        });
      });

      const input = { email: "new@x.com", name: "New User", role: "EDITOR", siteId: "s1" };

      it("uses the site's own hostname and the admin base path", async () => {
        vi.stubEnv("NODE_ENV", "production");
        vi.stubEnv("ADMIN_WEB_URL", "https://admin.z-cms.org");

        const res = await makeService().create(ownerActor(), input as any);

        expect(res.loginUrl).toBe("https://z-cms.org/admin/login");
        vi.unstubAllEnvs();
      });

      it("falls back to ADMIN_WEB_URL — with the base path — when the site has no domain", async () => {
        vi.stubEnv("NODE_ENV", "production");
        vi.stubEnv("ADMIN_WEB_URL", "https://admin.z-cms.org");
        holder.db.domain.findFirst.mockResolvedValue(null);

        const res = await makeService().create(ownerActor(), input as any);

        expect(res.loginUrl).toBe("https://admin.z-cms.org/admin/login");
        vi.unstubAllEnvs();
      });

      it("takes ADMIN_PUBLIC_URL exactly as written when one is set", async () => {
        vi.stubEnv("NODE_ENV", "production");
        vi.stubEnv("ADMIN_PUBLIC_URL", "https://studio.example.test/manage");

        const res = await makeService().create(ownerActor(), input as any);

        expect(res.loginUrl).toBe("https://studio.example.test/manage/login");
        vi.unstubAllEnvs();
      });

      it("stays on the admin's own port in development, where there is no base path", async () => {
        // The site hostname would point at site-runtime, not the admin, so the
        // hostname branch is skipped entirely when the base path is empty.
        vi.stubEnv("ADMIN_WEB_URL", "http://localhost:3101");

        const res = await makeService().create(ownerActor(), input as any);

        expect(res.loginUrl).toBe("http://localhost:3101/login");
        vi.unstubAllEnvs();
      });
    });
  });

  describe("invite", () => {
    it("refuses to grant a role above the caller's own", async () => {
      // Privilege escalation: an ADMIN who holds user:invite must not be able to
      // mint an OWNER and inherit the tenant by proxy.
      await expect(
        makeService().invite(adminActor(), { email: "x@x.com", role: "OWNER", siteId: "s1" } as any),
      ).rejects.toBeInstanceOf(ForbiddenException);

      expect(holder.db.invitation.create).not.toHaveBeenCalled();
    });

    it("refuses to invite onto a site the caller holds no role on", async () => {
      // The siteId is a field in a body the caller controls. Without standing on
      // that site, an admin could plant an accomplice on a site they cannot see.
      const actor = { ...adminActor(), role: "ADMIN" as const };
      holder.db.membership.findMany.mockResolvedValue([{ siteId: "some-other-site" }]);
      holder.db.site.findUnique.mockResolvedValue({ id: "s1" });

      await expect(
        makeService().invite(actor, { email: "x@x.com", role: "EDITOR", siteId: "s1" } as any),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("refuses to invite an email that already has an account", async () => {
      holder.systemDb.user.findUnique.mockResolvedValue({ id: "existing" });

      await expect(
        makeService().invite(ownerActor(), { email: "Taken@x.com", role: "EDITOR", siteId: "s1" } as any),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it("refuses a second live invitation to the same email", async () => {
      holder.db.invitation.findFirst.mockResolvedValue({ id: "pending" });

      await expect(
        makeService().invite(ownerActor(), { email: "x@x.com", role: "EDITOR", siteId: "s1" } as any),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it("stores only the hash of the token, and returns the raw token exactly once", async () => {
      // The raw token exists only in this response. If the row stored the raw
      // token, a database read would be a login to every pending invitation.
      holder.db.invitation.create.mockImplementation(({ data }: any) => ({
        id: "i1",
        email: data.email,
        role: data.role,
        siteId: data.siteId,
        site: { name: "Main" },
        invitedBy: { name: "Owner" },
        expiresAt: data.expiresAt,
        createdAt: new Date(),
        tokenHash: data.tokenHash,
      }));

      const res = await makeService().invite(ownerActor(), {
        email: "x@x.com",
        role: "EDITOR",
        siteId: "s1",
      } as any);

      const stored = holder.db.invitation.create.mock.calls[0][0].data.tokenHash;
      expect(stored).not.toBe(res.token);
      // It is specifically the SHA-256 of the returned token.
      expect(stored).toBe(createHash("sha256").update(res.token).digest("hex"));
    });

    it("sets an expiry in the future so an invitation is not valid forever", async () => {
      holder.db.invitation.create.mockImplementation(({ data }: any) => ({
        id: "i1",
        email: data.email,
        role: data.role,
        siteId: data.siteId,
        site: null,
        invitedBy: null,
        expiresAt: data.expiresAt,
        createdAt: new Date(),
      }));

      await makeService().invite(ownerActor(), { email: "x@x.com", role: "EDITOR", siteId: "s1" } as any);

      const expiresAt = holder.db.invitation.create.mock.calls[0][0].data.expiresAt as Date;
      expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
    });
  });

  describe("listPendingInvitations", () => {
    it("lists only invitations that are unanswered, unrevoked and unexpired", async () => {
      // A spent or expired token must not appear as outstanding work — and, more
      // to the point, must not look reusable.
      await makeService().listPendingInvitations(ownerActor());

      const where = holder.db.invitation.findMany.mock.calls[0][0].where;
      expect(where.acceptedAt).toBeNull();
      expect(where.revokedAt).toBeNull();
      expect(where.expiresAt).toEqual({ gt: expect.any(Date) });
    });

    it("does not narrow by site for a tenant-wide caller", async () => {
      await makeService().listPendingInvitations(ownerActor());

      expect(holder.db.invitation.findMany.mock.calls[0][0].where.OR).toBeUndefined();
    });

    it("hides invitations onto sites the caller has no role on", async () => {
      // The email address in an invitation to another site is not the caller's
      // business, and neither is the fact that the site is hiring.
      await makeService().listPendingInvitations(siteAdminActor());

      expect(holder.db.invitation.findMany.mock.calls[0][0].where.OR).toEqual([
        { siteId: null },
        { siteId: { in: ["s1"] } },
      ]);
    });
  });

  describe("rule 5 — you only see the people on your own sites", () => {
    const userRow = (memberships: any[]) => ({
      id: "u1",
      email: "u1@x.com",
      name: "U1",
      avatarUrl: null,
      lastLoginAt: null,
      totpEnabledAt: null,
      createdAt: new Date("2024-01-01T00:00:00.000Z"),
      memberships,
    });

    it("lists everyone for a tenant-wide caller", async () => {
      await makeService().list(ownerActor());

      expect(holder.db.user.findMany.mock.calls[0][0].where).toBeUndefined();
    });

    it("lists only users holding a role on the caller's sites", async () => {
      await makeService().list(siteAdminActor());

      // Tenant-wide members are in: their role applies to s1 too, so leaving
      // them out would misreport who can reach the caller's own site.
      expect(holder.db.user.findMany.mock.calls[0][0].where).toEqual({
        memberships: { some: { OR: [{ siteId: null }, { siteId: { in: ["s1"] } }] } },
      });
    });

    it("strips roles on other sites from the users it does return", async () => {
      // Otherwise the screen answers a question the caller may not ask — which
      // other sites this colleague works on — and answers it with site names.
      holder.db.user.findMany.mockResolvedValue([
        userRow([
          { id: "m1", role: "EDITOR", siteId: "s1", site: { name: "Shop" } },
          { id: "m2", role: "ADMIN", siteId: "s2", site: { name: "Magazine" } },
          { id: "m3", role: "OWNER", siteId: null, site: null },
        ]),
      ]);

      const [user] = await makeService().list(siteAdminActor());

      expect(user.memberships.map((m) => m.id)).toEqual(["m1", "m3"]);
      expect(JSON.stringify(user)).not.toContain("Magazine");
    });

    it("404s on a user whose roles are all on other sites", async () => {
      holder.db.user.findFirst.mockResolvedValue(null); // the where clause found nothing

      await expect(makeService().findOne(siteAdminActor(), "u1")).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it("refuses to act on a user from another site, with the same 404 a ghost gets", async () => {
      // A 403 here would confirm the account exists — enumeration by error code.
      holder.db.user.findUnique.mockResolvedValue({
        id: "u1",
        email: "u1@x.com",
        memberships: [{ id: "m2", role: "EDITOR", siteId: "s2" }],
      });

      await expect(makeService().remove(siteAdminActor(), "u1")).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(holder.db.user.delete).not.toHaveBeenCalled();
    });

    it("still lets a site admin act on someone who holds a role on their site", async () => {
      holder.db.user.findUnique.mockResolvedValue(
        userRow([{ id: "m1", role: "EDITOR", siteId: "s1", site: { name: "Shop" } }]),
      );
      // A site admin holds only s1, so assertMayActOnSite must see that, not the
      // tenant-wide default the other tests run with.
      holder.db.membership.findMany.mockResolvedValue([{ siteId: "s1" }]);

      await makeService().setMembership(siteAdminActor(), "u1", {
        role: "AUTHOR",
        siteId: "s1",
      } as any);

      expect(holder.db.membership.update).toHaveBeenCalled();
    });

    it("refuses to revoke a membership on a site the caller has no standing on", async () => {
      // The one membership-mutating route that used to skip assertMayActOnSite.
      holder.db.user.findUnique.mockResolvedValue(
        userRow([
          { id: "m1", role: "EDITOR", siteId: "s1", site: { name: "Shop" } },
          { id: "m2", role: "EDITOR", siteId: "s2", site: { name: "Magazine" } },
        ]),
      );
      holder.db.membership.findMany.mockResolvedValue([{ siteId: "s1" }]);

      await expect(
        makeService().removeMembership(siteAdminActor(), "u1", "m2"),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(holder.db.membership.delete).not.toHaveBeenCalled();
    });

    it("hides an invitation onto another site behind the not-found answer", async () => {
      holder.db.invitation.findUnique.mockResolvedValue({
        id: "i1",
        siteId: "s2",
        acceptedAt: null,
        revokedAt: null,
        email: "x@x.com",
        role: "EDITOR",
      });

      await expect(
        makeService().revokeInvitation(siteAdminActor(), "i1"),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(holder.db.invitation.update).not.toHaveBeenCalled();
    });
  });

  describe("revokeInvitation", () => {
    it("refuses to withdraw an invitation that was already accepted", async () => {
      holder.db.invitation.findUnique.mockResolvedValue({
        id: "i1",
        acceptedAt: new Date(),
        revokedAt: null,
        email: "x@x.com",
        role: "EDITOR",
      });

      await expect(
        makeService().revokeInvitation(ownerActor(), "i1"),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("marks a live invitation revoked rather than deleting it", async () => {
      // The token hash must survive so the redemption path recognises it as dead,
      // not as unknown.
      holder.db.invitation.findUnique.mockResolvedValue({
        id: "i1",
        acceptedAt: null,
        revokedAt: null,
        email: "x@x.com",
        role: "EDITOR",
      });

      await makeService().revokeInvitation(ownerActor(), "i1");

      expect(holder.db.invitation.update.mock.calls[0][0].data.revokedAt).toBeInstanceOf(Date);
    });
  });

  describe("setMembership", () => {
    it("refuses to let a caller change their own role", async () => {
      // The sideways escalation: promoting yourself. loadTarget refuses acting on self.
      await expect(
        makeService().setMembership(ownerActor(), "owner", { role: "OWNER", siteId: "s1" } as any),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("refuses to act on a user who outranks the caller", async () => {
      // An ADMIN must not be able to touch an OWNER, even one with no membership on
      // the admin's own site — the target's strongest role anywhere is what counts.
      holder.db.user.findUnique.mockResolvedValue({
        id: "target",
        email: "t@x.com",
        memberships: [{ id: "m1", role: "OWNER", siteId: null }],
      });

      await expect(
        makeService().setMembership(adminActor(), "target", { role: "EDITOR", siteId: "s1" } as any),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("refuses to demote the last remaining owner", async () => {
      // A tenant with no owner is unrecoverable without psql.
      holder.db.user.findUnique.mockResolvedValue({
        id: "target",
        email: "t@x.com",
        memberships: [{ id: "m1", role: "OWNER", siteId: "s1" }],
      });
      holder.db.membership.count.mockResolvedValue(0); // no other owners

      await expect(
        makeService().setMembership(ownerActor(), "target", { role: "EDITOR", siteId: "s1" } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("revokes the target's sessions on a demotion", async () => {
      // Demoting someone in a hurry means they should not be in the building; their
      // open tabs should not outlive the demotion.
      holder.db.user.findUnique.mockResolvedValue({
        id: "target",
        email: "t@x.com",
        name: "Target",
        avatarUrl: null,
        lastLoginAt: null,
        createdAt: new Date("2024-01-01T00:00:00.000Z"),
        memberships: [{ id: "m1", role: "ADMIN", siteId: "s1" }],
      });
      holder.db.membership.count.mockResolvedValue(5);

      await makeService().setMembership(ownerActor(), "target", { role: "VIEWER", siteId: "s1" } as any);

      expect(auth.revokeAllSessions).toHaveBeenCalledWith("target");
    });
  });

  describe("remove", () => {
    it("refuses to remove the last owner", async () => {
      holder.db.user.findUnique.mockResolvedValue({
        id: "target",
        email: "t@x.com",
        memberships: [{ id: "m1", role: "OWNER", siteId: null }],
      });
      holder.db.membership.count.mockResolvedValue(0);

      await expect(makeService().remove(ownerActor(), "target")).rejects.toBeInstanceOf(
        BadRequestException,
      );

      expect(holder.db.user.delete).not.toHaveBeenCalled();
    });

    it("revokes sessions before deleting the account", async () => {
      // An access token already in flight is a stateless JWT; without the deny-list
      // entry it keeps opening doors for an account that no longer exists.
      holder.db.user.findUnique.mockResolvedValue({
        id: "target",
        email: "t@x.com",
        memberships: [{ id: "m1", role: "EDITOR", siteId: "s1" }],
      });

      await makeService().remove(ownerActor(), "target");

      expect(auth.revokeAllSessions).toHaveBeenCalledWith("target");
      expect(holder.db.user.delete).toHaveBeenCalledWith({ where: { id: "target" } });
    });

    it("refuses to act on a nonexistent user", async () => {
      holder.db.user.findUnique.mockResolvedValue(null);

      await expect(makeService().remove(ownerActor(), "ghost")).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});
