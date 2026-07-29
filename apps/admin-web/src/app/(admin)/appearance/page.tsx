import type { Metadata } from "next";
import {
  browseMarketplace,
  can,
  getCurrentSite,
  getSession,
  listInstalledThemes,
  listThemeCatalog,
  listThemeDrafts,
  type BrowsePackageDto,
  type InstalledThemeDto,
  type ThemeCatalogEntry,
  type ThemeDraftSummaryDto,
} from "@/lib/api";
import { PageHeader } from "@/components/page-header";
import { getT } from "@/lib/locale";
import { ThemeDraftsPanel } from "./theme-drafts-panel";
import { ThemeBrowser } from "./theme-browser";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("appearance.metaTitle") };
}

export const dynamic = "force-dynamic";

export default async function AppearancePage() {
  const t = await getT();
  const user = await getSession();

  if (!can(user, "theme:read")) {
    return <div className="z-card p-10 text-center text-sm">{t("appearance.denied")}</div>;
  }

  const [site, installed, catalog, drafts, market] = await Promise.all([
    getCurrentSite(),
    safe<InstalledThemeDto[]>(listInstalledThemes, []),
    safe<ThemeCatalogEntry[]>(listThemeCatalog, []),
    // A reader without theme:author gets an empty list rather than a failed page:
    // the drafts panel is one section of Appearance, not the reason to load it.
    can(user, "theme:author") ? safe<ThemeDraftSummaryDto[]>(listThemeDrafts, []) : [],
    // The marketplace catalogue, only to learn which installed themes have a newer
    // version available. Fail-open: an unreachable marketplace just hides the
    // update badges, it never takes Appearance down.
    safe<BrowsePackageDto[]>(() => browseMarketplace("theme"), []),
  ]);

  // theme key → the newest version the marketplace offers, so an installed card can
  // flag "update available" without the admin having to open the marketplace.
  const latestVersionByKey: Record<string, string> = {};
  for (const pkg of market) latestVersionByKey[pkg.key] = pkg.latestVersion;

  const activeKey = site?.activeTheme?.key ?? null;
  const installedKeys = new Set(installed.map((theme) => theme.key));
  const available = catalog.filter((entry) => !installedKeys.has(entry.key));

  // Verified (built-in + marketplace) versus unverified (the operator's own
  // sideloads). Kept apart on screen so "installed" never blurs "reviewed".
  const verified = installed.filter((theme) => theme.origin !== "SIDELOAD");
  const sideloaded = installed.filter((theme) => theme.origin === "SIDELOAD");

  const canActivate = can(user, "theme:activate");
  const canConfigure = can(user, "theme:configure");
  const canSideload = can(user, "theme:sideload");
  const canAuthor = can(user, "theme:author");
  const canInstall = can(user, "theme:install");

  // A drawn theme keeps its editable layout in the draft it was built from, never
  // in the installed package (the layout is compiled away at build). So an installed
  // card can offer "Edit" only when its draft still exists — matched here by the
  // reverse-DNS key both sides share. Hand-written, built-in and marketplace themes
  // have no draft and no layout tree, so they get no Edit button.
  const draftIdByKey: Record<string, string> = {};
  for (const draft of drafts) draftIdByKey[draft.key] = draft.id;

  return (
    <>
      <PageHeader title={t("appearance.title")} description={t("appearance.description")} />

      {can(user, "theme:author") ? (
        <ThemeDraftsPanel drafts={drafts} canAuthor canBuild={canSideload} />
      ) : null}

      <ThemeBrowser
        sideloaded={sideloaded}
        verified={verified}
        available={available}
        activeKey={activeKey}
        draftIdByKey={draftIdByKey}
        latestVersionByKey={latestVersionByKey}
        canActivate={canActivate}
        canConfigure={canConfigure}
        canSideload={canSideload}
        canAuthor={canAuthor}
        canInstall={canInstall}
      />
    </>
  );
}

async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}
