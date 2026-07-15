import type { Metadata } from "next";
import {
  browseMarketplace,
  can,
  getMarketplaceStatus,
  getSession,
  type BrowsePackageDto,
  type MarketplaceStatusDto,
} from "@/lib/api";
import { getLocale, getT } from "@/lib/locale";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/ui/table";
import { BrowseGrid } from "./browse-grid";
import { StatusBanner } from "./status-banner";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("admin.marketplace.browse.metaTitle") };
}

export const dynamic = "force-dynamic";

/**
 * The site owner's marketplace: the catalogue you install FROM.
 *
 * This is the "add a plugin" screen, not the review queue. It shows what
 * the marketplace offers, what this instance already holds, and — above the fold,
 * not buried — how fresh the instance's safety data is. A marketplace client that
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

  const [packages, status] = await Promise.all([
    safe<BrowsePackageDto[]>(() => browseMarketplace(undefined, q), []),
    safe<MarketplaceStatusDto | null>(getMarketplaceStatus, null),
  ]);

  const canInstallTheme = can(user, "theme:install");
  const canInstallPlugin = can(user, "plugin:install");

  return (
    <>
      <PageHeader
        title={t("admin.marketplace.browse.title")}
        description={t("admin.marketplace.browse.description")}
      />

      {status ? <StatusBanner status={status} locale={locale} /> : null}

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
    </>
  );
}

/** An unreachable API must not take the screen down with it. */
async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}
