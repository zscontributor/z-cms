import type { Messages, Translate } from "./types";

/**
 * The whole translation runtime, and it is deliberately this small.
 *
 * Z-CMS does not ship a heavyweight i18n framework because it does not need one:
 * a catalogue is a nested JSON object, a lookup is a dotted key, and the only
 * formatting a message needs is `{name}` substitution. Anything more (dates,
 * currency, relative time) is what `Intl` is for, and it is already in the
 * runtime.
 *
 * The rules that matter are the fallback rules, and they exist so that a missing
 * translation is never a broken page:
 *
 *   locale -> language without region -> base locale (en) -> the key itself
 *
 * Returning the key is the last resort on purpose. A key rendered on screen
 * ("content.editor.saveDraft") is ugly, obvious, and reported within the hour. A
 * blank string is none of those things, and it ships to production.
 */

export const BASE_LOCALE = "en";

export function createTranslator(
  catalog: Record<string, Messages>,
  locale: string,
): Translate {
  const chain = [
    catalog[locale],
    catalog[languageOf(locale)],
    catalog[BASE_LOCALE],
  ].filter(Boolean) as Messages[];

  return (key, vars) => {
    for (const messages of chain) {
      const value = lookup(messages, key);
      if (typeof value === "string") return interpolate(value, vars);
    }
    return key;
  };
}

/**
 * Flattens the fallback chain into one catalogue, ahead of time.
 *
 * `createTranslator` walks `locale -> language -> en` on every lookup, which is
 * right on the server, where the whole catalogue is in memory anyway. It is the
 * wrong shape for a browser: sending three catalogues so the client can walk them
 * means sending English to a Vietnamese user, forever, plus every other language
 * the project has ever accepted a PR for.
 *
 * So the fallback is resolved on the server and the *result* crosses the wire —
 * one locale, already complete. The client cannot tell the difference, and its
 * payload stops growing every time a translator opens a pull request.
 */
export function resolveMessages(
  catalog: Record<string, Messages>,
  locale: string,
): Messages {
  const layers = [
    catalog[BASE_LOCALE],
    catalog[languageOf(locale)],
    catalog[locale],
  ].filter(Boolean) as Messages[];

  const merged: Messages = {};
  for (const layer of layers) {
    if (layer === merged) continue;
    deepMerge(merged, layer);
  }
  return merged;
}

// Keys that name the prototype chain rather than a normal property. `JSON.parse`
// keeps a "__proto__" key as an OWN property (it does not run the setter), so a
// catalogue layer parsed from untrusted JSON — a theme's or plugin's message
// bundle — can carry one. Merging it would read `target["__proto__"]` back as
// Object.prototype and write the hostile sub-tree straight onto it, polluting
// every object in the process. These keys are never legitimate namespace names,
// so they are skipped outright.
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** Later layers win, key by key — which is exactly what "falls back" means. */
function deepMerge(target: Messages, source: Messages): void {
  for (const [key, value] of Object.entries(source)) {
    if (FORBIDDEN_KEYS.has(key)) continue;
    if (value && typeof value === "object") {
      const existing = target[key];
      const branch: Messages =
        existing && typeof existing === "object" ? existing : {};
      deepMerge(branch, value);
      target[key] = branch;
    } else {
      target[key] = value;
    }
  }
}

/**
 * A translator over one already-resolved catalogue — the client-side half.
 *
 * There is no fallback chain here because there is nothing left to fall back to:
 * `resolveMessages` already did it. A key that is missing from *this* object is
 * missing from English too, which is a bug in the code, not in a translation.
 */
export function createMessageTranslator(messages: Messages): Translate {
  return (key, vars) => {
    const value = lookup(messages, key);
    return typeof value === "string" ? interpolate(value, vars) : key;
  };
}

/** "vi-VN" -> "vi". A regional locale is served by its language catalogue. */
export function languageOf(locale: string): string {
  return locale.split("-")[0] ?? locale;
}

/**
 * Languages written right to left.
 *
 * Kept as a list rather than read from `Intl`, which does not expose text
 * direction anywhere a runtime can rely on: `Intl.Locale.prototype.textInfo` is
 * still not in every engine Z-CMS runs on, and getting `<html dir>` wrong renders
 * a page that a reader cannot use at all.
 *
 * These are the written-RTL languages, by ISO 639-1/-2. Script subtags override
 * the language: `ku-Latn` is written left to right and `az-Arab` right to left,
 * so the script — when there is one — is what decides.
 */
const RTL_LANGUAGES = new Set([
  "ar", // Arabic
  "arc", // Aramaic
  "ckb", // Kurdish, Sorani — written in Arabic script, unlike `ku` (Kurmanji)
  "dv", // Divehi
  "fa", // Persian
  "he", // Hebrew
  "ps", // Pashto
  "sd", // Sindhi
  "syr", // Syriac
  "ug", // Uyghur
  "ur", // Urdu
  "yi", // Yiddish
]);

// Not here, and deliberately: `az` (Azerbaijani) and `ku` (Kurmanji Kurdish) are
// written in Latin script by default and are LTR. They turn RTL only when the tag
// says so — `az-Arab` — which the script check above handles. Listing the bare
// language would flip every Azerbaijani page backwards.

const RTL_SCRIPTS = new Set(["Arab", "Aran", "Hebr", "Syrc", "Thaa", "Nkoo"]);
const LTR_SCRIPTS = new Set(["Latn", "Cyrl", "Grek", "Armn", "Geor"]);

/**
 * Which way a locale's text runs. Drives `<html dir>`.
 *
 * A locale nobody has heard of is `ltr` — the overwhelmingly more common case, and
 * the failure mode of guessing wrong in that direction is a page that reads oddly
 * rather than one that is unusable.
 */
export function directionOf(locale: string): "ltr" | "rtl" {
  const [language = "", ...rest] = locale.split("-");

  // A script subtag is explicit and beats the language default: Azerbaijani is
  // RTL in Arabic script and LTR in Latin, and only the tag says which.
  const script = rest.find((part) => part.length === 4);
  if (script) {
    if (RTL_SCRIPTS.has(script)) return "rtl";
    if (LTR_SCRIPTS.has(script)) return "ltr";
  }

  return RTL_LANGUAGES.has(language.toLowerCase()) ? "rtl" : "ltr";
}

/** Walks "content.editor.title" through the nested catalogue. */
function lookup(messages: Messages, key: string): unknown {
  let node: unknown = messages;
  for (const segment of key.split(".")) {
    if (typeof node !== "object" || node === null) return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  return node;
}

/**
 * Replaces `{name}` placeholders.
 *
 * An unknown placeholder is left in the string rather than replaced with "" —
 * same reasoning as a missing key: a visible `{count}` gets fixed, a silently
 * empty gap does not.
 */
export function interpolate(
  template: string,
  vars?: Record<string, string | number>,
): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in vars ? String(vars[name]) : match,
  );
}

/**
 * Picks the best supported locale for an `Accept-Language` header.
 *
 * Used by cms-api: an API error is a message a human reads, so it is translated
 * in the language the caller asked for. Quality values are honoured; an
 * unsupported language falls through to the base locale rather than 406-ing —
 * a client with an exotic Accept-Language wants an answer in English, not a
 * failure.
 */
export function negotiateLocale(
  header: string | undefined | null,
  supported: readonly string[],
  fallback: string = BASE_LOCALE,
): string {
  if (!header) return fallback;

  const ranked = header
    .split(",")
    .map((part) => {
      const [tag = "", ...params] = part.trim().split(";");
      const q = params
        .map((p) => p.trim())
        .find((p) => p.startsWith("q="))
        ?.slice(2);
      return { tag: tag.trim().toLowerCase(), q: q === undefined ? 1 : Number(q) || 0 };
    })
    .filter((entry) => entry.tag && entry.q > 0)
    .sort((a, b) => b.q - a.q);

  for (const { tag } of ranked) {
    const exact = supported.find((s) => s.toLowerCase() === tag);
    if (exact) return exact;

    const byLanguage = supported.find(
      (s) => languageOf(s.toLowerCase()) === languageOf(tag),
    );
    if (byLanguage) return byLanguage;
  }

  return fallback;
}
