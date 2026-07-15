import { beforeEach, describe, expect, it, vi } from "vitest";
import { ContentsController } from "../contents.controller";
import type { RequestActor } from "../../common/request-context";

/**
 * The controller's own job is small but load-bearing: it turns untrusted query
 * strings into bounded numbers before they reach a database offset. An unclamped
 * perPage is a cheap way to ask the server to page a million rows into memory.
 */

const service = {
  list: vi.fn().mockResolvedValue({ items: [], page: 1, perPage: 20, total: 0, totalPages: 1 }),
  findOne: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  setPublished: vi.fn(),
  remove: vi.fn().mockResolvedValue(undefined),
};

function makeController() {
  return new ContentsController(service as any);
}

const actor: RequestActor = {
  userId: "u1",
  tenantId: "t1",
  email: "a@x.com",
  role: "EDITOR",
  permissions: [],
  siteId: "s1",
};

describe("ContentsController", () => {
  beforeEach(() => {
    service.list.mockClear();
    service.setPublished.mockClear();
  });

  describe("list", () => {
    it("clamps an absurdly large perPage down to 100", async () => {
      await makeController().list("s1", undefined, undefined, undefined, undefined, "1", "100000");

      expect(service.list.mock.calls[0][1].perPage).toBe(100);
    });

    it("refuses a negative page, flooring it to 1", async () => {
      await makeController().list("s1", undefined, undefined, undefined, undefined, "-5", "20");

      expect(service.list.mock.calls[0][1].page).toBe(1);
    });

    it("falls back to defaults for non-numeric pagination", async () => {
      await makeController().list("s1", undefined, undefined, undefined, undefined, "abc", "xyz");

      const query = service.list.mock.calls[0][1];
      expect(query.page).toBe(1);
      expect(query.perPage).toBe(20);
    });

    it("passes the site id straight through to the service", async () => {
      await makeController().list("s1", "post", "PUBLISHED", "vi", "hello", "2", "10");

      expect(service.list).toHaveBeenCalledWith("s1", {
        contentTypeKey: "post",
        status: "PUBLISHED",
        locale: "vi",
        search: "hello",
        page: 2,
        perPage: 10,
      });
    });
  });

  describe("publish / unpublish", () => {
    it("publishes by asking the service to set published true", async () => {
      await makeController().publish(actor, "s1", "c1");

      expect(service.setPublished).toHaveBeenCalledWith(actor, "s1", "c1", true);
    });

    it("unpublishes by asking the service to set published false", async () => {
      await makeController().unpublish(actor, "s1", "c1");

      expect(service.setPublished).toHaveBeenCalledWith(actor, "s1", "c1", false);
    });
  });
});
