import { describe, expect, it } from "vitest";
import {
  MAX_CHANGELOG_LENGTH,
  MAX_CHANGELOG_LOCALES,
  MAX_DESCRIPTION_LENGTH,
  MAX_ID_LENGTH,
  MAX_NAME_LENGTH,
  assertManifestIdentity,
  normalizeChangelog,
  resolveChangelog,
  validateChangelog,
  validateId,
  validateManifestIdentity,
  validateText,
} from "../manifest-rules";
import { PackageError } from "../types";

/**
 * Before this file existed, the only check a package name ever got, anywhere in
 * the platform, was `if (!name.trim())`. The marketplace then wrote it into a
 * Postgres TEXT column — no length, no character class, no server-side check at
 * all — and rendered it in the admin.
 *
 * So the tests come in two halves, and the second is as important as the first:
 * what must be refused, and what must NOT be. A validator that rejects Vietnamese
 * is not a stricter validator, it is a broken one — and it is the kind of thing
 * that gets the whole rule reverted the week after it ships.
 */

const ok = {
  id: "com.acme.plugin.hello",
  name: "Hello",
  version: "1.0.0",
  author: { name: "Acme", url: "https://acme.example" },
  description: "A plugin.",
};

describe("id — an identifier, so it has a shape", () => {
  it("accepts a reverse-DNS id", () => {
    expect(validateId("com.acme.plugin.hello")).toBeNull();
  });

  it.each([
    ["empty", ""],
    ["not reverse-DNS", "hello"],
    ["only two segments", "com.hello"],
    ["uppercase", "com.Acme.plugin.Hello"],
    ["a path traversal", "../../etc/passwd"],
    ["a space", "com.acme.plugin hello"],
    ["a slash", "com/acme/plugin"],
  ])("refuses one that is %s", (_label, id) => {
    expect(validateId(id)).not.toBeNull();
  });

  it(`refuses one longer than ${MAX_ID_LENGTH} characters`, () => {
    const long = `com.acme.plugin.${"a".repeat(MAX_ID_LENGTH)}`;
    expect(validateId(long)).toMatch(/limit is 128/);
  });

  /** It is a directory name and a URL segment. A number is neither. */
  it("refuses a non-string", () => {
    expect(validateId(42 as unknown as string)).not.toBeNull();
  });
});

describe("name — human text, so it is bounded, not restricted", () => {
  it("accepts an ordinary name", () => {
    expect(validateText("name", "SEO Toolkit Pro", MAX_NAME_LENGTH, true)).toBeNull();
  });

  /**
   * The test that keeps this rule honest. An author who writes Vietnamese must
   * be able to name their plugin in Vietnamese. Restricting `name` to [a-zA-Z0-9]
   * would be the easy rule and the wrong one — `name` is a heading, not a key.
   */
  it.each(["Bộ lọc bình luận", "Тема", "テーマ", "Filtre à commentaires", "Emoji 🎨 Picker"])(
    "accepts %s",
    (name) => {
      expect(validateText("name", name, MAX_NAME_LENGTH, true)).toBeNull();
    },
  );

  it("requires one", () => {
    expect(validateText("name", "   ", MAX_NAME_LENGTH, true)).toMatch(/required/);
  });

  it(`refuses one longer than ${MAX_NAME_LENGTH} characters`, () => {
    expect(validateText("name", "a".repeat(61), MAX_NAME_LENGTH, true)).toMatch(/limit is 60/);
  });

  /**
   * Length is counted in code points. `"👨‍👩‍👧".length` is 8 in JavaScript, and
   * telling an author their short name is too long is how a tool loses trust.
   */
  it("measures length in characters, not UTF-16 units", () => {
    expect(validateText("name", "👨‍👩‍👧👦 Family", MAX_NAME_LENGTH, true)).toBeNull();
  });
});

describe("name — text that is not text", () => {
  it("refuses a newline, which would break every log line and table row", () => {
    const error = validateText("name", "Innocent\nAdmin", MAX_NAME_LENGTH, true);
    expect(error).toMatch(/line break \(U\+000A\)/);
  });

  /**
   * A zero-width space makes two different names look identical to every human
   * who reads them. That is not a rendering quirk, it is the entire reason to
   * put one in a name.
   */
  it("refuses a zero-width space", () => {
    const error = validateText("name", "Strip\u200Be", MAX_NAME_LENGTH, true);
    expect(error).toMatch(/zero-width character \(U\+200B\)/);
  });

  /**
   * U+202E reverses the rendering of everything after it — the "Trojan Source"
   * trick. A name carrying one does not display as what it is, and neither does
   * the row it sits in.
   */
  it("refuses a right-to-left override", () => {
    const error = validateText("name", "Safe\u202Egnp.exe", MAX_NAME_LENGTH, true);
    expect(error).toMatch(/bidirectional override \(U\+202E\)/);
  });

  it("refuses a raw control character", () => {
    expect(validateText("name", "A\u0000B", MAX_NAME_LENGTH, true)).toMatch(/U\+0000/);
  });

  /**
   * The line this rule walks, and why it is drawn exactly here.
   *
   * U+200B (zero-width SPACE) is decoration and nothing needs it, so it is refused.
   * U+200D (zero-width JOINER) is invisible in precisely the same way — but Persian,
   * Hindi and Arabic need it to spell ordinary words, and every multi-person emoji is
   * built out of it. Refusing that to prevent a homograph in a DISPLAY field, when the
   * actual identifier (id) is already [a-z0-9.-], trades a large certain harm for a
   * small speculative one.
   */
  it.each([
    ["a zero-width joiner (emoji, Hindi)", "a\u200Db"],
    ["a zero-width non-joiner (Persian, Arabic)", "a\u200Cb"],
  ])("allows %s", (_label, name) => {
    expect(validateText("name", name, MAX_NAME_LENGTH, true)).toBeNull();
  });
});

describe("description — optional, but bounded", () => {
  it("allows it to be absent", () => {
    expect(validateText("description", undefined, MAX_DESCRIPTION_LENGTH, false)).toBeNull();
  });

  it("refuses a novel", () => {
    const error = validateText("description", "a".repeat(281), MAX_DESCRIPTION_LENGTH, false);
    expect(error).toMatch(/limit is 280/);
  });
});

describe("changelog — optional, multi-line, still safe", () => {
  it("allows it to be absent", () => {
    expect(validateText("changelog", undefined, MAX_CHANGELOG_LENGTH, false, true)).toBeNull();
  });

  it("allows line breaks and tabs — a changelog is a list", () => {
    const notes = "- Fixed the hero button\n- Removed a duplicate breadcrumb\n\t- Minor polish";
    expect(validateText("changelog", notes, MAX_CHANGELOG_LENGTH, false, true)).toBeNull();
  });

  it("still refuses a bidi override hidden among the newlines", () => {
    const error = validateText(
      "changelog",
      "- normal line\n- ‮evil line",
      MAX_CHANGELOG_LENGTH,
      false,
      true,
    );
    expect(error).toMatch(/U\+202E/);
  });

  it("refuses one longer than the limit", () => {
    const error = validateText("changelog", "a".repeat(2001), MAX_CHANGELOG_LENGTH, false, true);
    expect(error).toMatch(/limit is 2000/);
  });

  it("is validated as part of the manifest", () => {
    expect(validateManifestIdentity({ ...ok, changelog: "- One change\n- Another" })).toEqual([]);
    const errors = validateManifestIdentity({ ...ok, changelog: "a".repeat(2001) });
    expect(errors.join(" ")).toMatch(/changelog is 2001 characters/);
  });
});

describe("changelog — localized (an object keyed by locale)", () => {
  it("accepts a plain string as the English notes", () => {
    expect(validateChangelog("- Fixed the header")).toEqual([]);
  });

  it("accepts absence", () => {
    expect(validateChangelog(undefined)).toEqual([]);
    expect(validateChangelog(null)).toEqual([]);
  });

  it("accepts a locale map with English present", () => {
    expect(
      validateChangelog({ en: "- Fixed the header", vi: "- Sửa phần đầu trang" }),
    ).toEqual([]);
  });

  it("requires English when localized", () => {
    const errors = validateChangelog({ vi: "- Sửa phần đầu trang" });
    expect(errors.join(" ")).toMatch(/must include "en"/);
  });

  it("holds every locale to the same text rules — length", () => {
    const errors = validateChangelog({ en: "ok", vi: "a".repeat(2001) });
    expect(errors.join(" ")).toMatch(/changelog\.vi is 2001 characters/);
  });

  it("holds every locale to the same text rules — a bidi override in a translation", () => {
    const errors = validateChangelog({ en: "ok", ja: "- ‮evil line" });
    expect(errors.join(" ")).toMatch(/changelog\.ja contains .*U\+202E/);
  });

  it("refuses a key that is not a locale code", () => {
    const errors = validateChangelog({ en: "ok", "not a locale": "x" });
    expect(errors.join(" ")).toMatch(/not a valid locale code/);
  });

  it("accepts regional locales like pt-BR and zh-Hans", () => {
    expect(
      validateChangelog({ en: "ok", "pt-BR": "corrigido", "zh-Hans": "已修复" }),
    ).toEqual([]);
  });

  it("refuses a locale whose notes are empty", () => {
    const errors = validateChangelog({ en: "ok", vi: "   " });
    expect(errors.join(" ")).toMatch(/changelog\.vi is required/);
  });

  it("caps the number of locales", () => {
    const many: Record<string, string> = { en: "ok" };
    for (let i = 0; i < MAX_CHANGELOG_LOCALES; i += 1) many[`x${i}`] = "note";
    const errors = validateChangelog(many);
    expect(errors.join(" ")).toMatch(new RegExp(`limit is ${MAX_CHANGELOG_LOCALES}`));
  });

  it("refuses an array or other non-object", () => {
    expect(validateChangelog(["nope"]).join(" ")).toMatch(/must be either/);
    expect(validateChangelog(42).join(" ")).toMatch(/must be either/);
  });

  it("flows through the full manifest validation", () => {
    expect(
      validateManifestIdentity({ ...ok, changelog: { en: "- One change", vi: "- Một thay đổi" } }),
    ).toEqual([]);
    const errors = validateManifestIdentity({ ...ok, changelog: { vi: "- Một thay đổi" } });
    expect(errors.join(" ")).toMatch(/must include "en"/);
  });
});

describe("normalizeChangelog — one shape for every consumer", () => {
  it("reads a plain string as English", () => {
    expect(normalizeChangelog("- Fixed it")).toEqual({ en: "- Fixed it" });
  });

  it("trims and drops blank entries, and empties become null", () => {
    expect(normalizeChangelog({ en: " keep ", vi: "   " })).toEqual({ en: "keep" });
    expect(normalizeChangelog("   ")).toBeNull();
    expect(normalizeChangelog({ vi: "  " })).toBeNull();
  });

  it("returns null for absent or malformed values", () => {
    expect(normalizeChangelog(undefined)).toBeNull();
    expect(normalizeChangelog(null)).toBeNull();
    expect(normalizeChangelog(["nope"])).toBeNull();
  });
});

describe("resolveChangelog — locale → base → English → anything", () => {
  const notes = { en: "English", vi: "Tiếng Việt" };

  it("returns the reader's exact locale", () => {
    expect(resolveChangelog(notes, "vi")).toBe("Tiếng Việt");
  });

  it("falls back from a regional locale to its base", () => {
    expect(resolveChangelog(notes, "vi-VN")).toBe("Tiếng Việt");
  });

  it("falls back to English when the locale is missing", () => {
    expect(resolveChangelog(notes, "ja")).toBe("English");
  });

  it("falls back to any available notes when even English is missing", () => {
    expect(resolveChangelog({ vi: "Tiếng Việt" }, "ja")).toBe("Tiếng Việt");
  });

  it("returns null for an empty or absent changelog", () => {
    expect(resolveChangelog(null, "en")).toBeNull();
    expect(resolveChangelog(undefined, "en")).toBeNull();
  });
});

describe("the manifest as a whole", () => {
  it("passes a good one", () => {
    expect(validateManifestIdentity(ok)).toEqual([]);
  });

  /**
   * Every problem at once. An author fixing a manifest should learn everything
   * wrong with it in one go — not one field per `zcms pack`.
   */
  it("reports every problem, not just the first", () => {
    const errors = validateManifestIdentity({
      id: "nope",
      name: "a".repeat(100),
      version: "banana",
      author: { name: "" },
      description: "fine",
    });

    expect(errors).toHaveLength(4);
    expect(errors.join(" ")).toMatch(/not a valid package id/);
    expect(errors.join(" ")).toMatch(/limit is 60/);
    expect(errors.join(" ")).toMatch(/not a semantic version/);
    expect(errors.join(" ")).toMatch(/author\.name is required/);
  });

  /** The author's display name is rendered under every package title. */
  it("bounds author.name, which is what the catalogue renders", () => {
    const errors = validateManifestIdentity({ ...ok, author: { name: "A".repeat(81) } });
    expect(errors.join(" ")).toMatch(/author\.name is 81 characters/);
  });

  it("refuses an author that is a bare string", () => {
    const errors = validateManifestIdentity({ ...ok, author: "Acme" });
    expect(errors.join(" ")).toMatch(/author must be an object/);
  });

  it("throws a PackageError naming the manifest file", () => {
    expect(() => assertManifestIdentity({ ...ok, name: "x".repeat(99) }, "theme.json")).toThrow(
      PackageError,
    );
    expect(() => assertManifestIdentity({ ...ok, name: "x".repeat(99) }, "theme.json")).toThrow(
      /theme\.json/,
    );
  });

  it("does not throw on a good manifest", () => {
    expect(() => assertManifestIdentity(ok, "plugin.json")).not.toThrow();
  });
});
