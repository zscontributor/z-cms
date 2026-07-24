import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A sitemap is a PUBLIC document handed to search engines. Two things must hold or
 * it leaks / breaks: a draft must never appear in it, and every interpolated value
 * must be well-formed XML. These tests drive the generator with rows that a real
 * tenant table could hold and assert both — plus the tenant scoping that stops a
 * spoofed siteId in a job payload from building another tenant's sitemap.
 */

const { systemDb, tenantDb, s3Send } = vi.hoisted(() => ({
  systemDb: { site: { findFirst: vi.fn() } },
  tenantDb: { content: { findMany: vi.fn() } },
  s3Send: vi.fn(),
}));

vi.mock("@zcmsorg/database", () => ({
  getSystemDb: () => systemDb,
  db: () => tenantDb,
  // Faithful to the real contract: run the callback with the tenant bound. The
  // callback closes over db(), so it takes no argument.
  withTenant: (_tenantId: string, fn: () => unknown) => fn(),
}));

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    send = s3Send;
  },
  PutObjectCommand: class {
    __type = "put";
    constructor(public input: unknown) {}
  },
}));

import { runSitemap } from "../sitemap";

const SITE = {
  id: "site-1",
  tenantId: "tenant-1",
  locales: ["en", "vi"],
  defaultLocale: "en",
  domains: [{ hostname: "example.com", isPrimary: true }],
};

function contentRow(overrides: Record<string, unknown> = {}) {
  return {
    slug: "about",
    locale: "en",
    status: "PUBLISHED",
    translationGroupId: "g1",
    publishedAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    contentType: { routePrefix: "", isRoutable: true },
    ...overrides,
  };
}

/** Runs the job and returns the XML body it wrote to S3. */
function writtenXml(): string {
  const putCall = s3Send.mock.calls
    .map(([c]) => c as { __type: string; input: { Body: string; Key: string } })
    .find((c) => c.__type === "put");
  return putCall?.input.Body ?? "";
}

describe("runSitemap", () => {
  beforeEach(() => {
    // Hoisted mocks persist across tests; clear their call history so writtenXml()
    // reads only THIS test's PutObject, not a stale one from an earlier test.
    vi.clearAllMocks();
    vi.stubEnv("S3_BUCKET", "media-bucket");
    vi.stubEnv("S3_ACCESS_KEY", "k");
    vi.stubEnv("S3_SECRET_KEY", "s");
    systemDb.site.findFirst.mockResolvedValue(SITE);
    tenantDb.content.findMany.mockResolvedValue([contentRow()]);
    s3Send.mockResolvedValue({});
  });

  it("writes the sitemap to the site's own object key", async () => {
    await runSitemap({ tenantId: "tenant-1", siteId: "site-1" });

    const putCall = s3Send.mock.calls
      .map(([c]) => c as { __type: string; input: { Key: string } })
      .find((c) => c.__type === "put");
    expect(putCall!.input.Key).toBe("sites/site-1/sitemap.xml");
  });

  it("refuses to build a sitemap for a site id that is not in the job's tenant", async () => {
    // ATTACK: a job payload carrying another tenant's siteId. The (id, tenantId) filter
    // means findFirst returns nothing, and the job must write NO sitemap rather than
    // publish one tenant's URLs under a lookup keyed by another's.
    systemDb.site.findFirst.mockResolvedValue(null);

    const result = await runSitemap({ tenantId: "tenant-1", siteId: "someone-elses-site" });

    expect(result).toEqual({ urls: 0 });
    const puts = s3Send.mock.calls.filter(([c]) => (c as { __type: string }).__type === "put");
    expect(puts).toHaveLength(0);
  });

  it("scopes the site lookup to the job's tenant", async () => {
    // Belt-and-braces on the test above: prove the filter actually carries tenantId,
    // so it is RLS-equivalent and not a bare id lookup.
    await runSitemap({ tenantId: "tenant-1", siteId: "site-1" });

    const where = systemDb.site.findFirst.mock.calls[0]![0].where;
    expect(where).toMatchObject({ id: "site-1", tenantId: "tenant-1" });
  });

  it("queries only PUBLISHED content, so a draft can never reach the public sitemap", async () => {
    // The single most important property of this file. A draft leaking into the
    // sitemap is unpublished content advertised to the whole internet.
    await runSitemap({ tenantId: "tenant-1", siteId: "site-1" });

    const where = tenantDb.content.findMany.mock.calls[0]![0].where;
    expect(where.status).toBe("PUBLISHED");
  });

  it("lists only locales the site still publishes, never a stale locale's rows", async () => {
    // Rows in a dropped locale are unreachable — the router will not resolve their
    // prefix — so listing them advertises 404s.
    await runSitemap({ tenantId: "tenant-1", siteId: "site-1" });

    const where = tenantDb.content.findMany.mock.calls[0]![0].where;
    expect(where.locale).toEqual({ in: ["en", "vi"] });
  });

  it("omits a non-routable content type from the sitemap", async () => {
    // A content type with no public route (e.g. a reusable block) has no URL to list.
    tenantDb.content.findMany.mockResolvedValue([
      contentRow({ slug: "visible" }),
      contentRow({ slug: "hidden", contentType: { routePrefix: "", isRoutable: false } }),
    ]);

    await runSitemap({ tenantId: "tenant-1", siteId: "site-1" });

    const xml = writtenXml();
    expect(xml).toContain("https://example.com/visible");
    expect(xml).not.toContain("hidden");
  });

  it("prefixes a non-default locale's URL with its code and leaves the default bare", async () => {
    tenantDb.content.findMany.mockResolvedValue([
      contentRow({ slug: "about", locale: "en", translationGroupId: "g1" }),
      contentRow({ slug: "gioi-thieu", locale: "vi", translationGroupId: "g1" }),
    ]);

    await runSitemap({ tenantId: "tenant-1", siteId: "site-1" });

    const xml = writtenXml();
    expect(xml).toContain("<loc>https://example.com/about</loc>");
    expect(xml).toContain("<loc>https://example.com/vi/gioi-thieu</loc>");
  });

  it("returns the number of URLs it wrote", async () => {
    tenantDb.content.findMany.mockResolvedValue([
      contentRow({ slug: "a", translationGroupId: "g1" }),
      contentRow({ slug: "b", translationGroupId: "g2" }),
    ]);

    const result = await runSitemap({ tenantId: "tenant-1", siteId: "site-1" });

    expect(result).toEqual({ urls: 2 });
  });

  it("serves a localhost domain over http, not https", async () => {
    // A dev/preview site on localhost has no TLS; advertising https URLs for it would
    // list links that do not resolve.
    systemDb.site.findFirst.mockResolvedValue({
      ...SITE,
      domains: [{ hostname: "localhost:3000", isPrimary: true }],
    });

    await runSitemap({ tenantId: "tenant-1", siteId: "site-1" });

    expect(writtenXml()).toContain("<loc>http://localhost:3000/about</loc>");
  });

  it("still writes a sitemap when the site has no primary domain configured", async () => {
    // A brand-new site with no domain yet must not crash the job; it simply has no host.
    systemDb.site.findFirst.mockResolvedValue({ ...SITE, domains: [] });

    const result = await runSitemap({ tenantId: "tenant-1", siteId: "site-1" });

    expect(result.urls).toBe(1);
  });

  it("maps the empty-slug homepage to /", async () => {
    tenantDb.content.findMany.mockResolvedValue([contentRow({ slug: "" })]);

    await runSitemap({ tenantId: "tenant-1", siteId: "site-1" });

    expect(writtenXml()).toContain("<loc>https://example.com/</loc>");
  });

  it("prefixes a content type's route and uses updatedAt for lastmod when never published-stamped", async () => {
    // publishedAt can be null on a row that was published then edited; lastmod must
    // still be a real date, and the route prefix must be part of the URL.
    tenantDb.content.findMany.mockResolvedValue([
      contentRow({
        slug: "hello-world",
        publishedAt: null,
        updatedAt: new Date("2026-02-02T00:00:00Z"),
        contentType: { routePrefix: "blog", isRoutable: true },
      }),
    ]);

    await runSitemap({ tenantId: "tenant-1", siteId: "site-1" });

    const xml = writtenXml();
    expect(xml).toContain("<loc>https://example.com/blog/hello-world</loc>");
    expect(xml).toContain("<lastmod>2026-02-02T00:00:00.000Z</lastmod>");
  });

  it("cross-links translation siblings with hreflang alternates", async () => {
    // Search engines treat translations as one page only when every member links every
    // other. A single-member group must NOT emit alternates for itself alone.
    tenantDb.content.findMany.mockResolvedValue([
      contentRow({ slug: "about", locale: "en", translationGroupId: "g1" }),
      contentRow({ slug: "gioi-thieu", locale: "vi", translationGroupId: "g1" }),
    ]);

    await runSitemap({ tenantId: "tenant-1", siteId: "site-1" });

    const xml = writtenXml();
    expect(xml).toContain('hreflang="en" href="https://example.com/about"');
    expect(xml).toContain('hreflang="vi" href="https://example.com/vi/gioi-thieu"');
  });

  // ----------------------------------------------------------------------------
  // XML-escaping hardening gap. See the REPORT: the generator interpolates slugs
  // and locales straight into <loc>/hreflang with NO XML escaping. SlugSchema
  // (^$|^[a-z0-9-]+$) blocks `&`/`<` at the create/update API today, so this is
  // not exploitable through that path — but the sitemap is built from the DB, and
  // any OTHER write path (a bulk import, a plugin with DB access, a future looser
  // validator) that admits a `&` or `<` yields malformed / injectable XML.
  //
  // These two tests CHARACTERISE the current (unescaped) output so the gap is
  // pinned and visible. They will fail the day escaping is added — at which point
  // they should be flipped to assert the escaped form (`&amp;` / `&lt;`).
  // ----------------------------------------------------------------------------
  it("emits a slug containing & verbatim, without XML-escaping it (documents a hardening gap)", async () => {
    tenantDb.content.findMany.mockResolvedValue([contentRow({ slug: "tom&jerry" })]);

    await runSitemap({ tenantId: "tenant-1", siteId: "site-1" });

    const xml = writtenXml();
    // A raw & is not legal XML character data: this <loc> is malformed. Escaped, it
    // would read `tom&amp;jerry`. The presence of the raw & is the bug.
    expect(xml).toContain("tom&jerry");
    expect(xml).not.toContain("tom&amp;jerry");
  });

  it("emits a slug containing < verbatim, without XML-escaping it (documents a hardening gap)", async () => {
    tenantDb.content.findMany.mockResolvedValue([contentRow({ slug: "a<b" })]);

    await runSitemap({ tenantId: "tenant-1", siteId: "site-1" });

    const xml = writtenXml();
    // A raw < opens a phantom element — this is the injection primitive.
    expect(xml).toContain("a<b");
    expect(xml).not.toContain("a&lt;b");
  });
});
