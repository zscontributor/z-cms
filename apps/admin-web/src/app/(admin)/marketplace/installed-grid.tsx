"use client";

import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/shell/icon";
import { MediaGallery } from "@/components/ui/media-gallery";
import { cn } from "@/lib/cn";
import { useT } from "@/lib/i18n-provider";

/**
 * One thing installed on the CURRENT site, normalised across the two very
 * different shapes the site-scoped APIs return (plugins vs installed themes).
 *
 * This is deliberately not a `BrowsePackageDto`: the marketplace catalogue is
 * instance-wide and site-blind, but this section answers "what does THIS site
 * run" — a per-site question the catalogue cannot answer. `latestVersion` is the
 * one fact borrowed back from the catalogue, so an installed package can still
 * say "the marketplace has moved on" without leaving the screen.
 */
export type InstalledPackage = {
  kind: "plugin" | "theme";
  key: string;
  name: string;
  version: string | null;
  active: boolean;
  /** Latest version the marketplace offers, when this key exists there; else null. */
  latestVersion: string | null;
  screenshots: string[];
  /** Where this package is actually managed — the marketplace only shows it. */
  manageHref: string;
};

/**
 * The "what this site already runs" half of the marketplace screen.
 *
 * It is a shelf, not a shop: no Install button, because everything here is
 * already installed. Each card instead links to where the package is managed
 * (plugins / appearance), and flags when the marketplace holds a newer version
 * than the one this site runs.
 */
export function InstalledGrid({ items }: { items: InstalledPackage[] }) {
  const t = useT();

  if (items.length === 0) {
    return (
      <p className="z-card p-8 text-center text-sm z-muted">
        {t("admin.marketplace.browse.installedEmpty")}
      </p>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
      {items.map((item) => (
        <InstalledCard key={`${item.kind}:${item.key}`} item={item} />
      ))}
    </div>
  );
}

function InstalledCard({ item }: { item: InstalledPackage }) {
  const t = useT();
  const updatable =
    item.version != null && item.latestVersion != null && item.version !== item.latestVersion;

  return (
    <article className="z-card flex flex-col gap-3 p-4">
      <header className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone="info">{t(`admin.marketplace.kind.${item.kind}`)}</Badge>
            <Badge tone={item.active ? "success" : "neutral"}>
              {t(
                item.active
                  ? "admin.marketplace.browse.activeBadge"
                  : "admin.marketplace.browse.inactiveBadge",
              )}
            </Badge>
            {updatable ? (
              <Badge tone="warning">
                {t("admin.marketplace.browse.updateBadge", { version: item.latestVersion! })}
              </Badge>
            ) : null}
          </div>
          <h3 className="mt-1.5 truncate text-sm font-semibold">{item.name}</h3>
          <p className="truncate text-[11px] z-muted">
            <code className="font-mono">
              {item.key}
              {item.version ? `@${item.version}` : ""}
            </code>
          </p>
        </div>
      </header>

      <MediaGallery screenshots={item.screenshots} video={null} name={item.name} />

      <footer className="mt-auto flex items-center justify-between gap-2 pt-1">
        {updatable ? (
          <span className="inline-flex items-center gap-1 text-[11px] text-amber-600 dark:text-amber-400">
            <Icon name="install" className="h-3.5 w-3.5" />
            {t("admin.marketplace.browse.updateAvailableBadge")}
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 text-[11px] text-emerald-600 dark:text-emerald-400">
            <Icon name="check" className="h-3.5 w-3.5" />
            {t("admin.marketplace.browse.installedBadge")}
          </span>
        )}

        <Link
          href={item.manageHref}
          className={cn(
            "inline-flex items-center gap-1 rounded-md border border-[var(--border)] px-2.5 py-1 text-[11px] font-medium",
            "text-[var(--text)] transition hover:bg-[var(--surface-sunken)]",
          )}
        >
          {t("admin.marketplace.browse.manage")}
          <Icon name="chevron-right" className="h-3.5 w-3.5" />
        </Link>
      </footer>
    </article>
  );
}
