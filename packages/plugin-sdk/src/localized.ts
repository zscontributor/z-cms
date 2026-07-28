/**
 * A label a plugin (or a content type) may ship in more than one language.
 *
 * Two shapes, one resolver. A plain string is a label that does not translate —
 * the common case, and it passes through untouched, so every manifest written
 * before this existed keeps working. A `{ en, vi, ja, … }` map is a label that
 * does, keyed by locale exactly like `changelog` already is, and resolved for a
 * reader by the same locale → base → English → first-present order the theme
 * translator and the changelog use. Resolution is deliberately at READ time: the
 * manifest is stored verbatim, and one installed plugin serves every language.
 */

export type LocalizedString = string | Record<string, string>;

/** The locale a `{en,…}` map falls back to when a reader's own is absent. */
const FALLBACK_LOCALE = "en";

/** "vi-VN" -> "vi": a region-less label still serves a regional reader. */
function baseLocale(locale: string): string {
  return locale.split("-")[0] ?? locale;
}

export function isLocalizedObject(value: unknown): value is Record<string, string> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value as Record<string, unknown>).every((v) => typeof v === "string")
  );
}

/**
 * The label to show a reader in `locale`: their exact locale, then its region-less
 * base, then English, then whatever the map does carry. A plain string returns
 * unchanged; an empty/absent value returns "" so a caller never renders `undefined`.
 */
export function resolveLocalized(value: LocalizedString | undefined, locale: string): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  return (
    value[locale] ??
    value[baseLocale(locale)] ??
    value[FALLBACK_LOCALE] ??
    Object.values(value)[0] ??
    ""
  );
}

/**
 * True when a value is a usable localized label: a non-empty string, or a map
 * carrying a non-empty `en` (the one locale every label must supply, mirroring
 * the changelog rule). Used by manifest/content validation.
 */
export function isValidLocalizedLabel(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  if (isLocalizedObject(value)) {
    return typeof value.en === "string" && value.en.trim().length > 0;
  }
  return false;
}
