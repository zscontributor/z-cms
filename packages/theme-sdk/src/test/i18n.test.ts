import { describe, expect, it } from "vitest";
import {
  createThemeTranslator,
  flattenMessages,
  interpolate,
  THEME_BASE_LOCALE,
} from "../i18n";
import type { ThemeMessageCatalog } from "../i18n";

/**
 * A theme's translator runs on every public page. The one rule that matters here
 * is that it can NEVER throw and NEVER return blank: a missing translation must
 * surface as the visible key, because a live page with a hole in it where a
 * string should be is a worse failure than an obviously-untranslated label.
 */

const CATALOG: ThemeMessageCatalog = {
  en: { archive: { readMore: "Read more", by: "By {author}" }, footer: "© Acme" },
  vi: { archive: { readMore: "Đọc thêm" } },
};

describe("THEME_BASE_LOCALE", () => {
  it("is English — the base every other locale falls back to", () => {
    expect(THEME_BASE_LOCALE).toBe("en");
  });
});

describe("createThemeTranslator", () => {
  it("returns the string for the requested locale", () => {
    const t = createThemeTranslator(CATALOG, "vi");

    expect(t("archive.readMore")).toBe("Đọc thêm");
  });

  it("falls back to the base locale for a key the requested locale is missing", () => {
    // `vi` translated "readMore" but not "by". The reader gets the English string,
    // not a blank — a partial translation must not leave gaps on the page.
    const t = createThemeTranslator(CATALOG, "vi");

    expect(t("archive.by", { author: "Lan" })).toBe("By Lan");
  });

  it("returns the key itself when no locale has the string", () => {
    // The last-resort fallback. This is what turns a typo'd key into a visible
    // "archive.readmore" a developer will notice, instead of a silent empty slot.
    const t = createThemeTranslator(CATALOG, "en");

    expect(t("archive.doesNotExist")).toBe("archive.doesNotExist");
  });

  it("serves a regional locale from the region-less catalogue", () => {
    // "vi-VN" has no catalogue of its own; it must resolve through "vi" before
    // giving up, so a Vietnamese reader in Vietnam is not served English.
    const t = createThemeTranslator(CATALOG, "vi-VN");

    expect(t("archive.readMore")).toBe("Đọc thêm");
  });

  it("still resolves every string when the theme ships no catalogue at all", () => {
    // A theme with no translations is valid; `t` must degrade to echoing keys,
    // never crash the render.
    const t = createThemeTranslator(undefined, "en");

    expect(t("archive.readMore")).toBe("archive.readMore");
  });

  it("interpolates variables into the resolved string", () => {
    const t = createThemeTranslator(CATALOG, "en");

    expect(t("archive.by", { author: "Minh" })).toBe("By Minh");
  });

  it("leaves an unknown locale to fall through to the base locale", () => {
    const t = createThemeTranslator(CATALOG, "fr");

    expect(t("footer")).toBe("© Acme");
  });
});

describe("flattenMessages", () => {
  it("flattens a nested message tree into dotted keys", () => {
    const flat = flattenMessages({ archive: { readMore: "Read more", tag: { all: "All" } } });

    expect(flat).toEqual({ "archive.readMore": "Read more", "archive.tag.all": "All" });
  });

  it("keeps a top-level string at its own key", () => {
    expect(flattenMessages({ footer: "© Acme" })).toEqual({ footer: "© Acme" });
  });

  it("returns an empty map for an empty tree", () => {
    expect(flattenMessages({})).toEqual({});
  });

  it("prefixes every key when given a starting prefix", () => {
    expect(flattenMessages({ a: "x" }, "root")).toEqual({ "root.a": "x" });
  });
});

describe("interpolate", () => {
  it("replaces a named placeholder with its value", () => {
    expect(interpolate("By {author}", { author: "Lan" })).toBe("By Lan");
  });

  it("coerces a numeric value to a string", () => {
    expect(interpolate("{count} posts", { count: 3 })).toBe("3 posts");
  });

  it("leaves an unknown placeholder visible rather than blanking it", () => {
    // A missing variable showing as "{author}" is a bug a developer will spot;
    // a silent empty string is one that ships.
    expect(interpolate("By {author}", { count: 3 })).toBe("By {author}");
  });

  it("returns the template unchanged when no variables are supplied", () => {
    expect(interpolate("Read more")).toBe("Read more");
  });

  it("does not treat a value's own braces as a further placeholder", () => {
    // ATTACK-ish: a variable whose value looks like a template ("{secret}") must
    // be inserted literally, not re-scanned — otherwise a translated string could
    // be coaxed into expanding a second placeholder the author did not intend.
    expect(interpolate("Hello {name}", { name: "{footer}" })).toBe("Hello {footer}");
  });
});
