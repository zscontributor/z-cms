export * from "./types";
export * from "./translator";
export * from "./locales";
export * from "./flags";
export * from "./catalog";

import { catalog } from "./catalog";
import { createTranslator, resolveMessages } from "./translator";
import type { Messages, Translate } from "./types";

/**
 * The core translator, bound to the shipped catalogue.
 *
 * This covers Z-CMS itself: the admin, the API's error messages, the public
 * runtime's own chrome. It does NOT cover themes — a theme carries its own
 * messages and reads them through `ctx.t` (see `@zcmsorg/theme-sdk`). The two are
 * separate on purpose: a theme is installed and translated independently of the
 * platform, and its strings must not need a Z-CMS release to change.
 */
export function t(locale: string): Translate {
  return createTranslator(catalog, locale);
}

/**
 * One locale's messages, with the English fallback already folded in.
 *
 * This is what a server component hands to `LocaleProvider`, and it is the only
 * catalogue data that should ever cross into a browser. Its size is a function of
 * how much text the admin contains — not of how many languages the project has
 * accepted, which is the number that grows.
 */
export function messagesFor(locale: string): Messages {
  return resolveMessages(catalog, locale);
}
