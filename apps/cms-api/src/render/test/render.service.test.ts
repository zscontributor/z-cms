import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotFoundException } from "@nestjs/common";
import { COLLECTION_MAX_LIMIT, CONTENT_LIST_BLOCK } from "@zcmsorg/schemas";

const holder = vi.hoisted(() => ({ db: null as any, systemDb: null as any }));
vi.mock("@zcmsorg/database", () => ({
  db: () => holder.db,
  getSystemDb: () => holder.systemDb,
  withTenant: (_tid: string, fn: any) => fn({ db: holder.db }),
}));

import { RenderService } from "../render.service";

function publishedRow(over: Record<string, unknown> = {}) {
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
    status: "PUBLISHED",
    publishedAt: new Date("2024-01-02T00:00:00.000Z"),
    createdAt: new Date("2024-01-01T00:00:00.000Z"),
    updatedAt: new Date("2024-01-03T00:00:00.000Z"),
    demoThemeKey: null,
    // Internal columns that must never reach the public payload:
    tenantId: "t1",
    authorId: "u1",
    contentType: { id: "ct1", key: "post", name: "Post", routePrefix: "blog" },
    author: { id: "u1", name: "Ann" },
    ...over,
  };
}

function makeDb() {
  return {
    siteTheme: {
      findFirst: vi.fn().mockResolvedValue({
        theme: { key: "corp" },
        version: { version: "1.0.0", manifest: {} },
        settings: {},
      }),
    },
    menu: { findMany: vi.fn().mockResolvedValue([]) },
    contentType: { findFirst: vi.fn().mockResolvedValue(null) },
    content: { findMany: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0) },
  };
}

// Doubles as a cached ResolvedSite and as the `site` of a domain row from the DB.
// `canonicalHost` is only meaningful in the first role — resolveHost recomputes it
// from `domains` — but a cached entry without it is stale by shape and re-resolved,
// so the fixture has to carry it or every cache hit here becomes a miss.
const publishedSite = {
  id: "s1",
  tenantId: "t1",
  name: "Main",
  status: "PUBLISHED",
  canonicalHost: "example.com",
  defaultLocale: "en",
  locales: ["en"],
};

const cache = {
  get: vi.fn(),
  set: vi.fn().mockResolvedValue(undefined),
  siteVersion: vi.fn().mockResolvedValue(1),
};
const plugins = {
  renderContributionsFor: vi.fn().mockResolvedValue({ capabilities: [], integrations: {} }),
  applyFilter: vi.fn().mockImplementation((_t, _s, _f, value) => value),
};

function makeService() {
  return new RenderService(cache as any, plugins as any);
}

/** Route cache.get by key prefix: host lookups vs render-payload lookups. */
function cacheReturns({ host, render }: { host?: unknown; render?: unknown }) {
  cache.get.mockImplementation((key: string) => {
    if (key.startsWith("cms:host:")) return Promise.resolve(host ?? null);
    return Promise.resolve(render ?? null);
  });
}

describe("RenderService", () => {
  beforeEach(() => {
    holder.db = makeDb();
    holder.systemDb = { domain: { findMany: vi.fn().mockResolvedValue([]) } };
    cache.get.mockReset();
    cache.set.mockClear();
    cache.siteVersion.mockResolvedValue(1);
    plugins.renderContributionsFor.mockClear();
    plugins.applyFilter.mockClear();
  });

  describe("resolve", () => {
    it("returns the cached payload without touching the database on a hit", async () => {
      const cached = { site: { id: "s1", canonicalHost: "example.com" }, content: null };
      cacheReturns({ host: publishedSite, render: cached });

      const out = await makeService().resolve("example.com", "/about");

      expect(out).toBe(cached);
      expect(holder.db.content.findMany).not.toHaveBeenCalled();
    });

    it("rebuilds a cached payload that predates canonicalHost instead of serving it", async () => {
      // Neither cache key is versioned by the shape of what it stores, so an entry
      // written before this field existed survives the deploy that added it. Served
      // as-is, site-runtime reads `canonicalHost` as undefined, decides the visitor
      // is on the wrong host, and 308s the whole site to "https://undefined/" — a
      // permanent redirect that every visitor's browser then caches. A stale-by-shape
      // entry is a miss.
      cacheReturns({ host: null, render: { site: { id: "s1" }, content: null } });
      holder.systemDb.domain.findMany.mockResolvedValue([
        {
          hostname: "z-cms.org",
          site: {
            ...publishedSite,
            domains: [{ hostname: "z-cms.org", isPrimary: true }],
          },
        },
      ]);

      const out = await makeService().resolve("z-cms.org", "/");

      expect(out.site.canonicalHost).toBe("z-cms.org");
    });

    it("404s an unknown hostname", async () => {
      cacheReturns({ host: null });
      holder.systemDb.domain.findMany.mockResolvedValue([]);

      await expect(makeService().resolve("nope.com", "/")).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it("404s a hostname whose site is not published", async () => {
      // An unpublished site must not be renderable, even by its real domain.
      cacheReturns({ host: null });
      holder.systemDb.domain.findMany.mockResolvedValue([
        { hostname: "draft.com", site: { ...publishedSite, status: "DRAFT", domains: [] } },
      ]);

      await expect(makeService().resolve("draft.com", "/")).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it("serves the www spelling of a site created without it", async () => {
      // "www.z-cms.org" is not a different site from "z-cms.org" — it is the same
      // site under the other name everybody assumes is equivalent, because it is.
      cacheReturns({ host: null, render: null });
      holder.systemDb.domain.findMany.mockResolvedValue([
        {
          hostname: "z-cms.org",
          site: {
            ...publishedSite,
            domains: [{ hostname: "z-cms.org", isPrimary: true }],
          },
        },
      ]);

      const out = await makeService().resolve("www.z-cms.org", "/");

      // Both spellings were offered to the database, and the one that exists won.
      expect(holder.systemDb.domain.findMany.mock.calls[0][0].where.hostname.in).toEqual([
        "www.z-cms.org",
        "z-cms.org",
      ]);
      // ...but the payload names the canonical host, which is what makes
      // site-runtime redirect rather than serve the page at two addresses.
      expect(out.site.canonicalHost).toBe("z-cms.org");
    });

    it("serves the apex of a site created as www, since canonical is whatever was typed", async () => {
      cacheReturns({ host: null, render: null });
      holder.systemDb.domain.findMany.mockResolvedValue([
        {
          hostname: "www.z-cms.org",
          site: {
            ...publishedSite,
            domains: [{ hostname: "www.z-cms.org", isPrimary: true }],
          },
        },
      ]);

      const out = await makeService().resolve("z-cms.org", "/");

      expect(out.site.canonicalHost).toBe("www.z-cms.org");
    });

    it("prefers an exact row over the www fallback", async () => {
      // If someone really did register both names as separate rows, the name that
      // was asked for is the name that answers — the fallback is only a fallback.
      cacheReturns({ host: null, render: null });
      holder.systemDb.domain.findMany.mockResolvedValue([
        {
          hostname: "z-cms.org",
          site: { ...publishedSite, id: "apex", domains: [{ hostname: "z-cms.org", isPrimary: true }] },
        },
        {
          hostname: "www.z-cms.org",
          site: {
            ...publishedSite,
            id: "www",
            domains: [{ hostname: "www.z-cms.org", isPrimary: true }],
          },
        },
      ]);

      const out = await makeService().resolve("www.z-cms.org", "/");

      expect(out.site.id).toBe("www");
      expect(out.site.canonicalHost).toBe("www.z-cms.org");
    });

    it("does not go looking for a www of localhost", async () => {
      cacheReturns({ host: null, render: null });
      holder.systemDb.domain.findMany.mockResolvedValue([
        {
          hostname: "localhost:3100",
          site: {
            ...publishedSite,
            domains: [{ hostname: "localhost:3100", isPrimary: true }],
          },
        },
      ]);

      await makeService().resolve("localhost:3100", "/");

      expect(holder.systemDb.domain.findMany.mock.calls[0][0].where.hostname.in).toEqual([
        "localhost:3100",
      ]);
    });

    it("only ever queries PUBLISHED content for a public page", async () => {
      // site-runtime is not trusted to filter drafts; if a draft is never in the
      // payload, no theme bug can leak one. So the content query is hard-filtered.
      cacheReturns({ host: publishedSite, render: null });

      await makeService().resolve("example.com", "/blog/hello");

      const contentQueries = holder.db.content.findMany.mock.calls.map((c: any) => c[0].where);
      expect(contentQueries.length).toBeGreaterThan(0);
      expect(contentQueries.every((w: any) => w.status === "PUBLISHED")).toBe(true);
    });

    it("does not leak internal columns into the rendered content payload", async () => {
      // tenantId, authorId and demoThemeKey are internal. The DTO mapper is the
      // wall; this proves a published row goes out without them.
      cacheReturns({ host: publishedSite, render: null });
      holder.db.content.findMany
        .mockResolvedValueOnce([publishedRow()]) // findContent
        .mockResolvedValueOnce([]); // alternatesFor

      const out = await makeService().resolve("example.com", "/blog/hello");

      expect(out.content).not.toBeNull();
      expect(out.content).not.toHaveProperty("tenantId");
      expect(out.content).not.toHaveProperty("authorId");
      expect(out.content).not.toHaveProperty("demoThemeKey");
    });

    it("scopes the content lookup to the resolved site", async () => {
      cacheReturns({ host: publishedSite, render: null });

      await makeService().resolve("example.com", "/blog/hello");

      const where = holder.db.content.findMany.mock.calls[0][0].where;
      expect(where.siteId).toBe("s1");
    });

    it("writes the freshly built payload back into the cache", async () => {
      cacheReturns({ host: publishedSite, render: null });

      await makeService().resolve("example.com", "/blog/hello");

      expect(cache.set).toHaveBeenCalled();
    });

    it("lists only PUBLISHED entries in an archive page", async () => {
      // "/blog" is an archive of a routable type. A draft post must not surface in
      // it any more than at its own URL.
      cacheReturns({ host: publishedSite, render: null });
      holder.db.contentType.findFirst.mockResolvedValue({
        id: "ct1",
        key: "post",
        pluralName: "Posts",
        routePrefix: "blog",
        isRoutable: true,
      });

      const out = await makeService().resolve("example.com", "/blog");

      expect(out.archive).not.toBeNull();
      const archiveWhere = holder.db.content.findMany.mock.calls[0][0].where;
      expect(archiveWhere.status).toBe("PUBLISHED");
      expect(archiveWhere.siteId).toBe("s1");
    });

    it("renders /search as a filtered archive instead of a missing page", async () => {
      cacheReturns({ host: publishedSite, render: null });
      const result = publishedRow({ title: "CMS architecture", slug: "cms-architecture" });
      holder.db.content.findMany.mockResolvedValue([result]);
      holder.db.content.count.mockResolvedValue(1);

      const out = await makeService().resolve("example.com", "/search", 1, " cms ");

      expect(out.content).toBeNull();
      expect(out.archive).toMatchObject({
        contentTypeKey: "search",
        title: "Search: cms",
        basePath: "/search",
        page: 1,
        totalPages: 1,
      });
      expect(out.archive?.items[0]?.title).toBe("CMS architecture");
      const searchWhere = holder.db.content.findMany.mock.calls[0][0].where;
      expect(searchWhere).toMatchObject({
        siteId: "s1",
        status: "PUBLISHED",
        locale: "en",
        OR: [{ demoThemeKey: null }, { demoThemeKey: "corp" }],
      });
    });

    it("includes matching active-theme demo content that has not been seeded into the DB", async () => {
      cacheReturns({ host: publishedSite, render: null });
      holder.db.siteTheme.findFirst.mockResolvedValue({
        theme: { key: "corp" },
        version: {
          version: "1.0.0",
          manifest: {
            demo: {
              contentTypes: [
                { key: "page", name: "Page", routePrefix: "" },
                { key: "post", name: "Post", routePrefix: "blog" },
              ],
              contents: [
                {
                  contentType: "page",
                  locale: "en",
                  slug: "static-features",
                  title: "Static CMS features",
                  blocks: [{ type: "core/richtext", props: { html: "<p>CMS from theme demo</p>" } }],
                },
                {
                  contentType: "post",
                  locale: "vi",
                  slug: "cms-vi",
                  title: "Không cùng locale",
                },
              ],
            },
          },
        },
        settings: {},
      });

      const out = await makeService().resolve("example.com", "/search", 1, "theme demo");

      expect(out.archive?.items.map((item) => item.path)).toContain("/static-features");
      expect(out.archive?.items.find((item) => item.path === "/static-features")).toMatchObject({
        title: "Static CMS features",
        contentType: { key: "page", name: "Page" },
      });
    });

    it('finds phrases inside seeded block HTML such as "Why another CMS"', async () => {
      cacheReturns({ host: publishedSite, render: null });
      holder.db.content.findMany.mockResolvedValue([
        publishedRow({
          title: "About Z-CMS",
          slug: "about",
          contentType: { id: "ct-page", key: "page", name: "Page", routePrefix: "" },
          blocks: [
            {
              type: "core/richtext",
              props: {
                html: "<h2>Why another CMS</h2><p>Most content platforms make you choose.</p>",
              },
            },
          ],
        }),
      ]);
      holder.db.content.count.mockResolvedValue(1);

      const out = await makeService().resolve("example.com", "/search", 1, "Why another CMS");

      expect(out.archive?.items.map((item) => item.path)).toContain("/about");
      expect(out.archive?.items.find((item) => item.path === "/about")?.title).toBe(
        "About Z-CMS",
      );
    });

    it("does not duplicate theme demo content already returned from the DB", async () => {
      cacheReturns({ host: publishedSite, render: null });
      holder.db.siteTheme.findFirst.mockResolvedValue({
        theme: { key: "corp" },
        version: {
          version: "1.0.0",
          manifest: {
            demo: {
              contentTypes: [{ key: "page", name: "Page", routePrefix: "" }],
              contents: [
                {
                  contentType: "page",
                  locale: "en",
                  slug: "features",
                  title: "Features from package",
                  blocks: [{ type: "core/richtext", props: { html: "<p>cms</p>" } }],
                },
              ],
            },
          },
        },
        settings: {},
      });
      holder.db.content.findMany.mockResolvedValue([
        publishedRow({
          title: "Features from database",
          slug: "features",
          contentType: { id: "ct-page", key: "page", name: "Page", routePrefix: "" },
          blocks: [{ type: "core/richtext", props: { html: "<p>cms</p>" } }],
        }),
      ]);
      holder.db.content.count.mockResolvedValue(1);

      const out = await makeService().resolve("example.com", "/search", 1, "cms");

      expect(out.archive?.items.filter((item) => item.path === "/features")).toHaveLength(1);
      expect(out.archive?.items.find((item) => item.path === "/features")?.title).toBe(
        "Features from database",
      );
    });

    it("resolves a locale-prefixed path in that locale", async () => {
      // "/vi/blog/hello" is the Vietnamese "/blog/hello"; the content lookup must
      // run in vi, or the archive/page silently serves the English row.
      const bilingual = { ...publishedSite, locales: ["en", "vi"] };
      cacheReturns({ host: bilingual, render: null });

      await makeService().resolve("example.com", "/vi/blog/hello");

      const contentQueries = holder.db.content.findMany.mock.calls.map((c: any) => c[0].where);
      expect(contentQueries.some((w: any) => w.locale === "vi")).toBe(true);
    });
  });

  /**
   * The flag has to be *sent*, not derived by the theme.
   *
   * A site's locales are rows in its database, written after any given theme
   * shipped — so a theme cannot hold a language-to-country table without needing
   * a release every time somebody adds Norwegian. These tests pin the field to
   * the payload so that removing it breaks here rather than in a theme nobody in
   * this repo owns.
   */
  describe("locale alternates carry a flag", () => {
    const bilingual = { ...publishedSite, locales: ["en", "vi"] };

    function siblingRow(locale: string, slug: string) {
      return {
        locale,
        slug,
        contentType: { routePrefix: "blog", isRoutable: true },
      };
    }

    it("resolves a flag for each translation of a page", async () => {
      cacheReturns({ host: bilingual, render: null });
      holder.db.content.findMany
        .mockResolvedValueOnce([publishedRow({ locale: "en" })]) // findContent
        .mockResolvedValueOnce([siblingRow("en", "hello"), siblingRow("vi", "xin-chao")]);

      const payload = await makeService().resolve("example.com", "/blog/hello");

      expect(payload.alternates).toEqual([
        expect.objectContaining({ locale: "en", flagUrl: "/z-flags/gb.svg" }),
        expect.objectContaining({ locale: "vi", flagUrl: "/z-flags/vn.svg" }),
      ]);
    });

    it("sends null rather than a broken URL for a language with no flag", async () => {
      // Arabic is spoken across twenty countries. A theme must receive null and
      // render the name alone — not an <img> pointing at a file that is not there.
      const withArabic = { ...publishedSite, locales: ["en", "ar"] };
      cacheReturns({ host: withArabic, render: null });
      holder.db.content.findMany
        .mockResolvedValueOnce([publishedRow({ locale: "en" })])
        .mockResolvedValueOnce([siblingRow("en", "hello"), siblingRow("ar", "marhaba")]);

      const payload = await makeService().resolve("example.com", "/blog/hello");

      expect(payload.alternates).toEqual([
        expect.objectContaining({ locale: "en", flagUrl: "/z-flags/gb.svg" }),
        expect.objectContaining({ locale: "ar", flagUrl: null }),
      ]);
    });

    it("resolves a flag for a locale the registry has never seen", async () => {
      // Nobody translated Z-CMS into Japanese, and `ja` is not in locales.json.
      // A site is still free to publish in it — the flag is derived from the
      // code, not looked up in a table of the languages the admin ships.
      const withJapanese = { ...publishedSite, locales: ["en", "ja"] };
      cacheReturns({ host: withJapanese, render: null });
      holder.db.content.findMany
        .mockResolvedValueOnce([publishedRow({ locale: "en" })])
        .mockResolvedValueOnce([siblingRow("en", "hello"), siblingRow("ja", "konnichiwa")]);

      const payload = await makeService().resolve("example.com", "/blog/hello");

      expect(payload.alternates).toContainEqual(
        expect.objectContaining({ locale: "ja", flagUrl: "/z-flags/jp.svg" }),
      );
    });

    it("carries a flag on an archive's alternates too", async () => {
      // The archive branch builds alternates from site.locales directly, on a
      // separate code path from the per-page one above. It was the easier of the
      // two to forget.
      cacheReturns({ host: bilingual, render: null });
      holder.db.contentType.findFirst.mockResolvedValue({
        id: "ct1",
        key: "post",
        name: "Post",
        routePrefix: "blog",
        isRoutable: true,
      });

      const payload = await makeService().resolve("example.com", "/blog");

      expect(payload.alternates).toEqual([
        expect.objectContaining({ locale: "en", flagUrl: "/z-flags/gb.svg" }),
        expect.objectContaining({ locale: "vi", flagUrl: "/z-flags/vn.svg" }),
      ]);
    });
  });

  /**
   * Collections: the lists a THEME declares in its manifest, and the lists an EDITOR
   * places on a page as a `core/content-list` block. Both are a *query* — the server
   * runs it and the theme is handed rows — so both go through one resolver, and these
   * tests are as much about what that resolver refuses to return as about what it does.
   */
  describe("collections", () => {
    /**
     * A tiny stand-in for the content table.
     *
     * The collection resolver's queries are answered by *applying* the where/orderBy/
     * take it built, so the fixture can hold a draft, a Vietnamese row and thirty
     * posts, and only what the server actually asked for comes back. Asserting on the
     * rows rather than on the shape of the where-clause is the point: a filter that is
     * present but wrong still fails here.
     */
    function withContent(rows: Record<string, unknown>[], page: unknown = null) {
      holder.db.content.findMany.mockImplementation((args: any) => {
        const where = args.where ?? {};

        // A collection query: the only one that filters by contentType KEY.
        if (where.contentType?.key) {
          const matched = rows.filter(
            (row: any) =>
              row.contentType.key === where.contentType.key &&
              row.status === where.status &&
              row.locale === where.locale &&
              row.siteId === where.siteId,
          );
          const [[field, dir]] = Object.entries(args.orderBy ?? {}) as [string, string][];
          const sorted = [...matched].sort((a: any, b: any) => {
            const [x, y] = [a[field], b[field]];
            const cmp = x instanceof Date ? x.getTime() - y.getTime() : String(x).localeCompare(String(y));
            return dir === "desc" ? -cmp : cmp;
          });
          return Promise.resolve(sorted.slice(0, args.take));
        }

        // alternatesFor
        if (where.translationGroupId) return Promise.resolve([]);
        // findContent
        if (where.slug !== undefined) return Promise.resolve(page ? [page] : []);
        return Promise.resolve([]);
      });
    }

    /** Puts `collections` in the active theme's manifest. */
    function themeDeclares(collections: Record<string, unknown>) {
      holder.db.siteTheme.findFirst.mockResolvedValue({
        theme: { key: "corp" },
        version: { version: "1.0.0", manifest: { collections } },
        settings: {},
      });
    }

    function post(over: Record<string, unknown> = {}) {
      return publishedRow(over);
    }

    it("runs a theme-declared collection and returns its published rows, newest first", async () => {
      cacheReturns({ host: publishedSite, render: null });
      themeDeclares({ latest: { contentType: "post", limit: 6 } });
      withContent([
        post({ id: "old", slug: "old", publishedAt: new Date("2024-01-01T00:00:00.000Z") }),
        post({ id: "new", slug: "new", publishedAt: new Date("2024-06-01T00:00:00.000Z") }),
      ]);

      const out = await makeService().resolve("example.com", "/nothing-here");

      expect(out.collections.latest.map((row) => row.id)).toEqual(["new", "old"]);
    });

    it("scopes a collection to the locale being rendered", async () => {
      // A Vietnamese front page listing English posts sends every reader who clicks
      // one straight out of the language they chose. Same rule as the archive.
      const bilingual = { ...publishedSite, locales: ["en", "vi"] };
      cacheReturns({ host: bilingual, render: null });
      themeDeclares({ latest: { contentType: "post" } });
      withContent([
        post({ id: "en1", locale: "en" }),
        post({ id: "vi1", locale: "vi" }),
      ]);

      const out = await makeService().resolve("example.com", "/vi/nothing-here");

      expect(out.collections.latest.map((row) => row.id)).toEqual(["vi1"]);
    });

    it("never lists a DRAFT", async () => {
      // A draft is no more listable than it is reachable at its own URL, and the
      // theme is not trusted to filter one out — it never receives it.
      cacheReturns({ host: publishedSite, render: null });
      themeDeclares({ latest: { contentType: "post" } });
      withContent([
        post({ id: "live", status: "PUBLISHED" }),
        post({ id: "secret", status: "DRAFT", title: "Unannounced acquisition" }),
      ]);

      const out = await makeService().resolve("example.com", "/nothing-here");

      expect(out.collections.latest.map((row) => row.id)).toEqual(["live"]);
      const collectionQueries = holder.db.content.findMany.mock.calls
        .map((call: any) => call[0].where)
        .filter((where: any) => where.contentType?.key);
      expect(collectionQueries.every((where: any) => where.status === "PUBLISHED")).toBe(true);
    });

    it("yields [] — with the key still present — for a content type this site does not have", async () => {
      // A theme is installed on sites that have never heard of its content types.
      // The name must still be there: themes are documented as mapping over it
      // without a guard, so a missing key is a crash on the front page.
      cacheReturns({ host: publishedSite, render: null });
      themeDeclares({ products: { contentType: "product", limit: 3 } });
      withContent([post({ id: "p1" })]);

      const out = await makeService().resolve("example.com", "/nothing-here");

      expect(out.collections).toHaveProperty("products");
      expect(out.collections.products).toEqual([]);
    });

    it("gives a theme that declares nothing an empty object", async () => {
      cacheReturns({ host: publishedSite, render: null });
      withContent([]);

      const out = await makeService().resolve("example.com", "/nothing-here");

      expect(out.collections).toEqual({});
    });

    it("caps a manifest asking for 1000 rows at COLLECTION_MAX_LIMIT", async () => {
      // The limit is the server's, not the theme's. A manifest is a stranger's JSON.
      cacheReturns({ host: publishedSite, render: null });
      themeDeclares({ latest: { contentType: "post", limit: 1000 } });
      withContent(
        Array.from({ length: 100 }, (_, i) =>
          post({ id: `p${i}`, slug: `p${i}`, publishedAt: new Date(2024, 0, i + 1) }),
        ),
      );

      const out = await makeService().resolve("example.com", "/nothing-here");

      expect(out.collections.latest).toHaveLength(COLLECTION_MAX_LIMIT);
      const take = holder.db.content.findMany.mock.calls
        .map((call: any) => call[0])
        .find((args: any) => args.where.contentType?.key)!.take;
      expect(take).toBe(COLLECTION_MAX_LIMIT);
    });

    it("sorts oldest-first when the query asks for it", async () => {
      cacheReturns({ host: publishedSite, render: null });
      themeDeclares({ archive: { contentType: "post", sort: "oldest" } });
      withContent([
        post({ id: "new", publishedAt: new Date("2024-06-01T00:00:00.000Z") }),
        post({ id: "old", publishedAt: new Date("2024-01-01T00:00:00.000Z") }),
      ]);

      const out = await makeService().resolve("example.com", "/nothing-here");

      expect(out.collections.archive.map((row) => row.id)).toEqual(["old", "new"]);
    });

    it("sorts by title when the query asks for it", async () => {
      cacheReturns({ host: publishedSite, render: null });
      themeDeclares({ index: { contentType: "post", sort: "title" } });
      withContent([
        post({ id: "z", title: "Zebra" }),
        post({ id: "a", title: "Aardvark" }),
      ]);

      const out = await makeService().resolve("example.com", "/nothing-here");

      expect(out.collections.index.map((row) => row.id)).toEqual(["a", "z"]);
    });

    it("falls back to newest for a sort nobody implements", async () => {
      cacheReturns({ host: publishedSite, render: null });
      themeDeclares({ latest: { contentType: "post", sort: "popularity" } });
      withContent([
        post({ id: "old", publishedAt: new Date("2024-01-01T00:00:00.000Z") }),
        post({ id: "new", publishedAt: new Date("2024-06-01T00:00:00.000Z") }),
      ]);

      const out = await makeService().resolve("example.com", "/nothing-here");

      expect(out.collections.latest.map((row) => row.id)).toEqual(["new", "old"]);
    });

    it("drops the excess when a manifest declares more collections than a page may run", async () => {
      // A hostile or broken manifest must not be able to turn one page view into 500
      // database queries.
      cacheReturns({ host: publishedSite, render: null });
      themeDeclares(
        Object.fromEntries(
          Array.from({ length: 40 }, (_, i) => [`list${i}`, { contentType: `type${i}` }]),
        ),
      );
      withContent([]);

      const out = await makeService().resolve("example.com", "/nothing-here");

      expect(Object.keys(out.collections)).toHaveLength(8);
      const collectionQueries = holder.db.content.findMany.mock.calls.filter(
        (call: any) => call[0].where.contentType?.key,
      );
      expect(collectionQueries.length).toBeLessThanOrEqual(8);
    });

    it("populates props.items on a core/content-list block, including a nested one", async () => {
      cacheReturns({ host: publishedSite, render: null });
      withContent(
        [post({ id: "p1", title: "Latest" })],
        publishedRow({
          blocks: [
            {
              id: "b1",
              type: "core/columns",
              props: {},
              children: [
                {
                  id: "b2",
                  type: CONTENT_LIST_BLOCK,
                  props: { contentType: "post", limit: 3, layout: "grid", heading: "News" },
                },
              ],
            },
          ],
        }),
      );

      const out = await makeService().resolve("example.com", "/blog/hello");

      const list = (out.content!.blocks[0] as any).children[0];
      expect(list.props.items.map((row: any) => row.id)).toEqual(["p1"]);
      // The editor's own props survive; only `items` is the server's.
      expect(list.props.heading).toBe("News");
      expect(list.props.layout).toBe("grid");
    });

    it("OVERWRITES a stored props.items instead of trusting it", async () => {
      // THE security test. A block's props are attacker-reachable — they are written
      // through the content API — so a stored `items` is an array claiming to be the
      // result of a query nobody ran: a draft, another locale, another tenant's rows.
      // The resolver replaces it wholesale. Merging, or honouring it when the query
      // returns nothing, would be exactly the smuggling route this rules out.
      cacheReturns({ host: publishedSite, render: null });
      withContent(
        [post({ id: "real", title: "Actually published" })],
        publishedRow({
          blocks: [
            {
              id: "b1",
              type: CONTENT_LIST_BLOCK,
              props: {
                contentType: "post",
                items: [
                  { id: "smuggled", title: "Another tenant's draft", siteId: "s2" },
                ],
              },
            },
          ],
        }),
      );

      const out = await makeService().resolve("example.com", "/blog/hello");

      const items = (out.content!.blocks[0] as any).props.items;
      expect(items.map((row: any) => row.id)).toEqual(["real"]);
      expect(JSON.stringify(items)).not.toContain("smuggled");
    });

    it("overwrites a stored props.items with [] when the query matches nothing", async () => {
      // The empty case is the one a naive `items ?? stored` would get wrong, and it is
      // the case an attacker would use: declare a content type that does not exist and
      // the hand-written rows would survive.
      cacheReturns({ host: publishedSite, render: null });
      withContent(
        [],
        publishedRow({
          blocks: [
            {
              id: "b1",
              type: CONTENT_LIST_BLOCK,
              props: {
                contentType: "nope",
                items: [{ id: "smuggled", title: "Not a real row" }],
              },
            },
          ],
        }),
      );

      const out = await makeService().resolve("example.com", "/blog/hello");

      expect((out.content!.blocks[0] as any).props.items).toEqual([]);
    });

    it("caps a block's limit at COLLECTION_MAX_LIMIT too", async () => {
      cacheReturns({ host: publishedSite, render: null });
      withContent(
        Array.from({ length: 50 }, (_, i) =>
          post({ id: `p${i}`, publishedAt: new Date(2024, 0, i + 1) }),
        ),
        publishedRow({
          blocks: [
            { id: "b1", type: CONTENT_LIST_BLOCK, props: { contentType: "post", limit: 1000 } },
          ],
        }),
      );

      const out = await makeService().resolve("example.com", "/blog/hello");

      expect((out.content!.blocks[0] as any).props.items).toHaveLength(COLLECTION_MAX_LIMIT);
    });

    it("runs one query for the same list asked for twice", async () => {
      // The theme declares "latest posts" and the editor drops the same list on the
      // page. One question, one round trip.
      cacheReturns({ host: publishedSite, render: null });
      themeDeclares({ latest: { contentType: "post", limit: 3 } });
      withContent(
        [post({ id: "p1" })],
        publishedRow({
          blocks: [
            { id: "b1", type: CONTENT_LIST_BLOCK, props: { contentType: "post", limit: 3 } },
            { id: "b2", type: CONTENT_LIST_BLOCK, props: { contentType: "post", limit: 3 } },
          ],
        }),
      );

      const out = await makeService().resolve("example.com", "/blog/hello");

      const collectionQueries = holder.db.content.findMany.mock.calls.filter(
        (call: any) => call[0].where.contentType?.key,
      );
      expect(collectionQueries).toHaveLength(1);
      expect(out.collections.latest.map((row) => row.id)).toEqual(["p1"]);
      expect((out.content!.blocks[1] as any).props.items.map((row: any) => row.id)).toEqual(["p1"]);
    });

    it("resolves the theme's collections on an archive page as well", async () => {
      // The theme's front-page lists are drawn by its template, not by the matched
      // content — so they exist on every route, archive included.
      cacheReturns({ host: publishedSite, render: null });
      themeDeclares({ latest: { contentType: "post" } });
      withContent([post({ id: "p1" })]);
      holder.db.contentType.findFirst.mockResolvedValue({
        id: "ct1",
        key: "post",
        pluralName: "Posts",
        routePrefix: "blog",
        isRoutable: true,
      });
      holder.db.content.count.mockResolvedValue(0);

      const out = await makeService().resolve("example.com", "/blog");

      expect(out.archive).not.toBeNull();
      expect(out.collections.latest.map((row) => row.id)).toEqual(["p1"]);
    });

    it("does not mutate the stored block tree while resolving it", async () => {
      // The payload is cached. Writing `items` into the row's own props would mean the
      // next reader of that object sees rows fetched for somebody else's request.
      cacheReturns({ host: publishedSite, render: null });
      const storedBlocks = [
        { id: "b1", type: CONTENT_LIST_BLOCK, props: { contentType: "post", limit: 3 } },
      ];
      withContent([post({ id: "p1" })], publishedRow({ blocks: storedBlocks }));

      await makeService().resolve("example.com", "/blog/hello");

      expect(storedBlocks[0].props).not.toHaveProperty("items");
    });
  });
});
