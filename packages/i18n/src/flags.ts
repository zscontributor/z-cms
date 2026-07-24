/**
 * A flag for a locale — where one honestly exists.
 *
 * Flags are a famously bad way to name a language: a language is not a country.
 * `en` is spoken in dozens of them, `ar` in twenty, `zh` is written two ways
 * across four jurisdictions, and `eo` has no country at all. A switcher that
 * shows only a flag forces a reader to answer "which country owns my language",
 * and for most of the planet the answer is "none of these".
 *
 * So the flag here is never a label. Every surface that renders one renders it
 * *beside* the native name, which is the actual label, and stays correct when the
 * flag is absent. That is what makes this safe to have: the flag is a fast visual
 * anchor for the reader who already knows which row they are looking for, and it
 * carries no meaning that is lost when it resolves to nothing.
 *
 * Which is why `null` is a first-class answer here, not a failure. Arabic gets no
 * flag on purpose. That is a better outcome than picking Saudi Arabia and telling
 * every Egyptian, Moroccan and Iraqi reader that their language belongs to
 * someone else.
 *
 * This module is a pure function of the locale code and holds no table of its
 * own beyond the map below — no registry lookup, no I/O. It has to be, because
 * the locales it is asked about are not only the ones Z-CMS ships: a site's
 * languages are rows in a database and can be any BCP-47 tag at all.
 */

/**
 * The country whose flag stands for a bare language code.
 *
 * Only consulted when the tag does not carry its own region — `pt-BR` needs no
 * entry here, and never reads one. This is the answer to the narrower question
 * "a reader wrote `pt` with no region: which flag will not mislead them", and
 * that question does have a defensible answer for most languages.
 *
 * Keys are matched most-specific-first: full tag, then language+script, then
 * language. `zh-Hant` resolves to Taiwan rather than falling back to `zh`'s
 * China, because the script *is* the distinction being drawn.
 *
 * A language whose speakers are not concentrated in one country is deliberately
 * absent — see NO_FLAG. Absent means "no flag", not "not supported": the language
 * works exactly as well as any other, it just renders without one.
 */
const DEFAULT_REGION: Record<string, string> = {
  // Language + script, where the script is the whole point of the distinction.
  "zh-Hans": "cn",
  "zh-Hant": "tw",
  "sr-Latn": "rs",

  af: "za",
  am: "et",
  az: "az",
  be: "by",
  bg: "bg",
  bn: "bd",
  bs: "ba",
  cs: "cz",
  da: "dk",
  de: "de",
  el: "gr",
  et: "ee",
  fa: "ir",
  fi: "fi",
  fr: "fr",
  ga: "ie",
  he: "il",
  hi: "in",
  hr: "hr",
  hu: "hu",
  hy: "am",
  id: "id",
  is: "is",
  it: "it",
  ja: "jp",
  ka: "ge",
  kk: "kz",
  km: "kh",
  ko: "kr",
  ky: "kg",
  // The language is `lo`, the country is `la`. They are not typos for each other.
  lo: "la",
  lt: "lt",
  lv: "lv",
  mk: "mk",
  mn: "mn",
  ms: "my",
  my: "mm",
  nb: "no",
  ne: "np",
  nl: "nl",
  nn: "no",
  no: "no",
  pl: "pl",
  ps: "af",
  ro: "ro",
  ru: "ru",
  si: "lk",
  sk: "sk",
  // Slovene is `sl` and lives in `si`; Slovak is `sk` and lives in `sk`. The two
  // are a classic swap, and swapping them is invisible until a user complains.
  sl: "si",
  sq: "al",
  sr: "rs",
  sv: "se",
  sw: "tz",
  tg: "tj",
  th: "th",
  tk: "tm",
  tl: "ph",
  tr: "tr",
  uk: "ua",
  ur: "pk",
  uz: "uz",
  vi: "vn",
  zu: "za",

  // Stateless languages with a flag anyway: these have a *region* flag, which is
  // the honest one. A Catalan reader is not looking for the flag of Spain.
  ca: "es-ct",
  cy: "gb-wls",
  eu: "es-pv",
  gd: "gb-sct",
  gl: "es-ga",

  // Pluricentric, but with one country so dominant that the flag reads as the
  // language rather than as a claim about it. Any of these can be overridden per
  // locale in locales.json, and `en-US` / `pt-BR` never reach this map at all.
  en: "gb",
  es: "es",
  pt: "pt",
  zh: "cn",
};

/**
 * Languages that get no flag, on purpose, and must not acquire one by accident.
 *
 * Every entry is a language whose speakers span enough countries that choosing
 * one of them is a political statement rather than a UI decision. The flag column
 * is simply empty for these — which the UI already handles, because a flag is
 * never the thing that names the row.
 *
 * This exists as a set rather than as "absent from DEFAULT_REGION" so that the
 * silence is documented. Otherwise the next person to extend the map sees a gap
 * where Arabic should be, assumes an oversight, and helpfully fills it in.
 */
const NO_FLAG = new Set([
  "ar", // 20+ countries, no plausible representative
  "eo", // constructed, deliberately nobody's
  "ia", // constructed
  "ku", // stateless, and the flag is contested
  "la", // dead, and `la` is also Laos — an especially bad accident to allow
  "yi", // stateless
]);

/** ISO 3166-1 alpha-2, lowercase — or a flag-icons subdivision like `gb-sct`. */
const REGION = /^[a-z]{2}(-[a-z]{2,3})?$/;

/**
 * The country code whose flag represents this locale, or null if none honestly
 * does.
 *
 * `override` is what a contributor wrote in locales.json — it wins over
 * everything, including NO_FLAG, because someone who typed a flag code into the
 * registry has made a decision and does not need this module to second-guess it.
 * An explicit `null` there is also a decision, and also wins.
 *
 * Resolution, in order:
 *   1. the override, if the field was written at all
 *   2. the tag's own region subtag — `pt-BR` is Brazil, and nothing else to say
 *   3. the map above, most-specific key first
 *   4. null
 */
export function flagFor(
  locale: string,
  override?: string | null,
): string | null {
  // `undefined` means "the field was not written"; `null` means "written, empty".
  if (override !== undefined) {
    return override && REGION.test(override) ? override : null;
  }

  const parts = locale.split("-");
  const language = parts[0]!.toLowerCase();
  const subtags = parts.slice(1);

  // A region subtag answers the question outright. `en-US` is the United States
  // to everyone who reads it, whatever `en` alone might have resolved to.
  const region = subtags.find((p) => /^[A-Za-z]{2}$/.test(p));
  if (region) return region.toLowerCase();

  // ...unless the region is a UN M.49 area rather than a country. `es-419` is
  // Spanish as spoken across Latin America — twenty countries, which is the very
  // thing NO_FLAG exists for. Falling through to `es` here would answer a
  // question about a continent with the flag of Spain.
  if (subtags.some((p) => /^\d{3}$/.test(p))) return null;

  if (NO_FLAG.has(language)) return null;

  const script = subtags.find((p) => /^[A-Za-z]{4}$/.test(p));
  if (script) {
    const scripted =
      DEFAULT_REGION[
        `${language}-${script[0]!.toUpperCase()}${script.slice(1).toLowerCase()}`
      ];
    if (scripted) return scripted;
  }

  return DEFAULT_REGION[language] ?? null;
}

/**
 * Did someone write the *language* code where the *country* code belongs?
 *
 * Checking that the flag file exists is not enough to catch this, and that is not
 * an oversight in the check — it is a genuinely nasty collision. A great many
 * language codes are also the country code of an unrelated country:
 *
 *   vi  Vietnamese  ->  VI is the US Virgin Islands
 *   si  Sinhala     ->  SI is Slovenia
 *   sv  Swedish     ->  SV is El Salvador
 *   bn  Bengali     ->  BN is Brunei
 *   ne  Nepali      ->  NE is Niger
 *   et  Estonian    ->  ET is Ethiopia
 *
 * So `"flag": "vi"` for Vietnamese passes every existence check there is and
 * quietly flies the Virgin Islands at every Vietnamese reader. Nobody who speaks
 * English notices, and the person who made the mistake sees a flag appear and
 * concludes it worked.
 *
 * The rule: the override equals the locale's own language subtag, *and* it
 * disagrees with what the code derives on its own. Both halves matter — the
 * second is what keeps this quiet for the many languages whose code legitimately
 * is their country's (`de` -> Germany, `it` -> Italy, `fr` -> France). Those
 * derive to the same value and never trip it.
 */
export function looksLikeLanguageCode(locale: string, flag: string): boolean {
  const language = locale.split("-")[0]!.toLowerCase();
  if (flag.toLowerCase() !== language) return false;
  return flagFor(locale) !== flag.toLowerCase();
}

/**
 * Where the SVGs are served from, in both the admin and every public site.
 *
 * The flags are static files under each app's `public/`, not an import: a browser
 * fetches the two or three that a switcher actually renders, and the other 268
 * cost nothing but disk. Bundling them — or shipping flag-icons' stylesheet,
 * which references all of them — would send a quarter of a megabyte of Andorra to
 * a reader who wanted Vietnamese.
 *
 * They are copied into place by `scripts/sync-flags.ts` at build time. The path
 * is part of the platform's contract with a theme, which is why it is stated once
 * here rather than string-built at each call site.
 */
export const FLAG_BASE = "/z-flags";

/** The URL of a locale's flag, or null when it has none. */
export function flagUrl(
  locale: string,
  override?: string | null,
): string | null {
  const code = flagFor(locale, override);
  return code ? `${FLAG_BASE}/${code}.svg` : null;
}
