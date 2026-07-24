"use server";

import { revalidatePath } from "next/cache";
import { ApiError, apiFetch, can, getSession, type PackageKind } from "@/lib/api";
import { getT } from "@/lib/locale";

export type MarketplaceActionResult =
  | { ok: true; message: string }
  | { ok: false; error: string };

function segment(value: string): string {
  return encodeURIComponent(value);
}

/**
 * Pulls a package from the marketplace into this instance's catalogue.
 *
 * Downloading is NOT installing-on-a-site, and the split is deliberate: this
 * puts the verified bytes in the catalogue and grants nothing. A theme is then
 * activated from Appearance; a plugin is installed onto the site from Plugins,
 * which is where the permission-consent screen lives. So this action needs only
 * the `*:install` scope, and the scarier grant happens where the admin can see
 * what they are agreeing to.
 *
 * The permission is re-checked here because a server action is a public endpoint.
 * The button being hidden is a courtesy to the honest user, not a control.
 */
export async function installFromMarketplaceAction(
  kind: PackageKind,
  key: string,
  version: string,
): Promise<MarketplaceActionResult> {
  const t = await getT();

  const user = await getSession();
  if (!user) return { ok: false, error: t("auth.session.expired") };

  const scope = kind === "theme" ? "theme:install" : "plugin:install";
  if (!can(user, scope)) {
    return { ok: false, error: t("admin.marketplace.browse.installDenied") };
  }

  try {
    await apiFetch<{ ok: boolean }>(
      `/marketplace/install/${segment(kind)}/${segment(key)}/${segment(version)}`,
      { method: "POST", siteScoped: false },
    );
    // The catalogue changed, and so did the screens that read it: Appearance
    // lists installable themes, Plugins lists installable plugins.
    revalidatePath("/marketplace");
    revalidatePath(kind === "theme" ? "/appearance" : "/plugins");
    return {
      ok: true,
      message: t("admin.marketplace.browse.installed", { name: key, version }),
    };
  } catch (error) {
    const message =
      error instanceof ApiError ? error.message : t("admin.marketplace.browse.installFailed");
    return { ok: false, error: message };
  }
}
