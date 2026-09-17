"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import type { SiteBackupDto, SiteBrand, SiteDto, SiteMaintenance } from "@zcmsorg/schemas";
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
  hostnames: string[];
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
 * Updates a site: its name, whether it is published, its brand, and whether it
 * is closed for maintenance.
 *
 * Only the fields passed are touched — the API patches. The brand is the reason
 * this exists: colour and logo belong to the site, so they are set once here and
 * every theme picks them up, instead of being re-entered for each theme. The
 * maintenance notice lives here for the same reason.
 */
export async function updateSiteAction(
  id: string,
  patch: {
    name?: string;
    slug?: string;
    hostnames?: string[];
    status?: SiteDto["status"];
    defaultLocale?: string;
    brand?: SiteBrand;
    maintenance?: SiteMaintenance;
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

export type SitemapActionResult =
  | { ok: true; message: string }
  | { ok: false; error: string };

/**
 * Queues a rebuild of this site's sitemap.xml.
 *
 * Publishing already rebuilds it; this button is for the gaps that leaves — content
 * older than the sitemap feature, a rebuild event that was lost, or simply wanting a
 * fresh one before submitting the URL to a search console. The API enqueues a
 * background job and answers 202, so success here means "queued", not "written": the
 * worker builds it moments later and /sitemap.xml reflects it on its next fetch.
 *
 * Gated on `site:update`, the same permission the API enforces — checked here too so
 * an editor sees a clean message instead of a 403 from the fetch.
 */
export async function rebuildSitemapAction(id: string): Promise<SitemapActionResult> {
  const t = await getT();

  const user = await getSession();
  if (!user) return { ok: false, error: t("auth.session.expired") };
  if (!can(user, "site:update")) return { ok: false, error: t("admin.sites.errors.updateDenied") };

  try {
    await apiFetch<{ status: string }>(`/sites/${encodeURIComponent(id)}/sitemap/rebuild`, {
      method: "POST",
      siteScoped: false,
    });

    return { ok: true, message: t("admin.sites.sitemap.queued") };
  } catch (error) {
    return { ok: false, error: toMessage(error, t("admin.sites.sitemap.failed")) };
  }
}

// ---------------------------------------------------------------------------
// Backups and deletion
// ---------------------------------------------------------------------------

export type BackupListResult =
  | { ok: true; backups: SiteBackupDto[] }
  | { ok: false; error: string };

export type BackupActionResult =
  | { ok: true; message: string; backup: SiteBackupDto }
  | { ok: false; error: string };

/**
 * The site's backups, newest first. Called by the client while a backup builds,
 * so it is an action rather than page data: the row changes every few seconds
 * and a full navigation per poll would be absurd.
 */
export async function listBackupsAction(id: string): Promise<BackupListResult> {
  const t = await getT();
  const user = await getSession();
  if (!user) return { ok: false, error: t("auth.session.expired") };
  if (!can(user, "site:update")) return { ok: false, error: t("admin.sites.errors.updateDenied") };

  try {
    const backups = await apiFetch<SiteBackupDto[]>(`/sites/${encodeURIComponent(id)}/backups`, {
      siteScoped: false,
    });
    return { ok: true, backups };
  } catch (error) {
    return { ok: false, error: toMessage(error, t("admin.sites.backup.listFailed")) };
  }
}

/**
 * Asks for a backup. The API answers 202 with a PENDING row; the worker builds
 * the archive and the row turns READY (or FAILED) — `listBackupsAction` is how
 * the screen finds out.
 */
export async function createBackupAction(id: string): Promise<BackupActionResult> {
  const t = await getT();
  const user = await getSession();
  if (!user) return { ok: false, error: t("auth.session.expired") };
  if (!can(user, "site:update")) return { ok: false, error: t("admin.sites.errors.updateDenied") };

  try {
    const backup = await apiFetch<SiteBackupDto>(`/sites/${encodeURIComponent(id)}/backups`, {
      method: "POST",
      siteScoped: false,
    });
    return { ok: true, message: t("admin.sites.backup.queued"), backup };
  } catch (error) {
    return { ok: false, error: toMessage(error, t("admin.sites.backup.createFailed")) };
  }
}

export async function deleteBackupAction(
  id: string,
  backupId: string,
): Promise<SitemapActionResult> {
  const t = await getT();
  const user = await getSession();
  if (!user) return { ok: false, error: t("auth.session.expired") };
  if (!can(user, "site:update")) return { ok: false, error: t("admin.sites.errors.updateDenied") };

  try {
    await apiFetch<void>(
      `/sites/${encodeURIComponent(id)}/backups/${encodeURIComponent(backupId)}`,
      { method: "DELETE", siteScoped: false },
    );
    return { ok: true, message: t("admin.sites.backup.deleted") };
  } catch (error) {
    return { ok: false, error: toMessage(error, t("admin.sites.backup.deleteFailed")) };
  }
}

export type DeleteSiteResult =
  | { ok: true; message: string; nextSiteId: string | null }
  | { ok: false; error: string };

/**
 * Deletes a site and everything in it. Irreversible — the dialog that calls
 * this has already made the person type the slug and acknowledge the backup.
 *
 * Afterwards the selected-site cookie may name a site that no longer exists;
 * it is moved to another of the tenant's sites (or cleared) so the next
 * site-scoped request does not 404 on a ghost. The client navigates.
 */
export async function deleteSiteAction(id: string, slug: string): Promise<DeleteSiteResult> {
  const t = await getT();
  const user = await getSession();
  if (!user) return { ok: false, error: t("auth.session.expired") };
  if (!can(user, "site:delete")) return { ok: false, error: t("admin.sites.delete.denied") };

  try {
    await apiFetch<{ ok: true }>(`/sites/${encodeURIComponent(id)}`, {
      method: "DELETE",
      body: { slug },
      siteScoped: false,
    });
  } catch (error) {
    return { ok: false, error: toMessage(error, t("admin.sites.delete.failed")) };
  }

  const remaining = (await listSites()).filter((site) => site.id !== id);
  const nextSiteId = remaining[0]?.id ?? null;

  const store = await cookies();
  if (nextSiteId) store.set(SITE_COOKIE, nextSiteId, siteCookieOptions);
  else store.delete(SITE_COOKIE);

  revalidatePath("/sites");
  revalidatePath("/", "layout");

  return { ok: true, message: t("admin.sites.delete.done"), nextSiteId };
}
