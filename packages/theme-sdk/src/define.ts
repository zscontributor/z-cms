import type { Theme, ThemeManifest, ThemeSettingsSchema } from "./types";

/**
 * Declares a theme. The only entry point a theme package needs.
 *
 *   export default defineTheme({ manifest, Layout, templates, blocks })
 */
export function defineTheme<S = Record<string, unknown>>(theme: Theme<S>): Theme<S> {
  return theme;
}

/**
 * Fills in a theme's settings from its schema defaults.
 *
 * Stored settings are a partial JSONB blob: a site saved before a theme added a
 * new option simply has no value for it. Merging against the schema defaults at
 * read time means a theme upgrade never has to migrate every site's settings
 * row, and a template can read `settings.primaryColor` without a null check.
 */
export function resolveThemeSettings<S = Record<string, unknown>>(
  schema: ThemeSettingsSchema,
  stored: Record<string, unknown> | null | undefined,
): S {
  const resolved: Record<string, unknown> = {};

  for (const [key, def] of Object.entries(schema.properties ?? {})) {
    const value = stored?.[key];
    resolved[key] = value === undefined || value === null ? def.default : value;
  }

  return resolved as S;
}
