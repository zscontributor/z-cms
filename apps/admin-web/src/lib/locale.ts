import { BASE_LOCALE, isSupportedLocale, t as translator, type Translate } from "@zcmsorg/i18n";
import { cookies } from "next/headers";

/**
 * The admin's language, on the server.
 *
 * It lives in a cookie rather than in the URL: the admin is not a public site, so
 * there is nothing to index and no reason to fork every route into /en/… and
 * /vi/…. A cookie also survives a login redirect, which a query parameter does
 * not.
 *
 * English is the fallback, not Vietnamese — English is the base locale of the
 * catalogue, so it is the one language guaranteed to have every key.
 */
export const LOCALE_COOKIE = "zcms_locale";

export async function getLocale(): Promise<string> {
  const value = (await cookies()).get(LOCALE_COOKIE)?.value;
  return value && isSupportedLocale(value) ? value : BASE_LOCALE;
}

/** `const t = await getT(); t("content.list.empty")` */
export async function getT(): Promise<Translate> {
  return translator(await getLocale());
}
