import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import { hasFlag } from "../../scripts/flags-source";
import { FLAG_BASE, flagFor, flagUrl, looksLikeLanguageCode } from "../flags";
import { LOCALES } from "../locales";

/**
 * The flags flag-icons actually ships. Read from the package, not hardcoded:
 * the point of most of these tests is to catch a code this repo believes in and
 * the library does not.
 */
const require = createRequire(import.meta.url);
const AVAILABLE = new Set(
  readdirSync(
    join(dirname(require.resolve("flag-icons/package.json")), "flags", "4x3"),
  )
    .filter((f) => f.endsWith(".svg"))
    .map((f) => f.replace(/\.svg$/, "")),
);

describe("flagFor", () => {
  it("reads the region straight off a tag that carries one", () => {
    expect(flagFor("pt-BR")).toBe("br");
    expect(flagFor("en-US")).toBe("us");
    expect(flagFor("zh-Hant-HK")).toBe("hk");
  });

  it("prefers the tag's own region to the default for its language", () => {
    // `en` alone resolves to gb. That must not leak into en-AU.
    expect(flagFor("en")).toBe("gb");
    expect(flagFor("en-AU")).toBe("au");
  });

  it("distinguishes scripts that mean different places", () => {
    expect(flagFor("zh-Hans")).toBe("cn");
    expect(flagFor("zh-Hant")).toBe("tw");
  });

  it("gives a stateless language its own region's flag", () => {
    expect(flagFor("ca")).toBe("es-ct");
    expect(flagFor("cy")).toBe("gb-wls");
  });

  it("returns null for a language no country speaks for", () => {
    expect(flagFor("ar")).toBeNull();
    expect(flagFor("eo")).toBeNull();
  });

  it("returns null for a UN M.49 area rather than guessing a country", () => {
    // The trap: es-419 is Latin America. Falling through to `es` would fly the
    // flag of Spain at twenty countries that are not Spain.
    expect(flagFor("es-419")).toBeNull();
  });

  it("returns null for a language it has never heard of", () => {
    expect(flagFor("xx")).toBeNull();
  });

  it("does not confuse a language code with the country code it collides with", () => {
    // `lo` is Lao and its country is `la`. `la` is Latin and has no country —
    // and must never resolve to Laos.
    expect(flagFor("lo")).toBe("la");
    expect(flagFor("la")).toBeNull();

    // `sl` is Slovene (Slovenia, si); `sk` is Slovak (Slovakia, sk).
    expect(flagFor("sl")).toBe("si");
    expect(flagFor("sk")).toBe("sk");
  });

  describe("override", () => {
    it("wins over the derived flag", () => {
      expect(flagFor("en", "us")).toBe("us");
    });

    it("wins over NO_FLAG — an explicit choice is still a choice", () => {
      expect(flagFor("ar", "eg")).toBe("eg");
    });

    it("suppresses a flag when written as null", () => {
      expect(flagFor("en", null)).toBeNull();
    });

    it("is distinct from an absent field", () => {
      expect(flagFor("en", undefined)).toBe("gb");
      expect(flagFor("en", null)).toBeNull();
    });

    it("rejects a malformed code rather than emitting a broken URL", () => {
      expect(flagFor("en", "United Kingdom")).toBeNull();
      expect(flagFor("en", "GB")).toBeNull(); // lowercase, or nothing
    });
  });
});

describe("flagUrl", () => {
  it("builds a URL under the served prefix", () => {
    expect(flagUrl("vi")).toBe(`${FLAG_BASE}/vn.svg`);
  });

  it("is null, not a broken image, when there is no flag", () => {
    expect(flagUrl("ar")).toBeNull();
  });
});

describe("the default region table", () => {
  /**
   * The table is hand-written, so every value in it is a typo waiting to happen —
   * and a typo produces a broken image only for the people who read that
   * language. This is the test that makes that impossible: whatever the table
   * resolves to, flag-icons must actually ship.
   */
  it("only ever resolves to a flag flag-icons ships", () => {
    const languages = [
      "af","am","az","be","bg","bn","bs","ca","cs","cy","da","de","el","en","es",
      "et","eu","fa","fi","fr","ga","gd","gl","he","hi","hr","hu","hy","id","is",
      "it","ja","ka","kk","km","ko","ky","lo","lt","lv","mk","mn","ms","my","nb",
      "ne","nl","nn","no","pl","ps","pt","ro","ru","si","sk","sl","sq","sr","sv",
      "sw","tg","th","tk","tl","tr","uk","ur","uz","vi","zh","zh-Hans","zh-Hant",
      "sr-Latn",
    ];

    for (const code of languages) {
      const flag = flagFor(code);
      expect(flag, `${code} resolved to no flag`).not.toBeNull();
      expect(AVAILABLE.has(flag!), `${code} -> ${flag}.svg does not exist`).toBe(true);
    }
  });

  it("resolves every locale Z-CMS ships to a flag that exists, or to none", () => {
    for (const locale of LOCALES) {
      if (locale.flag === null) continue;
      expect(
        AVAILABLE.has(locale.flag),
        `${locale.code} -> ${locale.flag}.svg does not exist`,
      ).toBe(true);
    }
  });
});

describe("the registry guard", () => {
  /**
   * `hasFlag` is the check `sync` runs over every entry in locales.json, and the
   * only thing standing between a contributor's typo and a broken image that
   * appears exclusively for the people who read that language — which is to say,
   * never for the person who wrote the typo, nor for whoever reviewed the PR.
   */
  it("accepts a real country code", () => {
    expect(hasFlag("vn")).toBe(true);
    expect(hasFlag("gb")).toBe(true);
  });

  it("rejects a code that is not a country at all", () => {
    // Vietnam is `vn`. `vm` is nothing.
    expect(hasFlag("vm")).toBe(false);
    expect(hasFlag("ja")).toBe(false);
  });

  it("cannot, on its own, catch a language code that is also a real country", () => {
    // This is the reason `looksLikeLanguageCode` exists, and it is worth pinning:
    // `vi` IS a flag — the US Virgin Islands. An existence check waves it
    // through, and every Vietnamese reader gets the wrong flag.
    expect(hasFlag("vi")).toBe(true);
    expect(hasFlag("si")).toBe(true); // Sinhala -> Slovenia
    expect(hasFlag("sv")).toBe(true); // Swedish -> El Salvador
  });

  it("agrees with the resolver about every locale in the registry", () => {
    // The two halves of the guard, composed exactly as `sync` composes them.
    for (const locale of LOCALES) {
      const flag = flagFor(locale.code, locale.flag);
      if (flag === null) continue;
      expect(hasFlag(flag), `${locale.code} -> ${flag}.svg`).toBe(true);
    }
  });
});

describe("looksLikeLanguageCode", () => {
  /**
   * The half of the guard that `hasFlag` cannot cover: a flag code that exists,
   * is spelled correctly, and belongs to the wrong country entirely because the
   * contributor typed the language.
   */
  it("catches a language code that is a real country somewhere else", () => {
    expect(looksLikeLanguageCode("vi", "vi")).toBe(true); // US Virgin Islands
    expect(looksLikeLanguageCode("si", "si")).toBe(true); // Slovenia
    expect(looksLikeLanguageCode("sv", "sv")).toBe(true); // El Salvador
    expect(looksLikeLanguageCode("bn", "bn")).toBe(true); // Brunei
    expect(looksLikeLanguageCode("ne", "ne")).toBe(true); // Niger
    expect(looksLikeLanguageCode("et", "et")).toBe(true); // Ethiopia
  });

  it("stays quiet when a language's code legitimately IS its country's", () => {
    // The false positives this rule must not produce. German is `de` and Germany
    // is `de`; writing it out is redundant, not wrong, and must not fail CI.
    for (const code of ["de", "it", "fr", "pt", "es", "pl", "ru", "no", "sk"]) {
      expect(looksLikeLanguageCode(code, code), `${code} tripped the rule`).toBe(false);
    }
  });

  it("stays quiet on a deliberate override that is not the language code", () => {
    expect(looksLikeLanguageCode("en", "us")).toBe(false);
    expect(looksLikeLanguageCode("ar", "eg")).toBe(false);
  });

  it("looks at the language subtag, not the whole tag", () => {
    expect(looksLikeLanguageCode("vi-VN", "vi")).toBe(true);
  });
});
