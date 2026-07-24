import { beforeEach, describe, expect, it, vi } from "vitest";
import { MediaController } from "../media.controller";
import type { RequestActor } from "../../common/request-context";

const media = {
  list: vi.fn().mockResolvedValue({ items: [], page: 1, perPage: 40, total: 0, totalPages: 1 }),
  upload: vi.fn().mockResolvedValue({}),
  update: vi.fn(),
  bulkMove: vi.fn(),
  bulkRemove: vi.fn(),
  remove: vi.fn().mockResolvedValue(undefined),
};
const folders = { list: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn() };

function makeController() {
  return new MediaController(media as any, folders as any);
}

const actor: RequestActor = {
  userId: "u1",
  tenantId: "t1",
  email: "a@x.com",
  role: "EDITOR",
  permissions: ["media:upload"],
  siteId: "s1",
};

describe("MediaController", () => {
  beforeEach(() => {
    media.list.mockClear();
    media.upload.mockClear();
  });

  describe("list", () => {
    it("clamps a huge perPage down to 100", async () => {
      await makeController().list("s1", undefined, undefined, undefined, "1", "999999");

      expect(media.list.mock.calls[0][1].perPage).toBe(100);
    });

    it("treats an unknown kind as no kind filter", async () => {
      await makeController().list("s1", undefined, "banana", undefined, "1", "40");

      expect(media.list.mock.calls[0][1].kind).toBeUndefined();
    });

    it("passes a known kind through", async () => {
      await makeController().list("s1", undefined, "image", undefined, "1", "40");

      expect(media.list.mock.calls[0][1].kind).toBe("image");
    });

    it("passes 'root' through as a folder scope distinct from omitting it", async () => {
      await makeController().list("s1", undefined, undefined, "root", "1", "40");

      expect(media.list.mock.calls[0][1].folder).toBe("root");
    });

    it("collapses a blank search to undefined so it does not filter", async () => {
      await makeController().list("s1", "   ", undefined, undefined, "1", "40");

      expect(media.list.mock.calls[0][1].search).toBeUndefined();
    });
  });

  describe("upload", () => {
    it("normalises a missing folderId to null rather than the empty string", async () => {
      // An empty-string folderId would be treated as a real (nonexistent) folder id
      // downstream; null is "the root".
      await makeController().upload(actor, "s1", {} as any, "");

      expect(media.upload).toHaveBeenCalledWith(actor, "s1", {}, null);
    });

    it("forwards a real folderId untouched", async () => {
      await makeController().upload(actor, "s1", {} as any, "folder-1");

      expect(media.upload).toHaveBeenCalledWith(actor, "s1", {}, "folder-1");
    });
  });
});
