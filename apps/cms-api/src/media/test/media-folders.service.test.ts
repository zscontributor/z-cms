import { beforeEach, describe, expect, it, vi } from "vitest";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import type { RequestActor } from "../../common/request-context";

const holder = vi.hoisted(() => ({ db: null as any }));
vi.mock("@zcmsorg/database", () => ({
  db: () => holder.db,
}));

import { MediaFoldersService } from "../media-folders.service";

const COUNT_ROW = { _count: { media: 0, children: 0 } };

function folder(over: Record<string, unknown> = {}) {
  return {
    id: "f1",
    name: "Photos",
    parentId: null,
    siteId: "s1",
    createdAt: new Date("2024-01-01T00:00:00.000Z"),
    ...COUNT_ROW,
    ...over,
  };
}

function makeDb() {
  return {
    mediaFolder: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue(folder()),
      update: vi.fn().mockResolvedValue(folder()),
      delete: vi.fn().mockResolvedValue({}),
    },
    media: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
  };
}

const audit = { record: vi.fn().mockResolvedValue(undefined) };

function makeService() {
  return new MediaFoldersService(audit as any);
}

const actor: RequestActor = {
  userId: "u1",
  tenantId: "t1",
  email: "a@x.com",
  role: "EDITOR",
  permissions: ["media:update"],
  siteId: "s1",
};

describe("MediaFoldersService", () => {
  beforeEach(() => {
    holder.db = makeDb();
    audit.record.mockClear();
  });

  describe("list", () => {
    it("scopes the folder list to the site", async () => {
      await makeService().list("s1");

      expect(holder.db.mediaFolder.findMany.mock.calls[0][0].where.siteId).toBe("s1");
    });
  });

  describe("create", () => {
    it("rejects a parent folder that belongs to another site", async () => {
      // The parentId is client-supplied; mustFind scopes by siteId so a foreign
      // parent reads as "not found" rather than nesting under another tenant.
      holder.db.mediaFolder.findFirst.mockResolvedValue(null);

      await expect(
        makeService().create(actor, "s1", { name: "New", parentId: "foreign-parent" } as any),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("rejects a duplicate name among siblings", async () => {
      // First findFirst (assertNameFree) finds a clash.
      holder.db.mediaFolder.findFirst.mockResolvedValue(folder({ id: "existing" }));

      await expect(
        makeService().create(actor, "s1", { name: "Photos", parentId: null } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("refuses to nest a folder past the maximum depth", async () => {
      // A breadcrumb that wraps three lines has stopped telling anyone where they
      // are; the tree is capped. Parent p4 already sits at depth 4 (the limit).
      holder.db.mediaFolder.findFirst.mockResolvedValue(folder({ id: "p4", parentId: "p3" }));
      holder.db.mediaFolder.findMany.mockResolvedValue([
        { id: "p0", parentId: null },
        { id: "p1", parentId: "p0" },
        { id: "p2", parentId: "p1" },
        { id: "p3", parentId: "p2" },
        { id: "p4", parentId: "p3" },
      ]);

      await expect(
        makeService().create(actor, "s1", { name: "Deep", parentId: "p4" } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("creates a root folder stamped with the tenant and site", async () => {
      holder.db.mediaFolder.findFirst.mockResolvedValue(null); // no name clash

      await makeService().create(actor, "s1", { name: "New", parentId: null } as any);

      const data = holder.db.mediaFolder.create.mock.calls[0][0].data;
      expect(data.tenantId).toBe("t1");
      expect(data.siteId).toBe("s1");
      expect(data.parentId).toBeNull();
    });
  });

  describe("update", () => {
    it("does not act on a folder belonging to another site", async () => {
      holder.db.mediaFolder.findFirst.mockResolvedValue(null);

      await expect(
        makeService().update(actor, "s1", "foreign-folder", { name: "x" } as any),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("refuses to make a folder its own parent", async () => {
      // A self-parent is a one-node cycle: the folder would detach from the tree
      // and vanish from the library.
      holder.db.mediaFolder.findFirst.mockResolvedValue(folder({ id: "f1", parentId: null }));

      await expect(
        makeService().update(actor, "s1", "f1", { parentId: "f1" } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("refuses to re-parent a folder into its own subtree", async () => {
      // Re-parenting A under its descendant B would orphan the whole A..B subtree
      // from the root — a valid set of rows nobody can ever reach again.
      const target = folder({ id: "A", parentId: null });
      // mustFind(id=A) -> target; mustFind(parentId=B) -> B exists.
      holder.db.mediaFolder.findFirst
        .mockResolvedValueOnce(target) // mustFind A
        .mockResolvedValueOnce(folder({ id: "B", parentId: "A" })); // mustFind B (new parent)
      // edges(): A is root, B is child of A -> B is a descendant of A.
      holder.db.mediaFolder.findMany.mockResolvedValue([
        { id: "A", parentId: null },
        { id: "B", parentId: "A" },
      ]);

      await expect(
        makeService().update(actor, "s1", "A", { parentId: "B" } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe("remove", () => {
    it("does not delete a folder belonging to another site", async () => {
      holder.db.mediaFolder.findFirst.mockResolvedValue(null);

      await expect(
        makeService().remove(actor, "s1", "foreign-folder"),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(holder.db.mediaFolder.delete).not.toHaveBeenCalled();
    });

    it("re-files the folder's files up to its parent before deleting it", async () => {
      // Deleting a folder is a filing decision, never a decision to destroy assets:
      // the files move to the parent so live pages keep their images.
      holder.db.mediaFolder.findFirst.mockResolvedValue(folder({ id: "f1", parentId: "p1" }));
      holder.db.mediaFolder.findMany.mockResolvedValue([{ id: "f1", parentId: "p1" }]);
      holder.db.media.updateMany.mockResolvedValue({ count: 3 });

      const res = await makeService().remove(actor, "s1", "f1");

      expect(res.movedFiles).toBe(3);
      const moveArgs = holder.db.media.updateMany.mock.calls[0][0];
      expect(moveArgs.where.siteId).toBe("s1");
      expect(moveArgs.data.folderId).toBe("p1");
      expect(holder.db.mediaFolder.delete).toHaveBeenCalledWith({ where: { id: "f1" } });
    });
  });
});
