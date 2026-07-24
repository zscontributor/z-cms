import { describe, expect, it } from "vitest";
import { DEFAULT_SITE_BRAND, SiteBrandSchema, parseSiteBrand } from "../api";

/**
 * `parseSiteBrand` reads a JSON column. A JSON column holds whatever was true the
 * day it was written — an older shape, a hand-edited row, a null — and whatever it
 * holds, a site still has to render. So the rule is: never throw, never return a
 * hole, and never hand a theme something it would print as the word "null".
 *
 * The strict schema is the other half of the pair: it guards the door, so that
 * garbage cannot get in through the API in the first place.
 */
describe("parseSiteBrand", () => {
  it("reads a brand that is there", () => {
    const brand = parseSiteBrand({
      brand: { primaryColor: "#123ABC", logo: "/uploads/logo.png" },
    });

    expect(brand).toEqual({ primaryColor: "#123ABC", logo: "/uploads/logo.png" });
  });

  it("gives a site with no settings the platform's brand", () => {
    // Every site that existed before this feature. They must not render colourless.
    expect(parseSiteBrand(null)).toEqual(DEFAULT_SITE_BRAND);
    expect(parseSiteBrand(undefined)).toEqual(DEFAULT_SITE_BRAND);
    expect(parseSiteBrand({})).toEqual(DEFAULT_SITE_BRAND);
  });

  it("falls back field by field, keeping the half that is valid", () => {
    // A row with a logo but no colour keeps the logo. All-or-nothing here would
    // throw away a setting the owner did make.
    const brand = parseSiteBrand({ brand: { logo: "/uploads/logo.png" } });

    expect(brand.logo).toBe("/uploads/logo.png");
    expect(brand.primaryColor).toBe(DEFAULT_SITE_BRAND.primaryColor);
  });

  it("refuses a colour that is not a colour", () => {
    // The value reaches a stylesheet as `--brand`. "red; background: url(evil)" is
    // the reason this is a regex and not a trim.
    for (const bad of ["red", "#GGG", "#12345", "", "javascript:x", "#123456;"]) {
      expect(parseSiteBrand({ brand: { primaryColor: bad } }).primaryColor).toBe(
        DEFAULT_SITE_BRAND.primaryColor,
      );
    }
  });

  it("never returns a non-string logo, whatever the column holds", () => {
    // A theme does <img src={brand.logo}>. `null` there renders the string "null"
    // as a URL and requests it.
    for (const bad of [null, 42, {}, [], true]) {
      expect(parseSiteBrand({ brand: { logo: bad } }).logo).toBe("");
    }
  });

  it("survives a settings column that is not an object at all", () => {
    expect(parseSiteBrand("nonsense")).toEqual(DEFAULT_SITE_BRAND);
    expect(parseSiteBrand(7)).toEqual(DEFAULT_SITE_BRAND);
    expect(parseSiteBrand({ brand: "nonsense" })).toEqual(DEFAULT_SITE_BRAND);
  });
});

describe("SiteBrandSchema", () => {
  it("rejects a colour that is not a six-digit hex", () => {
    expect(SiteBrandSchema.safeParse({ primaryColor: "red", logo: "" }).success).toBe(false);
    expect(SiteBrandSchema.safeParse({ primaryColor: "#FA5600", logo: "" }).success).toBe(
      true,
    );
  });

  it("fills in the platform default when a field is omitted", () => {
    const parsed = SiteBrandSchema.parse({});

    expect(parsed).toEqual(DEFAULT_SITE_BRAND);
  });
});
