import { describe, expect, it } from "vitest";
import {
  LOCALES,
  NAMESPACES,
  REQUIRED_NAMESPACES,
  STABLE_THRESHOLD,
  SUPPORTED_LOCALES,
  SWITCHER_LOCALES,
  isSupportedLocale,
} from "../locales";
import { BASE_LOCALE, directionOf } from "../translator";

/**
 * `src/locales.ts` is generated from `locales.json`. These tests are not testing
 * the generator — they are testing the invariants the rest of the platform reads
 * off this file, so that a regenerated catalogue that breaks one of them fails
 * here rather than in a browser.
 */

describe("NAMESPACES", () => {
  it("lists every namespace the catalogue is split into", () => {
    expect([...NAMESPACES]).toEqual([
      "admin",
      "appearance",
      "auth",
      "common",
      "content",
      "errors",
      "mail",
      "media",
      "plugins",
      "site",
      "themeEditor",
    ]);
  });

  it("has no duplicates", () => {
    // A duplicate would make one namespace silently shadow another at merge time.
    expect(new Set(NAMESPACES).size).toBe(NAMESPACES.length);
  });
});

describe("REQUIRED_NAMESPACES", () => {
  it("gates on the chrome a user cannot avoid, plus content", () => {
    // The gate is a named set, not a count, precisely so that it cannot be
    // satisfied by translating the two biggest namespaces and none of the
    // visible ones. See scripts/coverage.ts.
    expect([...REQUIRED_NAMESPACES]).toEqual(["common", "auth", "admin", "content"]);
  });

  it("names only namespaces that actually exist", () => {
    // A required namespace with a typo in it would count zero keys forever and
    // hold every language out of the switcher.
    for (const ns of REQUIRED_NAMESPACES) {
      expect(NAMESPACES).toContain(ns);
    }
  });
});

describe("STABLE_THRESHOLD", () => {
  it("leaves slack below 100% so an English-only change cannot delete a language", () => {
    // At 1.0, adding five English keys drops every locale out of the switcher in
    // the next deploy — punishing translators for a change they did not make.
    expect(STABLE_THRESHOLD).toBeGreaterThan(0.5);
    expect(STABLE_THRESHOLD).toBeLessThan(1);
  });
});

describe("LOCALES", () => {
  it("includes the base locale", () => {
    // If `en` were missing, every fallback in the translator would resolve to
    // nothing and the whole admin would render raw keys.
    expect(LOCALES.map((l) => l.code)).toContain(BASE_LOCALE);
  });

  it("marks the base locale as fully covered and stable", () => {
    const base = LOCALES.find((l) => l.code === BASE_LOCALE);

    expect(base?.status).toBe("stable");
    expect(base?.coverage).toBe(100);
  });

  it("gives every locale a direction that agrees with directionOf", () => {
    // `dir` here is what `<html dir>` is stamped with. If it disagreed with the
    // translator's own idea of the direction, an RTL page would render LTR.
    for (const locale of LOCALES) {
      expect(locale.dir).toBe(directionOf(locale.code));
    }
  });

  it("gives every locale a native name, which is the only one a user sees", () => {
    for (const locale of LOCALES) {
      expect(locale.nativeName.length).toBeGreaterThan(0);
    }
  });

  it("has no duplicate codes", () => {
    const codes = LOCALES.map((l) => l.code);

    expect(new Set(codes).size).toBe(codes.length);
  });
});

describe("SWITCHER_LOCALES", () => {
  it("offers only the locales that are stable", () => {
    // An experimental language still resolves — it is simply not advertised. A
    // user who picks their own language from a menu and lands on a mostly-English
    // screen files a bug against the feature, not against the translation.
    for (const locale of SWITCHER_LOCALES) {
      expect(locale.status).toBe("stable");
    }
  });

  it("never offers a locale that is not in the build", () => {
    for (const locale of SWITCHER_LOCALES) {
      expect(LOCALES).toContain(locale);
    }
  });
});

describe("SUPPORTED_LOCALES", () => {
  it("lists the code of every locale in the build, experimental included", () => {
    // Experimental locales must still resolve: a user whose cookie names one gets
    // it, and `<html dir>` still has to be decided for them.
    expect([...SUPPORTED_LOCALES]).toEqual(LOCALES.map((l) => l.code));
  });
});

describe("isSupportedLocale", () => {
  it("accepts a locale that ships in the build", () => {
    expect(isSupportedLocale("en")).toBe(true);
    expect(isSupportedLocale("vi")).toBe(true);
  });

  it("rejects a language the project does not ship", () => {
    expect(isSupportedLocale("fr")).toBe(false);
  });

  it("rejects a regional tag that has no catalogue of its own", () => {
    // `en-US` is served by the `en` catalogue (see `languageOf`), but it is not
    // itself a supported code — callers must normalise before they trust it as
    // one, e.g. before using it to build a path.
    expect(isSupportedLocale("en-US")).toBe(false);
  });

  it("rejects a path-traversal string", () => {
    // THE BUG CLASS THIS GUARD EXISTS FOR. A locale is attacker-supplied — it
    // arrives in a cookie, a header, or a URL segment — and it is used to select
    // a catalogue and to fill `<html lang>`. If a traversal string were ever
    // accepted as "supported", a caller that joins it onto a path reads an
    // arbitrary file.
    expect(isSupportedLocale("../../etc/passwd")).toBe(false);
    expect(isSupportedLocale("en/../../../../etc/passwd")).toBe(false);
    expect(isSupportedLocale("..%2f..%2fetc%2fpasswd")).toBe(false);
  });

  it("rejects a string carrying markup", () => {
    // The locale is rendered into `<html lang="...">`. A locale that could carry
    // a quote and a tag out of an allowlist is a stored XSS.
    expect(isSupportedLocale('en"><script>alert(1)</script>')).toBe(false);
    expect(isSupportedLocale("<script>")).toBe(false);
  });

  it("rejects an inherited Object property name", () => {
    // The classic allowlist bug: `code in SUPPORTED` or `MAP[code]` would say yes
    // to "__proto__", "constructor" and "toString". Membership must be tested
    // against the list's own values.
    expect(isSupportedLocale("__proto__")).toBe(false);
    expect(isSupportedLocale("constructor")).toBe(false);
    expect(isSupportedLocale("toString")).toBe(false);
    expect(isSupportedLocale("hasOwnProperty")).toBe(false);
  });

  it("rejects the empty string", () => {
    expect(isSupportedLocale("")).toBe(false);
  });
});
