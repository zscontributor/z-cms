import { CssColorSchema } from "@zcmsorg/schemas";
import type {
  BackgroundGradientPreset,
  BoxShadowPreset,
  LayoutTokens,
  NodeStyle,
} from "@zcmsorg/schemas";
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

// ---------------------------------------------------------------------------
// Per-node style.
//
// A node's `style` is the editor's design drawer, already bounded by NodeStyleSchema
// (@zcmsorg/schemas): every colour passed CssColorSchema, every number is in range,
// every preset is an enum. So this function trusts its input the same way the widget
// components trust `props` — the fence is the schema, not this map. A preset NAME is
// resolved to a FIXED declaration here; the author never supplied the CSS string.
// An unset field is omitted, never emitted empty, for the same reason tokensToStyle
// omits: an empty declaration is invalid and can drop the whole style attribute.
// ---------------------------------------------------------------------------

/** A shadow preset maps to one fixed, reviewed box-shadow. */
const BOX_SHADOW_VALUES: Record<BoxShadowPreset, string> = {
  none: "none",
  sm: "0 1px 2px rgba(0, 0, 0, 0.06)",
  md: "0 4px 12px rgba(0, 0, 0, 0.10)",
  lg: "0 10px 24px rgba(0, 0, 0, 0.14)",
  xl: "0 20px 48px rgba(0, 0, 0, 0.18)",
};

/** A gradient preset maps to one fixed, reviewed linear-gradient. */
const GRADIENT_VALUES: Record<Exclude<BackgroundGradientPreset, "none">, string> = {
  sunset: "linear-gradient(135deg, #ff9a9e 0%, #fad0c4 100%)",
  ocean: "linear-gradient(135deg, #2193b0 0%, #6dd5ed 100%)",
  twilight: "linear-gradient(135deg, #4568dc 0%, #b06ab3 100%)",
  mint: "linear-gradient(135deg, #d4fc79 0%, #96e6a1 100%)",
  slate: "linear-gradient(135deg, #485563 0%, #29323c 100%)",
};

/** An easing name maps to a fixed timing function. */
const EASING_VALUES: Record<string, string> = {
  ease: "ease",
  "ease-in-out": "ease-in-out",
  linear: "linear",
  smooth: "cubic-bezier(.2, .8, .2, 1)",
};

/** The data attribute the runtime CSS keys its `:hover` rule off (see widgets.css). */
export const HOVER_ATTR = "data-zw-hover";

/**
 * True when a node declares a hover effect. The renderer marks such a node with
 * HOVER_ATTR so the static `:hover` rule in widgets.css applies — the same
 * "data attribute + reviewed stylesheet" pattern as reveal-on-target/color-mode,
 * with no per-theme CSS and no client JS.
 */
export function hasHover(style: NodeStyle | undefined): boolean {
  return (
    !!style &&
    (style.hoverTranslateY !== undefined || style.hoverScale !== undefined)
  );
}

/**
 * Turns a node's bounded `style` into an inline style object. Returns an empty
 * object when there is no style, so callers can always spread it. A gradient, when
 * set, wins over a solid `background` — they target the same CSS property and the
 * editor offers them as one "fill" choice.
 */
export function styleForNode(style: NodeStyle | undefined): CSSProperties {
  const out: Record<string, string> = {};
  if (!style) return out as CSSProperties;

  if (style.textColor) out.color = style.textColor;

  // Fills compose. With a background image present, the solid colour, gradient,
  // overlay and photo are expressed through ONE background-image list so the
  // shorthand can never clobber the picture — overlay on top (a flat wash that keeps
  // text legible), then any gradient, then the image; the solid colour sits beneath
  // as backgroundColor. Without an image the original solid/gradient behaviour is
  // left exactly as it was. The URL passed CssUrlSchema, so wrapping it in quotes is
  // safe; the replace is belt-and-suspenders against a `"` the fence already forbids.
  if (style.backgroundImage) {
    const layers: string[] = [];
    if (style.backgroundOverlay) {
      layers.push(`linear-gradient(0deg, ${style.backgroundOverlay}, ${style.backgroundOverlay})`);
    }
    if (style.backgroundGradient && style.backgroundGradient !== "none") {
      layers.push(GRADIENT_VALUES[style.backgroundGradient]);
    }
    layers.push(`url("${style.backgroundImage.replace(/"/g, "%22")}")`);
    out.backgroundImage = layers.join(", ");
    out.backgroundSize = style.backgroundSize ?? "cover";
    out.backgroundPosition = style.backgroundPosition ?? "center";
    out.backgroundRepeat = "no-repeat";
    if (style.background) out.backgroundColor = style.background;
  } else {
    if (style.background) out.background = style.background;
    if (style.backgroundGradient && style.backgroundGradient !== "none") {
      out.background = GRADIENT_VALUES[style.backgroundGradient];
    }
  }

  if (style.paddingX !== undefined) {
    out.paddingLeft = `${style.paddingX}px`;
    out.paddingRight = `${style.paddingX}px`;
  }
  if (style.paddingY !== undefined) {
    out.paddingTop = `${style.paddingY}px`;
    out.paddingBottom = `${style.paddingY}px`;
  }
  if (style.marginX !== undefined) {
    out.marginLeft = `${style.marginX}px`;
    out.marginRight = `${style.marginX}px`;
  }
  if (style.marginY !== undefined) {
    out.marginTop = `${style.marginY}px`;
    out.marginBottom = `${style.marginY}px`;
  }

  if (style.borderRadius !== undefined) out.borderRadius = `${style.borderRadius}px`;
  // A border needs all three or it shows nothing useful. Width drives it; style and
  // colour default to something visible so a width alone still draws a line.
  if (style.borderWidth !== undefined && style.borderWidth > 0) {
    out.borderWidth = `${style.borderWidth}px`;
    out.borderStyle = style.borderStyle && style.borderStyle !== "none" ? style.borderStyle : "solid";
    if (style.borderColor) out.borderColor = style.borderColor;
  } else if (style.borderStyle && style.borderStyle !== "none") {
    out.borderStyle = style.borderStyle;
    out.borderWidth = "1px";
    if (style.borderColor) out.borderColor = style.borderColor;
  }

  if (style.boxShadow) out.boxShadow = BOX_SHADOW_VALUES[style.boxShadow];

  if (style.fontSize !== undefined) out.fontSize = `${style.fontSize}px`;
  if (style.fontWeight) out.fontWeight = style.fontWeight;
  if (style.textAlign) out.textAlign = style.textAlign;
  if (style.lineHeight !== undefined) out.lineHeight = String(style.lineHeight);
  if (style.letterSpacing !== undefined) out.letterSpacing = `${style.letterSpacing}px`;
  if (style.opacity !== undefined) out.opacity = String(style.opacity);
  if (style.width !== undefined) {
    out.width = `${style.width}${style.widthUnit === "percent" ? "%" : "px"}`;
  }
  if (style.height !== undefined) {
    out.height = `${style.height}${style.heightUnit === "vh" ? "vh" : "px"}`;
  }
  if (style.minHeight !== undefined) out.minHeight = `${style.minHeight}px`;

  // --- Effects: transform, filter, custom shadow, transition, hover ---------
  // Each magnitude is composed into a property string the library owns. A custom
  // shadow (any of its fields set) overrides the preset above.
  const transform: string[] = [];
  if (style.translateX !== undefined || style.translateY !== undefined) {
    transform.push(`translate(${style.translateX ?? 0}px, ${style.translateY ?? 0}px)`);
  }
  if (style.rotate !== undefined) transform.push(`rotate(${style.rotate}deg)`);
  if (style.scale !== undefined) transform.push(`scale(${style.scale})`);
  if (transform.length > 0) out.transform = transform.join(" ");

  const filter: string[] = [];
  if (style.blur !== undefined) filter.push(`blur(${style.blur}px)`);
  if (style.brightness !== undefined) filter.push(`brightness(${style.brightness}%)`);
  if (style.saturate !== undefined) filter.push(`saturate(${style.saturate}%)`);
  if (filter.length > 0) out.filter = filter.join(" ");

  const hasCustomShadow =
    style.shadowX !== undefined ||
    style.shadowY !== undefined ||
    style.shadowBlur !== undefined ||
    style.shadowSpread !== undefined ||
    style.shadowColor !== undefined;
  if (hasCustomShadow) {
    const colour = style.shadowColor ?? "rgba(0, 0, 0, 0.2)";
    out.boxShadow = `${style.shadowX ?? 0}px ${style.shadowY ?? 0}px ${style.shadowBlur ?? 0}px ${style.shadowSpread ?? 0}px ${colour}`;
  }

  if (hasHover(style)) {
    const hover: string[] = [];
    if (style.hoverTranslateY !== undefined) hover.push(`translateY(${style.hoverTranslateY}px)`);
    if (style.hoverScale !== undefined) hover.push(`scale(${style.hoverScale})`);
    // Read by the `:hover` rule in widgets.css. A custom property is inert until a
    // reviewed selector uses it — the author never writes the selector.
    out["--zw-hover-transform"] = hover.length > 0 ? hover.join(" ") : "none";
    const duration = style.transitionDuration ?? 280;
    const easing = EASING_VALUES[style.transitionEasing ?? "ease"] ?? "ease";
    out.transition = `transform ${duration}ms ${easing}, filter ${duration}ms ${easing}, box-shadow ${duration}ms ${easing}`;
  }

  return out as CSSProperties;
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

/**
 * Reads a COLOUR prop and returns it only if it passes CssColorSchema — the same
 * fence the Style drawer applies. `props` is opaque data, so a colour typed straight
 * into a widget prop (a pager's page background, say) has not been validated by the
 * document schema the way `style` colours are; validating it here keeps a `url(...)`
 * or a second declaration from ever reaching an inline style.
 */
export function colorProp(props: Record<string, unknown>, key: string): string | undefined {
  const value = props[key];
  return typeof value === "string" && CssColorSchema.safeParse(value).success ? value : undefined;
}

/**
 * Reads an array-of-strings prop (e.g. a gallery's image URLs), keeping only the
 * string members. `props` is opaque data from the document, so a non-array or a
 * stray non-string entry is filtered out rather than trusted.
 */
export function stringArrayProp(props: Record<string, unknown>, key: string): string[] {
  const value = props[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}
