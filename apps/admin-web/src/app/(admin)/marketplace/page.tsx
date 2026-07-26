import type { Metadata } from "next";
import {
  browseMarketplace,
  can,
  getMarketplaceStatus,
  getSession,
  listInstalledThemes,
  listPlugins,
  type BrowsePackageDto,
  type CatalogPluginDto,
  type InstalledThemeDto,
  type MarketplaceStatusDto,
} from "@/lib/api";
import { getLocale, getT } from "@/lib/locale";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/ui/table";
import { BrowseGrid } from "./browse-grid";
import { InstalledGrid, type InstalledPackage } from "./installed-grid";
import { StatusBanner } from "./status-banner";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("admin.marketplace.browse.metaTitle") };
}

export const dynamic = "force-dynamic";

/**
 * The site owner's marketplace: the catalogue you install FROM.
 *
 * Two shelves, because two questions. The Marketplace shelf is the community
 * catalogue — instance-wide and site-blind, the same everywhere this instance
 * points. The Installed shelf answers a narrower, per-site question the
 * catalogue cannot: what does THIS site actually run. Above both, not buried,
 * sits how fresh the instance's safety data is — a marketplace client that
 * cannot say "my kill-switch feed went quiet yesterday" is hiding the one fact
 * that decides whether the packages below are still safe to trust.
 */
export default async function MarketplacePage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const t = await getT();
  const locale = await getLocale();
  const user = await getSession();

  if (!can(user, "theme:read")) {
    return <div className="z-card p-10 text-center text-sm">{t("admin.marketplace.browse.denied")}</div>;
  }

  const { q } = await searchParams;

  const [packages, status, sitePlugins, siteThemes] = await Promise.all([
    safe<BrowsePackageDto[]>(() => browseMarketplace(undefined, q), []),
    safe<MarketplaceStatusDto | null>(getMarketplaceStatus, null),
    safe<CatalogPluginDto[]>(listPlugins, []),
    safe<InstalledThemeDto[]>(listInstalledThemes, []),
  ]);

  const canInstallTheme = can(user, "theme:install");
  const canInstallPlugin = can(user, "plugin:install");

  const installed = installedForSite(sitePlugins, siteThemes, packages);

  return (
    <>
      <PageHeader
        title={t("admin.marketplace.browse.title")}
        description={t("admin.marketplace.browse.description")}
      />

      {status ? <StatusBanner status={status} locale={locale} /> : null}

      <section className="mt-2 flex flex-col gap-3">
        <div>
          <h2 className="text-sm font-semibold">{t("admin.marketplace.browse.sections.installed")}</h2>
          <p className="text-xs z-muted">{t("admin.marketplace.browse.sections.installedDescription")}</p>
        </div>
        <InstalledGrid items={installed} />
      </section>

      <section className="mt-6 flex flex-col gap-3">
        <div>
          <h2 className="text-sm font-semibold">{t("admin.marketplace.browse.sections.available")}</h2>
          <p className="text-xs z-muted">{t("admin.marketplace.browse.sections.availableDescription")}</p>
        </div>
        {packages.length === 0 ? (
          <div className="z-card">
            <EmptyState
              title={t("admin.marketplace.browse.emptyTitle")}
              description={t("admin.marketplace.browse.emptyDescription")}
            />
          </div>
        ) : (
          <BrowseGrid
            packages={packages}
            locale={locale}
            canInstallTheme={canInstallTheme}
            canInstallPlugin={canInstallPlugin}
          />
        )}
      </section>
    </>
  );
}

/**
 * Fold the two site-scoped catalogues (plugins active on this site, themes
 * installed on this site) into one normalised list, borrowing `latestVersion`
 * from the marketplace catalogue so an installed package can still flag that a
 * newer version is available. Site-blind on purpose everywhere except here.
 */
function installedForSite(
  plugins: CatalogPluginDto[],
  themes: InstalledThemeDto[],
  market: BrowsePackageDto[],
): InstalledPackage[] {
  const latestByKey = new Map<string, string>();
  for (const pkg of market) latestByKey.set(`${pkg.kind}:${pkg.key}`, pkg.latestVersion);
  const screenshotsByKey = new Map<string, string[]>();
  for (const pkg of market) screenshotsByKey.set(`${pkg.kind}:${pkg.key}`, pkg.screenshots);

  const pluginItems: InstalledPackage[] = plugins
    .filter((plugin) => plugin.installed)
    .map((plugin) => ({
      kind: "plugin",
      key: plugin.key,
      name: plugin.name,
      version: plugin.latestVersion,
      active: plugin.status === "ACTIVE",
      latestVersion: latestByKey.get(`plugin:${plugin.key}`) ?? null,
      screenshots: screenshotsByKey.get(`plugin:${plugin.key}`) ?? [],
      manageHref: "/plugins",
    }));

  const themeItems: InstalledPackage[] = themes.map((theme) => ({
    kind: "theme",
    key: theme.key,
    name: theme.name,
    version: theme.version,
    active: theme.status === "ACTIVE",
    latestVersion: latestByKey.get(`theme:${theme.key}`) ?? null,
    screenshots: theme.screenshots.length > 0 ? theme.screenshots : screenshotsByKey.get(`theme:${theme.key}`) ?? [],
    manageHref: "/appearance",
  }));

  // Active first, then alphabetical — the shelf reads as "what's running here".
  return [...pluginItems, ...themeItems].sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

/** An unreachable API must not take the screen down with it. */
async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}
