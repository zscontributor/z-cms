import {
  resolveAssetUrl,
  resolveThemeIcons,
  type Theme,
  type ThemeIcons,
} from "@zcmsorg/theme-sdk";
import defaultTheme from "@zcmsorg/theme-default";
import { builtInAssetBase, loadTheme, type LoadedTheme } from "./theme-loader";

/**
 * Theme key + version -> theme package.
 *
 * The seam this file used to describe is now closed. A theme is no longer
 * something the runtime must have been *built* with: `resolveTheme` asks the
 * loader, which fetches the signed package, verifies it against the pinned
 * marketplace public key, unpacks it into a cache directory and imports it.
 * Installing a theme became data instead of a deploy.
 *
 * The default theme stays compiled in, deliberately. It is the fallback for
 * everything that can go wrong with a downloaded one — bad signature, missing
 * bundle, broken module, cms-api unreachable — so it must not itself depend on
 * any of that working.
 */

/** The theme a site falls back to. Guaranteed present, so rendering never dead-ends. */
export const DEFAULT_THEME_KEY = defaultTheme.manifest.id;

export function getDefaultTheme(): Theme<any> {
  return defaultTheme;
}

/**
 * The icons the platform falls back to: the default theme's, which are Z-CMS's.
 *
 * A theme is not obliged to ship icons, and one that ships none used to leave the
 * document with no <link rel="icon"> at all — so the browser fell back to its own
 * implicit request for `/favicon.ico`, got a 404, and the tab showed a blank page
 * glyph. "The CMS lost my favicon" is what that looks like from outside.
 *
 * Read off the default theme's own manifest rather than restated here: these paths
 * are the theme's to change, and a second copy of them is a second thing to keep in
 * step. They resolve against the built-in asset base — the same files the default
 * theme serves when it is the one rendering.
 */
export function platformIcons(): ThemeIcons {
  const base = builtInAssetBase(DEFAULT_THEME_KEY);
  const shipped = defaultTheme.manifest.seo?.icons ?? {};

  return resolveThemeIcons(shipped, (path) => resolveAssetUrl(base, path));
}

/**
 * The active theme's icons, with any the theme did not supply filled in from the
 * platform's.
 *
 * Field by field, not all-or-nothing: a theme that ships a favicon but no
 * apple-touch icon keeps its own favicon and borrows only the icon it lacks.
 * Anything the theme *did* declare wins — including a site owner's uploaded
 * favicon, which by this point `resolveSeo` has already folded in.
 */
export function withPlatformIcons(icons: ThemeIcons): ThemeIcons {
  return { ...platformIcons(), ...icons };
}

/**
 * Resolves the theme a site has activated.
 *
 * Never throws. A theme that will not load degrades to the default and reports
 * `degraded: true` — a site rendering the wrong theme deserves an alert; a site
 * rendering a 500 to every visitor is an outage.
 */
export async function resolveTheme(
  key: string | null | undefined,
  version: string | null | undefined,
  origin?: "BUILTIN" | "MARKETPLACE" | "SIDELOAD",
): Promise<LoadedTheme> {
  if (!key) {
    return {
      theme: defaultTheme,
      stylesheet: null,
      assetBase: builtInAssetBase(DEFAULT_THEME_KEY),
      degraded: true,
    };
  }

  return loadTheme(key, version ?? "0.0.0", origin);
}

/**
 * The theme compiled into this build — the fallback, and only the fallback.
 *
 * It is a shorter list than it sounds. The four themes we *ship* are all signed
 * packages now, loaded and verified like any other; being first-party buys them a
 * different key to be checked against, not an exemption from being checked. The one
 * below is different in kind: it is compiled into this bundle, so it is what renders
 * when everything else has failed, and it must not be able to fail the same way.
 */
export function listBuiltInThemeKeys(): string[] {
  return [DEFAULT_THEME_KEY];
}
