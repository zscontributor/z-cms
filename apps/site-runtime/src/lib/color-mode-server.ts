import {
  DEFAULT_COLOR_MODE,
  resolveColorModes,
  resolveThemeSettings,
  type ColorModeContext,
} from "@zcmsorg/theme-sdk";
import { resolveDocumentPayload } from "./render-client";
import { resolveTheme } from "./theme-registry";

/**
 * Which colour modes the theme on THIS request supports.
 *
 * The document shell has to know before it can decide what to put in <head>: a
 * dark-only theme is forced dark, and a dual-mode one starts from the visitor's
 * stored choice. Getting that wrong is not cosmetic — offer a switch to a theme
 * that has one palette and the reader lands on a half-painted page.
 *
 * It costs no extra API call. `resolveDocumentPayload` goes through the same
 * React-cached resolve the page makes, and `resolveTheme` hands back a module that
 * is already loaded and cached in this process by the time a second request for it
 * arrives. The theme's manifest is data — reading it does not render anything.
 *
 * Failure is not fatal, and must not be. If cms-api is down or the theme cannot be
 * loaded, the page below will render its own error; the shell around it does not
 * also need to explode over a colour. The fallback is the ordinary case — both
 * modes, follow the OS — which is the right answer for the default theme the
 * runtime will have fallen back to anyway.
 */
export async function resolveDocumentColorMode(): Promise<ColorModeContext> {
  try {
    const payload = await resolveDocumentPayload();
    if (!payload) return DEFAULT_COLOR_MODE;

    const { theme } = await resolveTheme(
      payload.theme.key,
      payload.theme.version,
      payload.theme.origin,
    );

    // The owner's chosen starting mode lives in the theme's settings, so it has to
    // be merged against the schema defaults first — a site that has never opened the
    // Appearance screen has no stored value at all, and the theme's own default is
    // what should apply.
    const settings = resolveThemeSettings<Record<string, unknown>>(
      theme.manifest.settingsSchema,
      payload.theme.settings,
    );

    return resolveColorModes(theme.manifest, settings);
  } catch {
    return DEFAULT_COLOR_MODE;
  }
}
