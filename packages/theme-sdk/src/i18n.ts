/**
 * Theme translations.
 *
 * A theme's strings are the theme's own. They are deliberately NOT part of the
 * core catalogue (`@zcmsorg/i18n`), for two reasons:
 *
 *   - A theme is installed and removed independently of the platform. If its
 *     strings lived in core, translating a theme would mean shipping a release of
 *     Z-CMS, and removing a theme would leave dead keys behind forever.
 *   - The two have different translators. Whoever localises "Read more" for a
 *     magazine theme is not the person who localises "Row-Level Security is not
 *     enabled on this table".
 *
 * So a theme carries its own messages, keyed by locale, and reads them through
 * `ctx.t`. Core never sees them, and a theme that ships no translation at all
 * still works — `t` falls back to the base locale, then to the key.
 *
 *   defineTheme({
 *     manifest,
 *     messages: { en, vi },      // en is the base
 *     ...
 *   })
 *
 * A contributor adding Japanese to a theme adds `locales/ja.json` and one line to
 * `messages`. Nothing else in the theme changes, and core is not involved.
 */

/** Flat key -> string. Nested JSON is flattened to "a.b.c" on load. */
export type ThemeMessages = Record<string, string>;

/**
 * A locale file as it is authored: grouped by area, so a translator opening
 * `vi.json` sees the theme's screens rather than one long list of dotted keys.
 */
export type ThemeMessageTree = { [key: string]: string | ThemeMessageTree };

/** Locale code -> messages, e.g. `{ en, vi }`. */
export type ThemeMessageCatalog = Record<string, ThemeMessageTree>;

/** The base locale every theme must provide. Others fall back to it. */
export const THEME_BASE_LOCALE = "en";

export type Translate = (key: string, vars?: Record<string, string | number>) => string;

/**
 * Builds the `t` a theme sees.
 *
 * Resolution order is locale -> base locale -> the key itself. Returning the key
 * is deliberate: a missing translation must show up as an obviously untranslated
 * string, never as a blank space or a crash on a live page.
 */
export function createThemeTranslator(
  catalog: ThemeMessageCatalog | undefined,
  locale: string,
): Translate {
  const primary = flattenMessages(
    catalog?.[locale] ?? catalog?.[baseOf(locale)] ?? {},
  );
  const base = flattenMessages(catalog?.[THEME_BASE_LOCALE] ?? {});

  return (key, vars) => {
    const template = primary[key] ?? base[key] ?? key;
    return interpolate(template, vars);
  };
}

/** `{ archive: { readMore } }` -> `{ "archive.readMore": … }`. */
export function flattenMessages(
  tree: ThemeMessageTree,
  prefix = "",
): ThemeMessages {
  const flat: ThemeMessages = {};

  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") {
      flat[path] = value;
    } else {
      Object.assign(flat, flattenMessages(value, path));
    }
  }

  return flat;
}

/** "vi-VN" -> "vi": a region-less catalogue still serves a regional locale. */
function baseOf(locale: string): string {
  return locale.split("-")[0] ?? locale;
}

/** Replaces `{name}` placeholders. Unknown placeholders are left visible. */
export function interpolate(
  template: string,
  vars?: Record<string, string | number>,
): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in vars ? String(vars[name]) : match,
  );
}
