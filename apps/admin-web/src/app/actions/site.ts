"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import type { SiteBrand, SiteDto } from "@zcmsorg/schemas";
import { ApiError, apiFetch, can, getSession, listSites } from "@/lib/api";
import { SITE_COOKIE, siteCookieOptions } from "@/lib/cookies";
import { getT } from "@/lib/locale";

export type SiteActionResult =
  | { ok: true; message: string; site: SiteDto }
  | { ok: false; error: string };

function toMessage(error: unknown, fallback: string): string {
  // The API's 409s are the whole point of this: "that hostname is already in use"
  // is an answer the person can act on, and a generic "could not save" is not.
  if (error instanceof ApiError) return error.message;
  return fallback;
}

/**
 * Switching site changes the X-Site-Id on every subsequent request, so the whole
 * layout's data is stale afterwards. The client does the follow-up navigation
 * after this action returns, once the Set-Cookie response has landed.
 */
export async function switchSiteAction(input: FormData | string): Promise<void> {
  const siteId =
    typeof input === "string" ? input : String(input.get("siteId") ?? "");
  if (!siteId) return;

  const sites = await listSites();
  if (!sites.some((site) => site.id === siteId)) {
    throw new Error((await getT())("admin.siteSwitcher.notFound"));
  }

  const store = await cookies();
  store.set(SITE_COOKIE, siteId, siteCookieOptions);

  revalidatePath("/", "layout");
}

/**
 * Creates a site and the domain it answers on.
 *
 * The new site is DRAFT unless `publish` says otherwise — and DRAFT is the default
 * on purpose: a site serves nothing until someone publishes it, which is the window
 * in which a theme gets picked and a homepage gets written. The cost of that default
 * is that the domain 404s in the meantime, so the form says so out loud.
 */
export async function createSiteAction(input: {
  name: string;
  slug: string;
  hostname: string;
  defaultLocale: string;
  publish: boolean;
  brand: SiteBrand;
}): Promise<SiteActionResult> {
  const t = await getT();

  const user = await getSession();
  if (!user) return { ok: false, error: t("auth.session.expired") };
  if (!can(user, "site:create")) return { ok: false, error: t("admin.sites.errors.createDenied") };

  try {
    const site = await apiFetch<SiteDto>("/sites", {
      method: "POST",
      body: input,
      // There is no current site to scope this to — and if the tenant has none at
      // all, sending an X-Site-Id would be sending a header with no value.
      siteScoped: false,
    });

    revalidatePath("/sites");
    // The site switcher in the topbar is rendered by the layout, so a new site
    // does not appear in it until the layout's data is thrown away.
    revalidatePath("/", "layout");

    // Creation hands the admin straight to the new site's detail screen. Make the
    // selected-site cookie agree before any follow-up site-scoped action, such as
    // activating a theme, can accidentally target the previously selected site.
    const store = await cookies();
    store.set(SITE_COOKIE, site.id, siteCookieOptions);

    return { ok: true, message: t("admin.sites.created"), site };
  } catch (error) {
    return { ok: false, error: toMessage(error, t("admin.sites.errors.createFailed")) };
  }
}

/**
 * Updates a site: its name, whether it is published, and its brand.
 *
 * Only the fields passed are touched — the API patches. The brand is the reason
 * this exists: colour and logo belong to the site, so they are set once here and
 * every theme picks them up, instead of being re-entered for each theme.
 */
export async function updateSiteAction(
  id: string,
  patch: {
    name?: string;
    slug?: string;
    hostname?: string;
    status?: SiteDto["status"];
    defaultLocale?: string;
    brand?: SiteBrand;
  },
): Promise<SiteActionResult> {
  const t = await getT();

  const user = await getSession();
  if (!user) return { ok: false, error: t("auth.session.expired") };
  if (!can(user, "site:update")) return { ok: false, error: t("admin.sites.errors.updateDenied") };

  try {
    const site = await apiFetch<SiteDto>(`/sites/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: patch,
      siteScoped: false,
    });

    revalidatePath("/sites");
    revalidatePath(`/sites/${id}`);
    // A rename shows in the sidebar, and a brand change shows on the public site.
    revalidatePath("/", "layout");

    return { ok: true, message: t("admin.sites.saved"), site };
  } catch (error) {
    return { ok: false, error: toMessage(error, t("admin.sites.errors.updateFailed")) };
  }
}
