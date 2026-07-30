import { BadRequestException, NotFoundException } from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";

const domain = { findMany: vi.fn() };

vi.mock("@zcmsorg/database", () => ({
  db: () => ({}),
  getSystemDb: () => ({ domain }),
  installCorePlugins: vi.fn(),
}));

import { PublicSiteController } from "../sites.module";

const cache = {
  get: vi.fn().mockResolvedValue(null),
  set: vi.fn().mockResolvedValue(undefined),
};

function controller() {
  return new PublicSiteController(cache as never);
}

/** One registered domain row, shaped like the select in the controller. */
function domainRow(hostname: string, over: Record<string, unknown> = {}) {
  return {
    hostname,
    siteId: "11111111-1111-1111-1111-111111111111",
    site: {
      name: "Z-SOFT",
      settings: { brand: { primaryColor: "#123456", logo: "https://cdn.example/logo.png" } },
    },
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  cache.get.mockResolvedValue(null);
});

describe("PublicSiteController.branding", () => {
  it("answers a registered hostname with the site's public identity", async () => {
    domain.findMany.mockResolvedValue([domainRow("z-soft.com.vn")]);

    const result = await controller().branding("z-soft.com.vn");

    expect(result).toEqual({
      siteId: "11111111-1111-1111-1111-111111111111",
      name: "Z-SOFT",
      brand: { primaryColor: "#123456", logo: "https://cdn.example/logo.png" },
      host: "z-soft.com.vn",
    });
  });

  /**
   * The DTO is the whole security argument for an unauthenticated endpoint: every
   * field is already on the site's public home page. A row carrying more than that
   * must not widen the answer just because Prisma handed it over.
   */
  it("answers with those four fields and nothing else", async () => {
    domain.findMany.mockResolvedValue([
      domainRow("z-soft.com.vn", {
        tenantId: "secret-tenant",
        site: {
          name: "Z-SOFT",
          settings: { brand: {} },
          status: "DRAFT",
          tenantId: "secret-tenant",
        },
      }),
    ]);

    const result = await controller().branding("z-soft.com.vn");

    expect(Object.keys(result).sort()).toEqual(["brand", "host", "name", "siteId"]);
  });

  /**
   * A site whose status is not PUBLISHED renders nothing publicly — but its owner
   * still has to sign in, which is exactly when they need to see whose admin they
   * are looking at. This is the one place that deliberately differs from
   * `RenderService.resolveHost`.
   */
  it("answers for a site that is not published", async () => {
    domain.findMany.mockResolvedValue([
      domainRow("draft.example", {
        site: { name: "Not live yet", settings: {}, status: "DRAFT" },
      }),
    ]);

    await expect(controller().branding("draft.example")).resolves.toMatchObject({
      name: "Not live yet",
    });
  });

  it("resolves the www spelling of a registered apex onto the registered one", async () => {
    domain.findMany.mockResolvedValue([domainRow("z-soft.com.vn")]);

    const result = await controller().branding("www.z-soft.com.vn");

    expect(domain.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { hostname: { in: ["www.z-soft.com.vn", "z-soft.com.vn"] } },
      }),
    );
    // The link on the login screen has to point at the address the site answers on.
    expect(result.host).toBe("z-soft.com.vn");
  });

  it("prefers an exact match over the other spelling", async () => {
    domain.findMany.mockResolvedValue([
      domainRow("z-soft.com.vn", { siteId: "apex" }),
      domainRow("www.z-soft.com.vn", { siteId: "www" }),
    ]);

    await expect(controller().branding("www.z-soft.com.vn")).resolves.toMatchObject({
      siteId: "www",
    });
  });

  /** A Host header carries a port; a registered domain never does. */
  it("ignores the port and scheme the caller passed", async () => {
    domain.findMany.mockResolvedValue([domainRow("localhost")]);

    await controller().branding("https://LOCALHOST:3001");

    expect(domain.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { hostname: { in: ["localhost"] } } }),
    );
  });

  it("rejects a missing hostname rather than scanning for one", async () => {
    await expect(controller().branding(undefined)).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller().branding("   ")).rejects.toBeInstanceOf(BadRequestException);
    expect(domain.findMany).not.toHaveBeenCalled();
  });

  it("404s a hostname no site is registered under", async () => {
    domain.findMany.mockResolvedValue([]);

    await expect(controller().branding("nobody.example")).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("serves a cached answer without touching the database", async () => {
    cache.get.mockResolvedValue({
      siteId: "cached",
      name: "Cached",
      brand: { primaryColor: "#000000", logo: "" },
      host: "z-soft.com.vn",
    });

    await expect(controller().branding("z-soft.com.vn")).resolves.toMatchObject({
      siteId: "cached",
    });
    expect(domain.findMany).not.toHaveBeenCalled();
  });

  /**
   * Ten minutes, matching the render-side host cache — and under a key
   * `CacheService.forgetHosts` purges, so a new logo shows up on the next reload
   * rather than whenever the TTL happens to lapse.
   */
  it("caches by the hostname it was asked about, for ten minutes", async () => {
    domain.findMany.mockResolvedValue([domainRow("z-soft.com.vn")]);

    await controller().branding("www.z-soft.com.vn");

    expect(cache.get).toHaveBeenCalledWith("cms:brand:www.z-soft.com.vn");
    expect(cache.set).toHaveBeenCalledWith(
      "cms:brand:www.z-soft.com.vn",
      expect.objectContaining({ host: "z-soft.com.vn" }),
      600,
    );
  });

  /** `settings` is a JSON column written by whoever ran the site last. */
  it("falls back to the platform brand when the site's settings hold none", async () => {
    domain.findMany.mockResolvedValue([
      domainRow("z-soft.com.vn", { site: { name: "Z-SOFT", settings: null } }),
    ]);

    await expect(controller().branding("z-soft.com.vn")).resolves.toMatchObject({
      brand: { primaryColor: "#FA5600", logo: "" },
    });
  });
});
