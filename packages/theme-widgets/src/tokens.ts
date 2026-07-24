import type { LayoutTokens } from "@zcmsorg/schemas";
import type { CSSProperties } from "react";

/**
 * Design tokens become CSS custom properties on the layout's root element, and
 * `widgets.css` reads them. Two reasons it is done this way rather than by
 * interpolating values into each widget's inline style:
 *
 *   - A token is set ONCE. A site owner who re-colours a drawn theme from the
 *     admin changes one variable, and every widget that referenced it follows —
 *     including the ones that had already been rendered into the tree above.
 *   - The stylesheet stays static. `widgets.css` ships as authored, with no
 *     build-time knowledge of any particular drawing, which is what lets one
 *     reviewed stylesheet serve every theme anyone ever draws.
 *
 * Every var has a fallback in the CSS, so a document that sets no tokens at all
 * still renders a legible page.
 */

export const TOKEN_VARS = {
  colorPrimary: "--zw-color-primary",
  colorText: "--zw-color-text",
  colorBackground: "--zw-color-background",
  fontHeading: "--zw-font-heading",
  fontBody: "--zw-font-body",
  radius: "--zw-radius",
  maxWidth: "--zw-max-width",
} as const satisfies Record<keyof LayoutTokens, string>;

/**
 * Turns tokens into a style object of CSS variables.
 *
 * A token the author left unset is OMITTED rather than emitted empty: an empty
 * custom property is still *set*, which defeats the `var(--x, fallback)` in the
 * stylesheet and yields an invalid declaration instead of the default.
 */
export function tokensToStyle(tokens: LayoutTokens | undefined): CSSProperties {
  const style: Record<string, string> = {};
  if (!tokens) return style as CSSProperties;

  if (tokens.colorPrimary) style[TOKEN_VARS.colorPrimary] = tokens.colorPrimary;
  if (tokens.colorText) style[TOKEN_VARS.colorText] = tokens.colorText;
  if (tokens.colorBackground) style[TOKEN_VARS.colorBackground] = tokens.colorBackground;
  if (tokens.fontHeading) style[TOKEN_VARS.fontHeading] = tokens.fontHeading;
  if (tokens.fontBody) style[TOKEN_VARS.fontBody] = tokens.fontBody;
  // 0 is a legitimate radius, so test for undefined rather than falsiness.
  if (tokens.radius !== undefined) style[TOKEN_VARS.radius] = `${tokens.radius}px`;
  if (tokens.maxWidth !== undefined) style[TOKEN_VARS.maxWidth] = `${tokens.maxWidth}px`;

  return style as CSSProperties;
}

/** The token keys a generated theme exposes as settings. Order is the form's order. */
export const TOKEN_KEYS = [
  "colorPrimary",
  "colorText",
  "colorBackground",
  "fontHeading",
  "fontBody",
  "radius",
  "maxWidth",
] as const satisfies readonly (keyof LayoutTokens)[];

/**
 * The tokens this SITE means, as opposed to the ones the theme was drawn with.
 *
 * A generated theme declares every token in its `settingsSchema`, so the admin
 * renders a form for them with no theme-specific code — and a site owner who
 * re-colours a downloaded theme changes a setting, not the drawing. The drawing's
 * own value is the default; a setting that has one wins.
 *
 * An empty string is NOT a value. The settings form writes "" when somebody clears
 * a field, and treating that as a colour would paint the site with an invalid
 * declaration instead of falling back to what the theme shipped.
 */
export function resolveTokens(
  base: LayoutTokens | undefined,
  settings: Record<string, unknown> | undefined,
): LayoutTokens {
  const out: LayoutTokens = { ...(base ?? {}) };
  if (!settings) return out;

  for (const key of TOKEN_KEYS) {
    const value = settings[key];
    if (value === undefined || value === null || value === "") continue;

    if (key === "radius" || key === "maxWidth") {
      const n = Number(value);
      if (Number.isFinite(n)) out[key] = n;
      continue;
    }
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

/** Reads a numeric prop, falling back when an old document omits it. */
export function numberProp(
  props: Record<string, unknown>,
  key: string,
  fallback: number,
): number {
  const value = Number(props[key]);
  return Number.isFinite(value) ? value : fallback;
}

/** Reads a string prop, falling back when an old document omits it. */
export function stringProp(
  props: Record<string, unknown>,
  key: string,
  fallback = "",
): string {
  const value = props[key];
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

/** Reads a boolean prop, falling back when an old document omits it. */
export function boolProp(
  props: Record<string, unknown>,
  key: string,
  fallback = false,
): boolean {
  const value = props[key];
  return typeof value === "boolean" ? value : fallback;
}
