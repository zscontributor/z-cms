import { NextRequest } from "next/server";
import type { SiteMaintenanceStateDto } from "@zcmsorg/schemas";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAINTENANCE_BYPASS_COOKIE,
  MEMO_TTL_MS,
  forgetMaintenanceState,
  maintenanceLocaleFor,
  maintenanceStateFor,
  maintenanceVerdict,
  retryAfterSeconds,
} from "../lib/maintenance";
import { hexToRgba, renderMaintenanceHtml, safeUrl } from "../lib/maintenance-page";
import { middleware } from "../middleware";

/**
 * Maintenance mode is decided in middleware so the answer can be a real 503.
 * These tests pin the three things that make it safe to ship: crawlers get a
 * 503 + Retry-After (never a 200 they would index), the owner's bypass works
 * and nobody else's does, and an unreachable cms-api opens the gate instead of
 * closing every site behind it.
 */

function state(over: Partial<SiteMaintenanceStateDto> = {}): SiteMaintenanceStateDto {
  return {
    enabled: true,
    mode: "maintenance",
    title: { en: "Back soon", vi: "Sắp quay lại" },
    message: { en: "Upgrading the servers.\nThanks for your patience." },
    logo: "",
    backgroundImage: "",
    backgroundColor: "#0F172A",
    textColor: "#FFFFFF",
    expectedBackAt: null,
    bypassKey: "letmein-12345678",
    site: {
      name: "Acme",
      defaultLocale: "en",
      locales: ["en", "vi"],
      brand: { primaryColor: "#FA5600", logo: "https://cdn.example/logo.png" },
    },
    ...over,
  };
}

function apiAnswers(body: SiteMaintenanceStateDto | null, status = 200) {
  // A fresh Response per call: a body can only be read once.
  const fetchMock = vi.fn().mockImplementation(async () =>
    body
      ? new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
      : new Response(null, { status: status === 200 ? 404 : status }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function request(url: string, init: { cookie?: string; host?: string } = {}) {
  const headers = new Headers();
  if (init.cookie) headers.set("cookie", init.cookie);
  if (init.host) headers.set("x-forwarded-host", init.host);
  return new NextRequest(url, { headers });
}

beforeEach(() => {
  forgetMaintenanceState();
  vi.stubEnv("CMS_API_URL", "http://api.internal:4100");
  vi.stubEnv("CMS_INTERNAL_TOKEN", "secret");
});

describe("maintenanceVerdict", () => {
  it("closes the site to a visitor with no bypass", () => {
    expect(maintenanceVerdict(state(), { cookie: undefined, previewParam: null })).toBe("closed");
  });

  it("lets the owner's cookie through, and nobody else's", () => {
    expect(
      maintenanceVerdict(state(), { cookie: "letmein-12345678", previewParam: null }),
    ).toBeNull();
    expect(maintenanceVerdict(state(), { cookie: "guess", previewParam: null })).toBe("closed");
  });

  it("honours no cookie at all when the owner never generated a key", () => {
    // An empty key must not match an empty cookie: with nothing generated there
    // is nothing to present, however the cookie is shaped.
    expect(maintenanceVerdict(state({ bypassKey: "" }), { cookie: "", previewParam: null })).toBe(
      "closed",
    );
  });

  it("previews the notice on an open site only with the key in the URL", () => {
    const open = state({ enabled: false });
    expect(maintenanceVerdict(open, { cookie: undefined, previewParam: "letmein-12345678" })).toBe(
      "preview",
    );
    expect(maintenanceVerdict(open, { cookie: undefined, previewParam: "nope" })).toBeNull();
    expect(maintenanceVerdict(open, { cookie: undefined, previewParam: null })).toBeNull();
  });

  it("serves the site when there is no state to speak of", () => {
    expect(maintenanceVerdict(null, { cookie: undefined, previewParam: null })).toBeNull();
  });
});

describe("maintenanceStateFor", () => {
  it("asks cms-api once per hostname and memoises the answer", async () => {
    const fetchMock = apiAnswers(state());

    await maintenanceStateFor("acme.test");
    await maintenanceStateFor("ACME.test");
    await maintenanceStateFor("acme.test");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = new URL(fetchMock.mock.calls[0]![0] as URL);
    expect(url.pathname).toBe("/api/v1/render/maintenance");
    expect(url.searchParams.get("hostname")).toBe("acme.test");
  });

  it("asks again once the memo has aged out", async () => {
    const fetchMock = apiAnswers(state());
    const t0 = 1_000_000;

    await maintenanceStateFor("acme.test", t0);
    await maintenanceStateFor("acme.test", t0 + MEMO_TTL_MS - 1);
    await maintenanceStateFor("acme.test", t0 + MEMO_TTL_MS + 1);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("forgets a hostname on demand, which is what the purge hook calls", async () => {
    const fetchMock = apiAnswers(state());

    await maintenanceStateFor("acme.test");
    forgetMaintenanceState("acme.test");
    await maintenanceStateFor("acme.test");

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("treats an unknown hostname (404) as no gate", async () => {
    apiAnswers(null);
    expect(await maintenanceStateFor("nobody.test")).toBeNull();
  });

  it("fails open when cms-api cannot answer", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await maintenanceStateFor("acme.test")).toBeNull();

    apiAnswers(state(), 500);
    forgetMaintenanceState();
    expect(await maintenanceStateFor("acme.test")).toBeNull();
  });
});

describe("retryAfterSeconds", () => {
  it("counts down to the expected time, and clamps to a day", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    expect(retryAfterSeconds(state({ expectedBackAt: "2026-01-01T00:10:00Z" }), now)).toBe(600);
    expect(retryAfterSeconds(state({ expectedBackAt: "2026-03-01T00:00:00Z" }), now)).toBe(86_400);
  });

  it("falls back to an hour when the time is unknown or already past", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    expect(retryAfterSeconds(state(), now)).toBe(3600);
    expect(retryAfterSeconds(state({ expectedBackAt: "2025-12-31T00:00:00Z" }), now)).toBe(3600);
  });
});

describe("maintenanceLocaleFor", () => {
  const site = { locales: ["en", "vi"], defaultLocale: "en" };

  it("reads the locale prefix the site publishes in, else the default", () => {
    expect(maintenanceLocaleFor("/vi/gioi-thieu", site)).toBe("vi");
    expect(maintenanceLocaleFor("/about", site)).toBe("en");
    expect(maintenanceLocaleFor("/ja/about", site)).toBe("en");
    expect(maintenanceLocaleFor("/", site)).toBe("en");
  });
});

describe("renderMaintenanceHtml", () => {
  it("draws the owner's text in the visitor's language, falling back to the default", () => {
    const html = renderMaintenanceHtml(state(), "vi");
    expect(html).toContain('<html lang="vi">');
    expect(html).toContain("Sắp quay lại");
    // No Vietnamese message was written: the English one serves.
    expect(html).toContain("Upgrading the servers.");
    expect(html).toContain("Thanks for your patience.");
  });

  it("uses the platform's wording when the owner wrote none", () => {
    const html = renderMaintenanceHtml(state({ title: {}, message: {} }), "ja");
    expect(html).toContain("まもなく再開します");
  });

  it("falls back to the site's brand logo when no maintenance logo is set", () => {
    expect(renderMaintenanceHtml(state(), "en")).toContain('src="https://cdn.example/logo.png"');
    expect(renderMaintenanceHtml(state({ logo: "/m/logo.svg" }), "en")).toContain('src="/m/logo.svg"');
  });

  it("tints the background image with the chosen colour", () => {
    const html = renderMaintenanceHtml(
      state({ backgroundImage: "https://cdn.example/bg.jpg", backgroundColor: "#112233" }),
      "en",
    );
    expect(html).toContain("url(https://cdn.example/bg.jpg)");
    expect(html).toContain(hexToRgba("#112233", 0.72));
  });

  it("escapes everything it prints and refuses URLs that could break out", () => {
    const html = renderMaintenanceHtml(
      state({
        title: { en: '<script>alert("x")</script>' },
        logo: 'javascript:alert(1)',
        backgroundImage: 'https://x/a.png") ; background: url(evil',
      }),
      "en",
    );
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("evil");
  });

  it("names the expected return time when one is set, formatted for the locale", () => {
    const html = renderMaintenanceHtml(state({ expectedBackAt: "2026-01-01T09:00:00Z" }), "en");
    expect(html).toContain('<time datetime="2026-01-01T09:00:00Z">');
    expect(html).toContain("Expected back");
    // Intl formatted it (with a zone), not the toUTCString fallback: the two
    // style options and `timeZoneName` cannot be combined, and that mistake
    // silently produced "Thu, 01 Jan 2026 09:00:00 GMT" for every locale.
    expect(html).not.toContain("09:00:00 GMT");
    expect(html).toMatch(/<time[^>]*>[^<]*2026[^<]*<\/time>/);
  });
});

describe("renderMaintenanceHtml — coming soon", () => {
  const soon = () =>
    state({
      mode: "coming-soon",
      title: {},
      message: {},
      expectedBackAt: "2026-01-02T00:00:30Z",
    });

  it("uses the coming-soon wording and is indexable", () => {
    const html = renderMaintenanceHtml(soon(), "vi");
    expect(html).toContain("Sắp ra mắt");
    expect(html).toContain("Ra mắt:");
    // The launch page IS the site for now: nothing tells crawlers to stay away.
    expect(html).not.toContain('name="robots"');
  });

  it("prints the countdown server-side and ships the ticking script with the nonce", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    const html = renderMaintenanceHtml(soon(), "en", { nonce: "abc123", now });
    expect(html).toContain('data-zm-launch="2026-01-02T00:00:30Z"');
    // 1 day, 0 h, 0 min, 30 s.
    expect(html).toMatch(/data-zm-unit>1<\/span>/);
    expect(html).toMatch(/data-zm-unit>00<\/span><span class="zm__unit">hours/);
    expect(html).toMatch(/data-zm-unit>30<\/span><span class="zm__unit">seconds/);
    expect(html).toContain('<script nonce="abc123">');
  });

  it("stops at zero once the launch date has passed", () => {
    const now = Date.parse("2026-02-01T00:00:00Z");
    const html = renderMaintenanceHtml(soon(), "en", { now });
    expect(html).toMatch(/data-zm-unit>0<\/span>/);
    expect(html).not.toMatch(/data-zm-unit>-/);
  });

  it("ships no script without a nonce, and no countdown without a date", () => {
    expect(renderMaintenanceHtml(soon(), "en")).not.toContain("<script");
    expect(renderMaintenanceHtml(state({ mode: "coming-soon" }), "en", { nonce: "n" })).not.toContain(
      "data-zm-launch",
    );
  });

  it("never counts down an outage", () => {
    const html = renderMaintenanceHtml(
      state({ expectedBackAt: "2030-01-01T00:00:00Z" }),
      "en",
      { nonce: "n" },
    );
    expect(html).not.toContain("data-zm-launch");
    expect(html).not.toContain("<script");
  });
});

describe("safeUrl", () => {
  it("keeps http(s) and site-relative URLs, drops the rest", () => {
    expect(safeUrl("https://cdn.example/a.png")).toBe("https://cdn.example/a.png");
    expect(safeUrl("/media/a.png")).toBe("/media/a.png");
    expect(safeUrl("data:image/png;base64,AAAA")).toBe("");
    expect(safeUrl("https://cdn.example/a.png\" onload=\"x")).toBe("");
  });
});

describe("middleware maintenance gate", () => {
  it("answers a closed site with a 503, Retry-After and the notice", async () => {
    apiAnswers(state({ expectedBackAt: new Date(Date.now() + 600_000).toISOString() }));

    const res = await middleware(request("http://acme.test/blog/hello", { host: "acme.test" }));

    expect(res.status).toBe(503);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-type")).toContain("text/html");
    // Still the hardened surface: the notice ships with the same CSP as a page.
    expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(await res.text()).toContain("Back soon");
  });

  it("answers a coming-soon site with a 200 and no Retry-After", async () => {
    apiAnswers(state({ mode: "coming-soon", expectedBackAt: "2030-01-01T00:00:00Z" }));

    const res = await middleware(request("http://acme.test/", { host: "acme.test" }));

    expect(res.status).toBe(200);
    expect(res.headers.get("retry-after")).toBeNull();
    expect(res.headers.get("cache-control")).toBe("no-store");
    const html = await res.text();
    expect(html).toContain("data-zm-launch");
    // The countdown script carries the same nonce the CSP names, so it runs.
    const nonce = res.headers.get("content-security-policy")?.match(/'nonce-([^']+)'/)?.[1];
    expect(nonce).toBeTruthy();
    expect(html).toContain(`<script nonce="${nonce}">`);
  });

  it("serves the site to a visitor holding the bypass cookie", async () => {
    apiAnswers(state());

    const res = await middleware(
      request("http://acme.test/", {
        host: "acme.test",
        cookie: `${MAINTENANCE_BYPASS_COOKIE}=letmein-12345678`,
      }),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });

  it("turns ?zc-bypass=<key> into the cookie and sends the visitor back to the clean URL", async () => {
    apiAnswers(state());

    const res = await middleware(
      request("http://acme.test/about?zc-bypass=letmein-12345678&page=2", { host: "acme.test" }),
    );

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/about?page=2");
    const cookie = res.cookies.get(MAINTENANCE_BYPASS_COOKIE);
    expect(cookie?.value).toBe("letmein-12345678");
    expect(cookie?.httpOnly).toBe(true);
  });

  it("does not store a value that is not shaped like a key", async () => {
    apiAnswers(state());

    const res = await middleware(
      request("http://acme.test/?zc-bypass=<img%20src=x>", { host: "acme.test" }),
    );

    expect(res.status).toBe(302);
    expect(res.cookies.get(MAINTENANCE_BYPASS_COOKIE)?.value ?? "").toBe("");
  });

  it("previews the notice on an open site with a 200, never a 503", async () => {
    apiAnswers(state({ enabled: false }));

    const res = await middleware(
      request("http://acme.test/?zc-maintenance-preview=letmein-12345678", { host: "acme.test" }),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("retry-after")).toBeNull();
    expect(await res.text()).toContain("Back soon");
  });

  it("leaves /api/* alone so the purge hook can reopen the site", async () => {
    const fetchMock = apiAnswers(state());

    const res = await middleware(request("http://acme.test/api/revalidate", { host: "acme.test" }));

    expect(res.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("serves the site when cms-api is down rather than closing it", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const res = await middleware(request("http://acme.test/", { host: "acme.test" }));

    expect(res.status).toBe(200);
  });
});
