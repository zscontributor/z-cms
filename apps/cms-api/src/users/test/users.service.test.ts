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
      await makeService().listPendingInvitations();

      const where = holder.db.invitation.findMany.mock.calls[0][0].where;
      expect(where.acceptedAt).toBeNull();
      expect(where.revokedAt).toBeNull();
      expect(where.expiresAt).toEqual({ gt: expect.any(Date) });
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
