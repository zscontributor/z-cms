import { beforeEach, describe, expect, it, vi } from "vitest";
import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import type { RequestActor } from "../../common/request-context";

// The tenant-scoped Prisma client is the boundary every query in this service
// must respect. We replace it with a mock so we can watch exactly which filters
// each query carries — a missing siteId here is a cross-tenant read in production.
const holder = vi.hoisted(() => ({ db: null as any }));
vi.mock("@zcmsorg/database", () => ({
  db: () => holder.db,
}));

import { ContentsService } from "../contents.service";

const CONTENT_TYPE_ROW = {
  id: "ct1",
  key: "post",
  name: "Post",
  routePrefix: "blog",
  fields: [],
  isSingleton: false,
};

function contentRow(over: Record<string, unknown> = {}) {
  return {
    id: "c1",
    siteId: "s1",
    locale: "en",
    translationGroupId: "g1",
    title: "Hello",
    slug: "hello",
    excerpt: null,
    data: {},
    blocks: [],
    seo: {},
    status: "DRAFT",
    publishedAt: null,
    authorId: "u1",
    contentTypeId: "ct1",
    demoThemeKey: null,
    createdAt: new Date("2024-01-01T00:00:00.000Z"),
    updatedAt: new Date("2024-01-02T00:00:00.000Z"),
    contentType: CONTENT_TYPE_ROW,
    author: { id: "u1", name: "Ann" },
    ...over,
  };
}

function makeDb() {
  return {
    content: {
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
      findFirst: vi.fn().mockResolvedValue(null),
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn().mockResolvedValue({}),
    },
    contentType: { findFirst: vi.fn().mockResolvedValue(CONTENT_TYPE_ROW) },
    site: { findFirst: vi.fn().mockResolvedValue({ defaultLocale: "en", locales: ["en"] }) },
    siteTheme: { findFirst: vi.fn().mockResolvedValue(null) },
    contentVersion: {
      findFirst: vi.fn().mockResolvedValue({ version: 2 }),
      create: vi.fn().mockResolvedValue({}),
    },
  };
}

const cache = {
  invalidateSitePaths: vi.fn().mockResolvedValue(undefined),
  invalidateSite: vi.fn().mockResolvedValue(undefined),
};
const plugins = { dispatchAction: vi.fn().mockResolvedValue(undefined) };
const audit = { record: vi.fn().mockResolvedValue(undefined) };
const queue = { enqueue: vi.fn().mockResolvedValue(undefined) };

function makeService() {
  return new ContentsService(cache as any, plugins as any, audit as any, queue as any);
}

const author: RequestActor = {
  userId: "u1",
  tenantId: "t1",
  email: "a@x.com",
  role: "AUTHOR",
  permissions: ["content:create", "content:update"],
  siteId: "s1",
};

const editor: RequestActor = {
  userId: "u2",
  tenantId: "t1",
  email: "e@x.com",
  role: "EDITOR",
  permissions: ["content:create", "content:update", "content:publish"],
  siteId: "s1",
};

describe("ContentsService", () => {
  beforeEach(() => {
    holder.db = makeDb();
    cache.invalidateSitePaths.mockClear();
    cache.invalidateSite.mockClear();
    plugins.dispatchAction.mockClear();
    audit.record.mockClear();
    queue.enqueue.mockClear();
  });

  describe("list", () => {
    it("scopes the query to the requested site", async () => {
      await makeService().list("s1", { page: 1, perPage: 20 });

      const where = holder.db.content.findMany.mock.calls[0][0].where;
      expect(where.siteId).toBe("s1");
    });

    it("computes the offset from page and perPage", async () => {
      await makeService().list("s1", { page: 3, perPage: 10 });

      const args = holder.db.content.findMany.mock.calls[0][0];
      expect(args.skip).toBe(20);
      expect(args.take).toBe(10);
    });

    it("reports at least one total page even for an empty site", async () => {
      holder.db.content.count.mockResolvedValue(0);

      const res = await makeService().list("s1", { page: 1, perPage: 20 });

      expect(res.totalPages).toBe(1);
    });
  });

  describe("findOne", () => {
    it("scopes the lookup to the site so another site's entry is invisible", async () => {
      // Attacker: read a content id that lives under a different site. The query
      // carries siteId, so Prisma returns nothing and the caller gets a 404 — not
      // the row.
      holder.db.content.findFirst.mockResolvedValue(null);

      await expect(makeService().findOne("s1", "other-sites-content")).rejects.toBeInstanceOf(
        NotFoundException,
      );

      const where = holder.db.content.findFirst.mock.calls[0][0].where;
      expect(where.siteId).toBe("s1");
      expect(where.id).toBe("other-sites-content");
    });

    it("returns the entry when it belongs to the site", async () => {
      holder.db.content.findFirst.mockResolvedValue(contentRow());

      await expect(makeService().findOne("s1", "c1")).resolves.toMatchObject({ id: "c1" });
    });
  });

  describe("create", () => {
    it("rejects a content type that does not belong to the site", async () => {
      // The contentTypeId is a client-supplied field; without the site filter a
      // caller could attach content to another site's type.
      holder.db.contentType.findFirst.mockResolvedValue(null);

      await expect(
        makeService().create(author, "s1", {
          contentTypeId: "ct-elsewhere",
          title: "x",
          slug: "x",
          data: {},
        } as any),
      ).rejects.toBeInstanceOf(BadRequestException);

      const where = holder.db.contentType.findFirst.mock.calls[0][0].where;
      expect(where.siteId).toBe("s1");
    });

    it("refuses to publish for an author who lacks the publish permission", async () => {
      // Privilege boundary: an AUTHOR may write a draft but must never push it live.
      await expect(
        makeService().create(author, "s1", {
          contentTypeId: "ct1",
          title: "x",
          slug: "x",
          status: "PUBLISHED",
          data: {},
        } as any),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("stamps the row with the actor's tenant and site", async () => {
      holder.db.content.create.mockResolvedValue(contentRow());
      holder.db.content.findUnique.mockResolvedValue(contentRow());

      await makeService().create(author, "s1", {
        contentTypeId: "ct1",
        title: "Hello",
        slug: "hello",
        data: {},
      } as any);

      const data = holder.db.content.create.mock.calls[0][0].data;
      expect(data.tenantId).toBe("t1");
      expect(data.siteId).toBe("s1");
      expect(data.authorId).toBe("u1");
    });

    it("does not cold-start the whole site for a draft nobody can see", async () => {
      // The site-wide purge exists for lists, and a list only ever holds PUBLISHED
      // rows — so a draft cannot have changed one. Bumping the version anyway would
      // make every keystroke of an autosaving editor evict the site's cache.
      holder.db.content.create.mockResolvedValue(contentRow({ status: "DRAFT" }));
      holder.db.content.findUnique.mockResolvedValue(contentRow({ status: "DRAFT" }));

      await makeService().create(author, "s1", {
        contentTypeId: "ct1",
        title: "Hello",
        slug: "hello",
        data: {},
      } as any);

      expect(cache.invalidateSite).not.toHaveBeenCalled();
    });

    it("refuses a second singleton in the same locale", async () => {
      holder.db.contentType.findFirst.mockResolvedValue({ ...CONTENT_TYPE_ROW, isSingleton: true });
      holder.db.content.count.mockResolvedValue(1);

      await expect(
        makeService().create(editor, "s1", {
          contentTypeId: "ct1",
          title: "Home",
          slug: "",
          data: {},
        } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("records a first version snapshot of a newly created entry", async () => {
      // Versioning is the 3am undo. A create that leaves no version is a create
      // that cannot be rolled back.
      holder.db.content.create.mockResolvedValue(contentRow());
      holder.db.content.findUnique.mockResolvedValue(contentRow());
      holder.db.contentVersion.findFirst.mockResolvedValue(null);

      await makeService().create(author, "s1", {
        contentTypeId: "ct1",
        title: "Hello",
        slug: "hello",
        data: {},
      } as any);

      expect(holder.db.contentVersion.create).toHaveBeenCalledTimes(1);
      expect(holder.db.contentVersion.create.mock.calls[0][0].data.version).toBe(1);
    });
  });

  /**
   * Rich text reaches a theme's `dangerouslySetInnerHTML`, so what gets STORED must
   * already be safe. These assert on the blocks the service actually hands Prisma —
   * the last point at which we still control them.
   */
  describe("rich-text sanitising", () => {
    function blocksWrittenOnCreate() {
      return holder.db.content.create.mock.calls[0][0].data.blocks;
    }

    async function createWith(blocks: unknown) {
      holder.db.content.create.mockResolvedValue(contentRow());
      await makeService().create(author, "s1", {
        contentTypeId: "ct1",
        title: "x",
        slug: "x",
        data: {},
        blocks,
      } as any);
      return blocksWrittenOnCreate();
    }

    it("strips a <script> from props.html on create", async () => {
      const written = await createWith([
        {
          id: "b1",
          type: "core/richtext",
          props: { html: "<p>hi</p><script>alert(1)</script>" },
        },
      ]);

      expect(written[0].props.html).toBe("<p>hi</p>");
    });

    it("strips event handlers and drops iframes on create", async () => {
      const written = await createWith([
        {
          id: "b1",
          type: "core/richtext",
          props: { html: '<img src="/x.png" onerror="alert(1)"><iframe></iframe>' },
        },
      ]);

      expect(written[0].props.html).not.toContain("onerror");
      expect(written[0].props.html).not.toContain("iframe");
    });

    it("sanitises nested children on create", async () => {
      const written = await createWith([
        {
          id: "b1",
          type: "core/section",
          props: {},
          children: [
            {
              id: "b2",
              type: "core/richtext",
              props: { html: "<p>deep</p><script>alert(1)</script>" },
            },
          ],
        },
      ]);

      expect(written[0].children[0].props.html).toBe("<p>deep</p>");
    });

    it("leaves ordinary formatting alone on create", async () => {
      const html = '<h2>Title</h2><p><strong>Hi</strong> <a href="/about">about</a></p>';
      const written = await createWith([
        { id: "b1", type: "core/richtext", props: { html } },
      ]);

      expect(written[0].props.html).toBe(html);
    });

    it("does not touch a text prop that is not named html", async () => {
      const written = await createWith([
        { id: "b1", type: "core/hero", props: { heading: "a < b > c" } },
      ]);

      expect(written[0].props.heading).toBe("a < b > c");
    });

    it("strips a <script> from props.html on update", async () => {
      // An edit is a write. A page that was clean on create must not go dirty on save.
      holder.db.content.findFirst.mockResolvedValue(contentRow());
      holder.db.content.update.mockResolvedValue(contentRow());

      await makeService().update(author, "s1", "c1", {
        blocks: [
          {
            id: "b1",
            type: "core/richtext",
            props: { html: "<p>hi</p><script>alert(1)</script>" },
          },
        ],
      } as any);

      const written = holder.db.content.update.mock.calls[0][0].data.blocks;
      expect(written[0].props.html).toBe("<p>hi</p>");
    });
  });

  describe("update", () => {
    it("does not find an entry belonging to another site", async () => {
      // Attacker: PATCH a content id from a different site. The scoped lookup
      // returns nothing, so the update never happens.
      holder.db.content.findFirst.mockResolvedValue(null);

      await expect(
        makeService().update(editor, "s1", "other-sites-content", { title: "hijack" } as any),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(holder.db.content.update).not.toHaveBeenCalled();
      const where = holder.db.content.findFirst.mock.calls[0][0].where;
      expect(where.siteId).toBe("s1");
    });

    it("forbids an author from editing an entry they do not own", async () => {
      // An AUTHOR holds content:update but only over their own rows; the ownership
      // rule cannot be expressed as a permission, so it lives in the service.
      holder.db.content.findFirst.mockResolvedValue(contentRow({ authorId: "someone-else" }));

      await expect(
        makeService().update(author, "s1", "c1", { title: "x" } as any),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("records a new version when an entry is updated", async () => {
      holder.db.content.findFirst.mockResolvedValue(contentRow());
      holder.db.content.update.mockResolvedValue(contentRow({ title: "New" }));
      holder.db.content.findUnique.mockResolvedValue(contentRow({ title: "New" }));
      holder.db.contentVersion.findFirst.mockResolvedValue({ version: 2 });

      await makeService().update(editor, "s1", "c1", { title: "New" } as any);

      expect(holder.db.contentVersion.create).toHaveBeenCalledTimes(1);
      expect(holder.db.contentVersion.create.mock.calls[0][0].data.version).toBe(3);
    });

    it("refuses to publish through update for a caller without the permission", async () => {
      holder.db.content.findFirst.mockResolvedValue(contentRow());

      await expect(
        makeService().update(author, "s1", "c1", { status: "PUBLISHED" } as any),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe("setPublished", () => {
    it("does not publish an entry that belongs to another site", async () => {
      holder.db.content.findFirst.mockResolvedValue(null);

      await expect(
        makeService().setPublished(editor, "s1", "other-sites-content", true),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(holder.db.content.update).not.toHaveBeenCalled();
    });

    it("refuses to publish without the content:publish permission", async () => {
      holder.db.content.findFirst.mockResolvedValue(contentRow());

      await expect(
        makeService().setPublished(author, "s1", "c1", true),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("sets the status to PUBLISHED and stamps publishedAt", async () => {
      holder.db.content.findFirst.mockResolvedValue(contentRow({ status: "DRAFT", publishedAt: null }));
      holder.db.content.update.mockResolvedValue(contentRow({ status: "PUBLISHED" }));
      holder.db.content.findUnique.mockResolvedValue(contentRow({ status: "PUBLISHED" }));

      await makeService().setPublished(editor, "s1", "c1", true);

      const data = holder.db.content.update.mock.calls[0][0].data;
      expect(data.status).toBe("PUBLISHED");
      expect(data.publishedAt).toBeInstanceOf(Date);
    });

    it("clears publishedAt when unpublishing", async () => {
      holder.db.content.findFirst.mockResolvedValue(contentRow({ status: "PUBLISHED" }));
      holder.db.content.update.mockResolvedValue(contentRow({ status: "DRAFT" }));
      holder.db.content.findUnique.mockResolvedValue(contentRow({ status: "DRAFT" }));

      await makeService().setPublished(editor, "s1", "c1", false);

      const data = holder.db.content.update.mock.calls[0][0].data;
      expect(data.status).toBe("DRAFT");
      expect(data.publishedAt).toBeNull();
    });

    it("purges the whole site's renders when a post is published, not just its own path", async () => {
      // A published post is not only a page — it is a row in every list of its type:
      // the front page's theme collection, a `core/content-list` block, the archive.
      // Those pages are cached under their own keys, and purging "/blog/hello" names
      // none of them. Without the site-wide bump the article goes live while the home
      // page keeps advertising the previous one until a TTL happens to lapse.
      holder.db.content.findFirst.mockResolvedValue(contentRow({ status: "DRAFT", publishedAt: null }));
      holder.db.content.update.mockResolvedValue(contentRow({ status: "PUBLISHED" }));
      holder.db.content.findUnique.mockResolvedValue(contentRow({ status: "PUBLISHED" }));

      await makeService().setPublished(editor, "s1", "c1", true);

      expect(cache.invalidateSite).toHaveBeenCalledWith("s1");
    });

    it("purges the whole site when a post is UNpublished, so lists drop it", async () => {
      holder.db.content.findFirst.mockResolvedValue(contentRow({ status: "PUBLISHED" }));
      holder.db.content.update.mockResolvedValue(contentRow({ status: "DRAFT" }));
      holder.db.content.findUnique.mockResolvedValue(contentRow({ status: "DRAFT" }));

      await makeService().setPublished(editor, "s1", "c1", false);

      expect(cache.invalidateSite).toHaveBeenCalledWith("s1");
    });
  });

  describe("remove", () => {
    it("does not delete an entry that belongs to another site", async () => {
      // Attacker: DELETE another site's content id. The scoped read finds nothing,
      // so delete is never issued.
      holder.db.content.findFirst.mockResolvedValue(null);

      await expect(
        makeService().remove(editor, "s1", "other-sites-content"),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(holder.db.content.delete).not.toHaveBeenCalled();
    });

    it("deletes an entry that belongs to the site and records it in the audit log", async () => {
      holder.db.content.findFirst.mockResolvedValue(contentRow());

      await makeService().remove(editor, "s1", "c1");

      expect(holder.db.content.delete).toHaveBeenCalledWith({ where: { id: "c1" } });
      expect(audit.record).toHaveBeenCalledWith(
        editor,
        "content.deleted",
        "content",
        "c1",
        expect.any(Object),
      );
    });
  });
});
