import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `/robots.txt` exists for one SEO-load-bearing line: the `Sitemap:` directive
 * that lets a crawler discover the sitemap from a bare domain. An unknown domain
 * is disallowed rather than invited; a non-canonical host is redirected so the
 * Sitemap URL it advertises names the same host the sitemap's own entries use.
 */

const render = vi.hoisted(() => ({
  currentHostname: vi.fn<() => Promise<string>>(),
  resolveChrome: vi.fn(),
  canonicalUrl: vi.fn<(h: string) => Promise<string>>(),
}));

vi.mock("@/lib/render-client", () => render);

import { GET } from "../route";

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NODE_ENV", "production");
  render.currentHostname.mockResolvedValue("site.test");
  render.resolveChrome.mockResolvedValue({ site: { id: "s1", domains: ["site.test"] } });
  render.canonicalUrl.mockResolvedValue("https://site.test/robots.txt");
});

describe("GET /robots.txt", () => {
  it("allows crawling and points at the absolute sitemap on the canonical host", async () => {
    const res = await GET();

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    const body = await res.text();
    expect(body).toContain("Allow: /");
    expect(body).toContain("Sitemap: https://site.test/sitemap.xml");
  });

  it("disallows everything on an unknown domain", async () => {
    render.resolveChrome.mockResolvedValue(null);

    const res = await GET();

    expect(res.status).toBe(404);
    expect(await res.text()).toContain("Disallow: /");
  });

  it("folds the www spelling of a registered host onto it", async () => {
    render.currentHostname.mockResolvedValue("www.site.test");
    render.resolveChrome.mockResolvedValue({ site: { id: "s1", domains: ["site.test"] } });
    render.canonicalUrl.mockResolvedValue("https://site.test/robots.txt");

    const res = await GET();

    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe("https://site.test/robots.txt");
  });

  it("serves a second registered domain's own robots.txt, pointing at its own sitemap", async () => {
    render.currentHostname.mockResolvedValue("z-soft.vn");
    render.resolveChrome.mockResolvedValue({
      site: { id: "s1", domains: ["z-soft.com.vn", "z-soft.vn"] },
    });

    const res = await GET();

    expect(res.status).toBe(200);
    expect(render.canonicalUrl).not.toHaveBeenCalled();
    expect(await res.text()).toContain("Sitemap: https://z-soft.vn/sitemap.xml");
  });
});
