import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `/sitemap.xml` puts the worker-built S3 object behind the site's own domain.
 * The behaviours that matter to a crawler: an unknown domain 404s (not a 500);
 * a request on a non-canonical host is sent to the canonical one so the sitemap
 * a search engine indexes matches the URLs inside it; a site whose object does
 * not exist yet gets a valid *empty* sitemap rather than an error; and the bytes
 * the worker wrote are passed through untouched with an XML content type.
 */

const render = vi.hoisted(() => ({
  currentHostname: vi.fn<() => Promise<string>>(),
  resolveChrome: vi.fn(),
  canonicalUrl: vi.fn<(h: string) => Promise<string>>(),
}));

vi.mock("@/lib/render-client", () => render);

import { GET } from "../route";

/** A resolved payload with just the fields the route reads. */
function chrome(id: string, ...domains: string[]) {
  return { site: { id, domains } };
}

/** Builds a fetch stub returning one canned Response, and records the call. */
function stubFetch(response: Response | Error) {
  const fetchMock = vi.fn(async (_input: string | URL | Request) => {
    if (response instanceof Error) throw response;
    return response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("S3_PUBLIC_URL", "https://cdn.test/zcms-media");
  render.currentHostname.mockResolvedValue("site.test");
  render.resolveChrome.mockResolvedValue(chrome("site-1", "site.test"));
  render.canonicalUrl.mockResolvedValue("https://site.test/sitemap.xml");
});

describe("GET /sitemap.xml", () => {
  it("passes the S3 object through, at the site-id key, as XML", async () => {
    const fetchMock = stubFetch(
      new Response("<urlset><url><loc>x</loc></url></urlset>", { status: 200 }),
    );

    const res = await GET();

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/xml; charset=utf-8");
    expect(await res.text()).toContain("<loc>x</loc>");
    // The object it fetched is keyed by the resolved site id, under the site's bucket.
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      "https://cdn.test/zcms-media/sites/site-1/sitemap.xml",
    );
  });

  it("404s an unknown domain without touching storage", async () => {
    render.resolveChrome.mockResolvedValue(null);
    const fetchMock = stubFetch(new Response("", { status: 200 }));

    const res = await GET();

    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("folds the www spelling of a registered host onto it, permanently", async () => {
    render.currentHostname.mockResolvedValue("www.site.test");
    render.resolveChrome.mockResolvedValue(chrome("site-1", "site.test"));
    render.canonicalUrl.mockResolvedValue("https://site.test/sitemap.xml");

    const res = await GET();

    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe("https://site.test/sitemap.xml");
    expect(render.canonicalUrl).toHaveBeenCalledWith("site.test");
  });

  it("serves a second registered domain at its own name, never redirecting to the primary", async () => {
    // The multi-domain contract: "z-soft.vn" and "z-soft.com.vn" both serve their own
    // sitemap. Landing on the alias must NOT bounce to the primary.
    render.currentHostname.mockResolvedValue("z-soft.vn");
    render.resolveChrome.mockResolvedValue(chrome("site-1", "z-soft.com.vn", "z-soft.vn"));
    stubFetch(new Response("<urlset></urlset>", { status: 200 }));

    const res = await GET();

    expect(res.status).toBe(200);
    expect(render.canonicalUrl).not.toHaveBeenCalled();
  });

  it("returns a valid empty sitemap when the object does not exist yet", async () => {
    stubFetch(new Response("Not Found", { status: 404 }));

    const res = await GET();

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/xml; charset=utf-8");
    const body = await res.text();
    expect(body).toContain("<urlset");
    expect(body).not.toContain("<url>");
  });

  it("fails loud when storage is not configured, rather than de-listing the site", async () => {
    vi.stubEnv("S3_PUBLIC_URL", "");

    const res = await GET();

    expect(res.status).toBe(500);
  });

  it("502s a storage error instead of serving a broken sitemap", async () => {
    stubFetch(new Response("boom", { status: 500 }));
    expect((await GET()).status).toBe(502);
  });

  it("502s when storage is unreachable", async () => {
    stubFetch(new Error("ECONNREFUSED"));
    expect((await GET()).status).toBe(502);
  });
});
