import { describe, expect, it } from "vitest";
import {
  BASE_LOCALE,
  createMessageTranslator,
  createTranslator,
  directionOf,
  interpolate,
  languageOf,
  negotiateLocale,
  resolveMessages,
} from "../translator";
import type { Messages } from "../types";

/**
 * The contract this file defends, in one line: a missing translation must never
 * blank out a page. Every fallback test below exists because the alternative to
 * falling back is rendering "" or "undefined" to a visitor, in production, with
 * nothing in the logs.
 */

/** A two-locale catalogue: `vi` is deliberately incomplete, like a real one. */
const CATALOG: Record<string, Messages> = {
  en: {
    common: { save: "Save", greet: "Hello, {name}!" },
    content: { list: { empty: "No {type} yet" } },
    onlyInEnglish: "English only",
  },
  vi: {
    common: { save: "Lưu", greet: "Xin chào, {name}!" },
    // `content` and `onlyInEnglish` are untranslated on purpose.
  },
};

describe("BASE_LOCALE", () => {
  it("is the locale every other locale falls back to", () => {
    // The whole fallback chain is anchored on this constant. If it ever named a
    // locale that is not fully translated, an untranslated key would fall back
    // to another gap and render as a raw key.
    expect(BASE_LOCALE).toBe("en");
  });
});

describe("createTranslator", () => {
  it("returns the translation for a nested dotted key", () => {
    const t = createTranslator(CATALOG, "en");

    expect(t("content.list.empty")).toBe("No {type} yet");
  });

  it("prefers the requested locale over the base locale", () => {
    const t = createTranslator(CATALOG, "vi");

    expect(t("common.save")).toBe("Lưu");
  });

  it("falls back to the base locale for a key the locale has not translated", () => {
    // `vi` has no `content` namespace at all. A half-finished language must
    // still render a usable page, in English, rather than an empty one.
    const t = createTranslator(CATALOG, "vi");

    expect(t("content.list.empty")).toBe("No {type} yet");
  });

  it("serves a regional locale from its language catalogue", () => {
    // Nobody ships a `vi-VN` catalogue; the browser sends `vi-VN` anyway.
    const t = createTranslator(CATALOG, "vi-VN");

    expect(t("common.save")).toBe("Lưu");
  });

  it("falls back to the key when no locale in the chain has the translation", () => {
    // THE RULE THIS PACKAGE EXISTS FOR. A visible key ("common.missing") is ugly
    // and gets reported within the hour; "" or "undefined" ships silently.
    const t = createTranslator(CATALOG, "vi");

    expect(t("common.missing")).toBe("common.missing");
  });

  it("falls back to the key when the dotted path stops at a string", () => {
    // "common.save.deeper" walks into a leaf. Indexing a string would hand back
    // characters ("S"), which is worse than useless — it is plausible.
    const t = createTranslator(CATALOG, "en");

    expect(t("common.save.deeper")).toBe("common.save.deeper");
  });

  it("falls back to the key when the key names a branch instead of a leaf", () => {
    // `t("common")` resolves to an object. Rendering it would print
    // "[object Object]" into the page.
    const t = createTranslator(CATALOG, "en");

    expect(t("common")).toBe("common");
  });

  it("serves the base locale to a locale nobody has ever heard of", () => {
    const t = createTranslator(CATALOG, "zz-ZZ");

    expect(t("common.save")).toBe("Save");
  });

  it("serves the base locale rather than crashing on a path-traversal locale", () => {
    // A locale reaches this function straight from a cookie or a header. If a
    // hostile string could knock the translator over, a request header would be
    // a denial of service on every rendered page.
    const t = createTranslator(CATALOG, "../../etc/passwd");

    expect(t("common.save")).toBe("Save");
  });

  it("does not resolve a key onto Object.prototype", () => {
    // `t("toString")` must not hand back a function, and `t("constructor.name")`
    // must not hand back "Object". A translation key is often derived from data
    // (an error code, a field name), so the lookup walking the prototype chain
    // is a way to render internals into a page.
    const t = createTranslator(CATALOG, "en");

    expect(t("toString")).toBe("toString");
    expect(t("constructor.name")).toBe("constructor.name");
    expect(t("__proto__")).toBe("__proto__");
  });

  it("interpolates the params it is given into the chosen translation", () => {
    const t = createTranslator(CATALOG, "vi");

    expect(t("common.greet", { name: "Quy" })).toBe("Xin chào, Quy!");
  });

  it("interpolates into the fallback translation too", () => {
    // The fallback string carries placeholders like any other. Losing the
    // substitution on the fallback path renders "No {type} yet" to a user.
    const t = createTranslator(CATALOG, "vi");

    expect(t("content.list.empty", { type: "Post" })).toBe("No Post yet");
  });
});

describe("resolveMessages", () => {
  it("folds the base locale in underneath the requested one", () => {
    // This is the payload a server component ships to the browser. Anything the
    // locale has not translated must already be filled in with English, because
    // the client has no second catalogue left to consult.
    const merged = resolveMessages(CATALOG, "vi");

    expect(merged).toEqual({
      common: { save: "Lưu", greet: "Xin chào, {name}!" },
      content: { list: { empty: "No {type} yet" } },
      onlyInEnglish: "English only",
    });
  });

  it("lets the requested locale win key by key over the base locale", () => {
    const merged = resolveMessages(CATALOG, "vi");

    expect((merged.common as Messages).save).toBe("Lưu");
  });

  it("merges nested namespaces instead of replacing them wholesale", () => {
    // A locale that translates one key of `content.list` must not wipe out the
    // sibling English keys it did not touch.
    const partial: Record<string, Messages> = {
      en: { content: { list: { empty: "No posts", title: "Posts" } } },
      vi: { content: { list: { empty: "Chưa có bài" } } },
    };

    const merged = resolveMessages(partial, "vi");

    expect(merged).toEqual({
      content: { list: { empty: "Chưa có bài", title: "Posts" } },
    });
  });

  it("does not mutate the catalogue it merges from", () => {
    // The catalogue is a module-level singleton shared by every request. One
    // request resolving `vi` must not leave Vietnamese strings in the English
    // catalogue for the next visitor.
    const catalog: Record<string, Messages> = {
      en: { common: { save: "Save" } },
      vi: { common: { save: "Lưu" } },
    };

    resolveMessages(catalog, "vi");

    expect(catalog.en).toEqual({ common: { save: "Save" } });
  });

  it("returns the base messages unchanged for the base locale itself", () => {
    const merged = resolveMessages(CATALOG, "en");

    expect(merged).toEqual(CATALOG.en);
  });

  it("returns the base messages for an unknown locale", () => {
    const merged = resolveMessages(CATALOG, "zz");

    expect(merged).toEqual(CATALOG.en);
  });

  it("does not let a hostile catalogue layer pollute Object.prototype", () => {
    // `deepMerge` skips `__proto__`/`constructor`/`prototype`, so a message
    // catalogue that is not authored in this repo (a theme's or a plugin's,
    // merged through the exported `resolveMessages`) cannot set a property on
    // Object.prototype for the whole process. JSON.parse keeps `__proto__` as an
    // own key, which is exactly the vector this guards against.
    const hostile = JSON.parse('{"__proto__": {"polluted": "yes"}}') as Messages;

    try {
      resolveMessages({ en: { ok: "ok" }, xx: hostile }, "xx");

      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    } finally {
      delete (Object.prototype as Record<string, unknown>).polluted;
    }
  });
});

describe("createMessageTranslator", () => {
  it("reads a key out of an already-resolved catalogue", () => {
    const t = createMessageTranslator({ common: { save: "Lưu" } });

    expect(t("common.save")).toBe("Lưu");
  });

  it("interpolates params", () => {
    const t = createMessageTranslator({ common: { greet: "Hello, {name}!" } });

    expect(t("common.greet", { name: "Quy" })).toBe("Hello, Quy!");
  });

  it("falls back to the key for a message that is not there", () => {
    // There is no chain left on the client. Without this the admin renders
    // "undefined" into a button label.
    const t = createMessageTranslator({ common: { save: "Lưu" } });

    expect(t("common.delete")).toBe("common.delete");
  });

  it("falls back to the key when the key names a branch", () => {
    const t = createMessageTranslator({ common: { save: "Lưu" } });

    expect(t("common")).toBe("common");
  });
});

describe("languageOf", () => {
  it("drops the region from a regional locale", () => {
    expect(languageOf("vi-VN")).toBe("vi");
  });

  it("leaves a bare language alone", () => {
    expect(languageOf("en")).toBe("en");
  });

  it("drops the script and the region from a long tag", () => {
    expect(languageOf("az-Arab-IR")).toBe("az");
  });

  it("returns an empty string for an empty locale rather than throwing", () => {
    // Called on whatever a cookie contained, including "".
    expect(languageOf("")).toBe("");
  });
});

describe("directionOf", () => {
  it("reports a right-to-left language as rtl", () => {
    expect(directionOf("ar")).toBe("rtl");
  });

  it("reports a left-to-right language as ltr", () => {
    expect(directionOf("vi")).toBe("ltr");
  });

  it("reports an unknown locale as ltr", () => {
    // Guessing rtl for an unknown tag renders a page a reader cannot use at all;
    // guessing ltr renders one that merely reads oddly.
    expect(directionOf("zz-ZZ")).toBe("ltr");
  });

  it("keeps a Latin-script Kurdish page left to right", () => {
    // `ku` (Kurmanji) is Latin script. Listing the bare language as RTL would
    // flip every Kurdish page backwards — the reason it is not in the RTL list.
    expect(directionOf("ku")).toBe("ltr");
  });

  it("lets an Arabic script subtag override a left-to-right language", () => {
    // Azerbaijani is LTR in Latin and RTL in Arabic script. Only the tag says which.
    expect(directionOf("az-Arab")).toBe("rtl");
  });

  it("lets a Latin script subtag override a right-to-left language", () => {
    expect(directionOf("ku-Latn")).toBe("ltr");
  });

  it("ignores a region subtag that is not four letters when looking for a script", () => {
    expect(directionOf("ar-EG")).toBe("rtl");
  });

  it("matches the language case-insensitively", () => {
    // Accept-Language and cookies both arrive in whatever case the client chose.
    expect(directionOf("AR-EG")).toBe("rtl");
  });

  it("reports a hostile locale string as ltr rather than throwing", () => {
    // This value ends up in `<html dir>`. It must resolve to one of two literals.
    expect(directionOf("<script>alert(1)</script>")).toBe("ltr");
    expect(directionOf("../../etc/passwd")).toBe("ltr");
  });
});

describe("interpolate", () => {
  it("substitutes a named placeholder", () => {
    expect(interpolate("Hello, {name}!", { name: "Quy" })).toBe("Hello, Quy!");
  });

  it("substitutes the same placeholder everywhere it appears", () => {
    expect(interpolate("{a} and {a}", { a: "x" })).toBe("x and x");
  });

  it("stringifies a numeric param", () => {
    expect(interpolate("{count} items", { count: 3 })).toBe("3 items");
  });

  it("substitutes a zero, rather than treating it as absent", () => {
    // The falsy-value bug: `vars[name] || match` would render "{count} items".
    expect(interpolate("{count} items", { count: 0 })).toBe("0 items");
  });

  it("leaves a placeholder the caller did not supply visible in the string", () => {
    // Same reasoning as a missing key: a visible `{count}` gets fixed, a silently
    // empty gap does not.
    expect(interpolate("Hi {a} {b}", { a: "1" })).toBe("Hi 1 {b}");
  });

  it("returns the template untouched when no params are passed at all", () => {
    expect(interpolate("Hi {a}")).toBe("Hi {a}");
  });

  it("treats a value containing $& as literal text, not as a replacement pattern", () => {
    // A translated string is user-visible data. If the substitution used a string
    // replacement instead of a function, a param carrying "$&" or "$'" would
    // splice parts of the template back into the output.
    expect(interpolate("{a}", { a: "$& and $' and $`" })).toBe("$& and $' and $`");
  });

  it("substitutes the inner braces of a doubled placeholder", () => {
    // `{{name}}` is NOT an escape in this implementation — the inner `{name}` is
    // what matches. Pinned so that adopting `{{ }}` syntax is a conscious change.
    expect(interpolate("{{name}}", { name: "x" })).toBe("{x}");
  });

  it("leaves a placeholder with non-word characters alone", () => {
    // The pattern is `\w+`. `{a.b}` and `{ a }` are not placeholders.
    expect(interpolate("{a.b} { a }", { "a.b": "x", a: "y" })).toBe("{a.b} { a }");
  });

  it("does not escape HTML in a substituted value", () => {
    // Deliberate: the renderer (React, or the theme's escaping) owns escaping.
    // Escaping here would double-escape every string that reaches JSX. Pinned so
    // that anyone piping this into `dangerouslySetInnerHTML` sees the contract.
    expect(interpolate("{a}", { a: "<b>" })).toBe("<b>");
  });
});

describe("negotiateLocale", () => {
  it("picks the exact locale the client asked for", () => {
    expect(negotiateLocale("vi", ["en", "vi"])).toBe("vi");
  });

  it("picks the highest quality-weighted language, not the first listed", () => {
    // q-values are the whole point of the header; ignoring them serves the wrong
    // language to anyone whose browser lists a preference order.
    expect(negotiateLocale("fr;q=0.5,vi;q=0.9", ["en", "vi"])).toBe("vi");
  });

  it("serves a regional request from the language catalogue", () => {
    expect(negotiateLocale("vi-VN,vi;q=0.9", ["en", "vi"])).toBe("vi");
  });

  it("matches the header case-insensitively", () => {
    expect(negotiateLocale("VI-vn", ["en", "vi"])).toBe("vi");
  });

  it("ignores a language the client explicitly refused with q=0", () => {
    // `q=0` means "not acceptable". Serving it anyway is the opposite of what
    // the client said.
    expect(negotiateLocale("vi;q=0, en", ["en", "vi"])).toBe("en");
  });

  it("falls back to English for an unsupported language instead of failing", () => {
    // A client with an exotic Accept-Language wants an answer in English, not a
    // 406 on an API error message.
    expect(negotiateLocale("ja,ko;q=0.8", ["en", "vi"])).toBe("en");
  });

  it("falls back when there is no header at all", () => {
    expect(negotiateLocale(undefined, ["en", "vi"])).toBe("en");
    expect(negotiateLocale(null, ["en", "vi"])).toBe("en");
    expect(negotiateLocale("", ["en", "vi"])).toBe("en");
  });

  it("honours a caller-supplied fallback", () => {
    expect(negotiateLocale("ja", ["en", "vi"], "vi")).toBe("vi");
  });

  it("only ever returns a locale from the supported list", () => {
    // THE SECURITY PROPERTY. This value is chosen by a stranger's request header
    // and then flows into `<html lang>` and into catalogue lookups. It must be
    // one of ours, whatever the header says.
    const supported = ["en", "vi"];
    const hostile = [
      "../../etc/passwd",
      "<script>alert(1)</script>",
      "__proto__",
      "constructor",
      "en/../../../../etc/passwd",
      " en",
      "en;q=x",
      ";;;;",
      "*",
    ];

    for (const header of hostile) {
      expect(supported).toContain(negotiateLocale(header, supported));
    }
  });

  it("does not let a hostile header knock the negotiator over", () => {
    // Called on every API request. A throw here is a denial of service.
    expect(() => negotiateLocale("a".repeat(10_000) + ";q=NaN", ["en"])).not.toThrow();
  });
});
