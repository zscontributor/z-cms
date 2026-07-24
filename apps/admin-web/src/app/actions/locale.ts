"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { isSupportedLocale } from "@zcmsorg/i18n";
import { localeCookieOptions } from "@/lib/cookies";
import { LOCALE_COOKIE } from "@/lib/locale";

/**
 * The language is a cookie, so it takes a layout-level revalidate: the shell —
 * sidebar, topbar, page headers — renders on the server, and it is the most
 * visible half of the change. An unsupported code is ignored rather than stored;
 * the cookie is the input to every subsequent render and must never hold a value
 * the catalogue cannot serve.
 */
export async function setLocaleAction(locale: string): Promise<void> {
  if (!isSupportedLocale(locale)) return;

  const store = await cookies();
  store.set(LOCALE_COOKIE, locale, localeCookieOptions);

  revalidatePath("/", "layout");
}
