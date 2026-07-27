import { describe, expect, it } from "vitest";
import {
  langFromEnv,
  normalizeLang,
  resolveLang,
  unknownCommand,
  usage,
  type Lang,
} from "../help";

/**
 * The help text is the CLI's whole user manual — it is what an author reads
 * before they know any of the flags. Two things must hold: the language is
 * resolved the way the docs promise, and no translation quietly drops a command.
 */

const LANGS: Lang[] = ["en", "ja", "vi"];

describe("normalizeLang", () => {
  it("accepts the codes and the country-style spellings an author might type", () => {
    expect(normalizeLang("en")).toBe("en");
    expect(normalizeLang("ENG")).toBe("en");
    expect(normalizeLang("ja")).toBe("ja");
    expect(normalizeLang("JP")).toBe("ja"); // country code, not the language code
    expect(normalizeLang("vi")).toBe("vi");
    expect(normalizeLang("VN")).toBe("vi");
  });

  it("returns undefined for a language it does not have, rather than guessing", () => {
    expect(normalizeLang("fr")).toBeUndefined();
    expect(normalizeLang("")).toBeUndefined();
    expect(normalizeLang(undefined)).toBeUndefined();
  });
});

describe("langFromEnv", () => {
  it("takes ZCMS_LANG over the OS locale", () => {
    expect(langFromEnv({ ZCMS_LANG: "vi", LANG: "ja_JP.UTF-8" })).toBe("vi");
  });

  it("reads the language out of a POSIX locale", () => {
    expect(langFromEnv({ LANG: "ja_JP.UTF-8" })).toBe("ja");
    expect(langFromEnv({ LC_ALL: "vi_VN" })).toBe("vi");
  });

  it("ignores a locale that names no human language", () => {
    expect(langFromEnv({ LANG: "C" })).toBeUndefined();
    expect(langFromEnv({})).toBeUndefined();
  });
});

describe("resolveLang", () => {
  it("lets --lang win over the environment", () => {
    expect(resolveLang(["help", "--lang", "ja"], { ZCMS_LANG: "vi" })).toBe("ja");
  });

  it("falls back to the environment, then to English", () => {
    expect(resolveLang(["help"], { ZCMS_LANG: "vi" })).toBe("vi");
    expect(resolveLang(["help"], {})).toBe("en");
  });

  it("ignores an unrecognized --lang instead of failing", () => {
    // A typo'd language should still print help, in the default, not error out.
    expect(resolveLang(["help", "--lang", "fr"], {})).toBe("en");
  });
});

describe("usage", () => {
  it("defaults to English", () => {
    expect(usage()).toBe(usage("en"));
    expect(usage("en")).toContain("the packaging tool for Z-CMS");
  });

  it("renders each language in its own script", () => {
    expect(usage("ja")).toContain("パッケージ化するツール");
    expect(usage("vi")).toContain("công cụ đóng gói");
  });

  it("keeps every command signature identical across languages", () => {
    // The prose is translated; the things an author TYPES are not. If a flag is
    // added to one language and not the others, this fails loudly.
    const signatures = [
      "zcms init [<dir>] [--kind theme|plugin]",
      "zcms keygen [--out <dir>]",
      "zcms pack <dir> --kind theme|plugin --key <private.pem> --pub <public.pem> [--out <file>]",
      "[--bump patch|minor|major] [--no-bump] [--set-version <semver>]",
      "zcms verify <file.zcms> [--marketplace-key <public.pem>]",
      "zcms help [--lang en|ja|vi]",
    ];

    for (const lang of LANGS) {
      for (const signature of signatures) {
        expect(usage(lang)).toContain(signature);
      }
    }
  });

  it("documents --lang in every language's help", () => {
    for (const lang of LANGS) {
      expect(usage(lang)).toContain("--lang");
    }
  });
});

describe("unknownCommand", () => {
  it("echoes the mistyped command back in the chosen language", () => {
    expect(unknownCommand("frobnicate", "en")).toContain('"frobnicate"');
    expect(unknownCommand("frobnicate", "vi")).toContain("Lệnh không hợp lệ");
    expect(unknownCommand("frobnicate", "ja")).toContain("不明なコマンド");
  });
});
