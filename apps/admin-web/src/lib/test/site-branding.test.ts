import { beforeEach, describe, expect, it, vi } from "vitest";

// The request headers the mocked next/headers hands back. Written per test.
const { headerJar } = vi.hoisted(() => ({ headerJar: new Map<string, string>() }));

vi.mock("next/headers", () => ({
  headers: async () => ({
    get: (name: string) => headerJar.get(name.toLowerCase()) ?? null,
  }),
}));

// `cache` memoises per React request; there is no request here, so call through.
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, cache: <T>(fn: T) => fn };
});

const apiFetch = vi.fn();
vi.mock("../api", () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));

import { siteBranding } from "../site-branding";

function branding(over: Record<string, unknown> = {}) {
  return {
    siteId: "site-1",
    name: "Z-SOFT",
    brand: { primaryColor: "#FA5600", logo: "https://cdn.example/logo.png" },
    host: "z-soft.com.vn",
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  headerJar.clear();
  apiFetch.mockResolvedValue(branding());
});

describe("siteBranding", () => {
  it("asks about the forwarded host, without its port, anonymously", async () => {
    headerJar.set("x-forwarded-host", "z-soft.com.vn:443");
    headerJar.set("host", "admin-web:3001");

    await siteBranding();

    expect(apiFetch).toHaveBeenCalledWith("/public/sites/branding", {
      query: { hostname: "z-soft.com.vn" },
      anonymous: true,
      siteScoped: false,
    });
  });

  /** Behind a proxy chain the first entry is the host the browser actually typed. */
  it("takes the first host of a forwarded list", async () => {
    headerJar.set("x-forwarded-host", "z-soft.com.vn, internal.svc");

    await siteBranding();

    expect(apiFetch).toHaveBeenCalledWith(
      "/public/sites/branding",
      expect.objectContaining({ query: { hostname: "z-soft.com.vn" } }),
    );
  });

  it("falls back to the Host header when nothing is forwarded", async () => {
    headerJar.set("host", "Z-CMS.org");

    await siteBranding();

    expect(apiFetch).toHaveBeenCalledWith(
      "/public/sites/branding",
      expect.objectContaining({ query: { hostname: "z-cms.org" } }),
    );
  });

  it("links to the hostname the API resolved, not the one the browser used", async () => {
    headerJar.set("x-forwarded-host", "www.z-soft.com.vn");
    headerJar.set("x-forwarded-proto", "https");

    await expect(siteBranding()).resolves.toMatchObject({
      host: "z-soft.com.vn",
      portalUrl: "https://z-soft.com.vn",
    });
  });

  /**
   * No forwarded scheme means nobody is proxying us — a developer on localhost.
   * An https link there is a link that only fails once clicked.
   */
  it("builds an http link on localhost and an https one everywhere else", async () => {
    headerJar.set("host", "localhost:3001");
    apiFetch.mockResolvedValue(branding({ host: "localhost" }));
    await expect(siteBranding()).resolves.toMatchObject({ portalUrl: "http://localhost" });

    headerJar.clear();
    headerJar.set("host", "z-soft.com.vn");
    apiFetch.mockResolvedValue(branding());
    await expect(siteBranding()).resolves.toMatchObject({ portalUrl: "https://z-soft.com.vn" });
  });

  it("honours a forwarded scheme over the guess", async () => {
    headerJar.set("x-forwarded-host", "staging.internal");
    headerJar.set("x-forwarded-proto", "http, https");

    await expect(siteBranding()).resolves.toMatchObject({
      portalUrl: "http://z-soft.com.vn",
    });
  });

  /**
   * The logo is a value out of a JSON column, written by whoever ran the site —
   * untrusted input, not markup we authored.
   */
  it.each([
    ["https://cdn.example/logo.png", "https://cdn.example/logo.png"],
    ["http://cdn.example/logo.png", "http://cdn.example/logo.png"],
    ["/media/logo.png", "/media/logo.png"],
    ["  https://cdn.example/logo.png  ", "https://cdn.example/logo.png"],
    ["javascript:alert(1)", ""],
    ["data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=", ""],
    ["//evil.example/logo.png", ""],
    ["logo.png", ""],
    ["", ""],
  ])("vets the logo URL %j", async (logo, expected) => {
    headerJar.set("host", "z-soft.com.vn");
    apiFetch.mockResolvedValue(
      branding({ brand: { primaryColor: "#FA5600", logo } }),
    );

    await expect(siteBranding()).resolves.toMatchObject({ logo: expected });
  });

  /**
   * Everything below is the ordinary case on the dedicated admin hostname, and none
   * of it may cost anyone their ability to sign in.
   */
  it("is null when the hostname belongs to no site", async () => {
    headerJar.set("host", "nobody.example");
    apiFetch.mockRejectedValue(new Error("404 Not Found"));

    await expect(siteBranding()).resolves.toBeNull();
  });

  it("is null when there is no host header at all", async () => {
    await expect(siteBranding()).resolves.toBeNull();
    expect(apiFetch).not.toHaveBeenCalled();
  });
});
