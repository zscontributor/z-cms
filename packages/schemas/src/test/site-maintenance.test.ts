import { describe, expect, it } from "vitest";
import {
  DEFAULT_SITE_MAINTENANCE,
  SiteMaintenanceSchema,
  parseSiteMaintenance,
  resolveLocalizedText,
} from "../api";

/**
 * `parseSiteMaintenance` reads a JSON column that, for every site created before
 * maintenance mode existed, has no `maintenance` key at all. The one thing it
 * must never do is close — or fail to render — a site over a row it cannot
 * read. `SiteMaintenanceSchema` is the strict door on the way in.
 */

describe("parseSiteMaintenance", () => {
  it("reads a site with no maintenance settings as open, with the defaults", () => {
    expect(parseSiteMaintenance({})).toEqual(DEFAULT_SITE_MAINTENANCE);
    expect(parseSiteMaintenance(null)).toEqual(DEFAULT_SITE_MAINTENANCE);
    expect(parseSiteMaintenance({ brand: { primaryColor: "#000000" } })).toEqual(
      DEFAULT_SITE_MAINTENANCE,
    );
  });

  it("reads any mode it does not recognise as maintenance", () => {
    // The safer of the two: an unknown mode on a closed site answers 503 rather
    // than a 200 launch page a crawler would index.
    expect(parseSiteMaintenance({ maintenance: { mode: "coming-soon" } }).mode).toBe("coming-soon");
    expect(parseSiteMaintenance({ maintenance: { mode: "launch" } }).mode).toBe("maintenance");
    expect(parseSiteMaintenance({ maintenance: {} }).mode).toBe("maintenance");
  });

  it("only ever closes a site on a literal true", () => {
    expect(parseSiteMaintenance({ maintenance: { enabled: true } }).enabled).toBe(true);
    expect(parseSiteMaintenance({ maintenance: { enabled: "true" } }).enabled).toBe(false);
    expect(parseSiteMaintenance({ maintenance: { enabled: 1 } }).enabled).toBe(false);
  });

  it("falls back field by field rather than throwing on a hand-edited row", () => {
    const out = parseSiteMaintenance({
      maintenance: {
        enabled: true,
        title: { en: "Back soon", "not a locale!": "x", vi: 42 },
        message: "just a string",
        logo: 7,
        backgroundColor: "red",
        textColor: "#ABCDEF",
        expectedBackAt: "yesterday",
        bypassKey: "has spaces",
      },
    });

    expect(out.enabled).toBe(true);
    expect(out.title).toEqual({ en: "Back soon" });
    expect(out.message).toEqual({});
    expect(out.logo).toBe("");
    expect(out.backgroundColor).toBe(DEFAULT_SITE_MAINTENANCE.backgroundColor);
    expect(out.textColor).toBe("#ABCDEF");
    expect(out.expectedBackAt).toBeNull();
    expect(out.bypassKey).toBe("");
  });

  it("round-trips what the strict schema accepted", () => {
    const written = SiteMaintenanceSchema.parse({
      enabled: true,
      mode: "coming-soon",
      title: { en: "Back soon", vi: "Sắp quay lại" },
      message: { en: "Line one\nLine two" },
      logo: "https://cdn.example/logo.png",
      backgroundImage: "https://cdn.example/bg.jpg",
      backgroundColor: "#112233",
      textColor: "#ffffff",
      expectedBackAt: "2026-01-01T09:00:00.000Z",
      bypassKey: "abc_DEF-123",
    });

    expect(parseSiteMaintenance({ maintenance: written })).toEqual(written);
  });
});

describe("SiteMaintenanceSchema", () => {
  it("fills every field for an empty object", () => {
    expect(SiteMaintenanceSchema.parse({})).toEqual(DEFAULT_SITE_MAINTENANCE);
  });

  it("rejects a colour that is not a colour and a key that is not URL-safe", () => {
    expect(SiteMaintenanceSchema.safeParse({ backgroundColor: "blue" }).success).toBe(false);
    expect(SiteMaintenanceSchema.safeParse({ textColor: "#FFF" }).success).toBe(false);
    expect(SiteMaintenanceSchema.safeParse({ bypassKey: "with space" }).success).toBe(false);
    expect(SiteMaintenanceSchema.safeParse({ bypassKey: "ok-key_1" }).success).toBe(true);
  });

  it("rejects a locale key that is not a locale", () => {
    expect(SiteMaintenanceSchema.safeParse({ title: { "": "x" } }).success).toBe(false);
    expect(SiteMaintenanceSchema.safeParse({ title: { EN: "x" } }).success).toBe(false);
    expect(SiteMaintenanceSchema.safeParse({ title: { "vi-VN": "x" } }).success).toBe(true);
  });

  it("wants an ISO instant, or null, for the expected time", () => {
    expect(SiteMaintenanceSchema.safeParse({ expectedBackAt: "tomorrow" }).success).toBe(false);
    expect(SiteMaintenanceSchema.safeParse({ expectedBackAt: null }).success).toBe(true);
    expect(
      SiteMaintenanceSchema.safeParse({ expectedBackAt: "2026-01-01T09:00:00+07:00" }).success,
    ).toBe(true);
  });
});

describe("resolveLocalizedText", () => {
  const text = { en: "Hello", vi: "Xin chào", ja: "  " };

  it("prefers the exact locale, then its base language, then the default", () => {
    expect(resolveLocalizedText(text, "vi")).toBe("Xin chào");
    expect(resolveLocalizedText(text, "vi-VN")).toBe("Xin chào");
    expect(resolveLocalizedText(text, "fr", "vi")).toBe("Xin chào");
  });

  it("treats a blank entry as unwritten and falls through", () => {
    // A locale tab left blank in the admin must not render an empty notice.
    expect(resolveLocalizedText(text, "ja", "en")).toBe("Hello");
    expect(resolveLocalizedText({}, "en")).toBe("");
    expect(resolveLocalizedText(undefined, "en")).toBe("");
  });
});
