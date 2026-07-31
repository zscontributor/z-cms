"use client";

import Link from "next/link";
import { useMemo, useState, useTransition } from "react";
import { installFromMarketplaceAction } from "@/app/actions/marketplace";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/shell/icon";
import { MediaGallery } from "@/components/ui/media-gallery";
import { SearchField } from "@/components/ui/search-field";
import { cn } from "@/lib/cn";
import { useT } from "@/lib/i18n-provider";

/** Below this the shelf is short enough to scan; a search box would only clutter it. */
const SEARCH_THRESHOLD = 4;

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
export function InstalledGrid({
  items,
  canInstallTheme,
  canInstallPlugin,
}: {
  items: InstalledPackage[];
  canInstallTheme: boolean;
  canInstallPlugin: boolean;
}) {
  const t = useT();
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();

  const filtered = useMemo(
    () =>
      items.filter(
        (item) =>
          !needle ||
          item.name.toLowerCase().includes(needle) ||
          item.key.toLowerCase().includes(needle),
      ),
    [items, needle],
  );

  if (items.length === 0) {
    return (
      <p className="z-card p-8 text-center text-sm z-muted">
        {t("admin.marketplace.browse.installedEmpty")}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {items.length > SEARCH_THRESHOLD ? (
        <div className="flex justify-start">
          <SearchField
            value={query}
            onChange={setQuery}
            placeholder={t("admin.marketplace.browse.searchPlaceholder")}
            className="w-full sm:max-w-xs"
          />
        </div>
      ) : null}

      {filtered.length === 0 ? (
        <p className="z-card p-8 text-center text-sm z-muted">
          {t("admin.marketplace.browse.noMatch")}
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {filtered.map((item) => (
            <InstalledCard
              key={`${item.kind}:${item.key}`}
              item={item}
              canInstall={item.kind === "theme" ? canInstallTheme : canInstallPlugin}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function InstalledCard({ item, canInstall }: { item: InstalledPackage; canInstall: boolean }) {
  const t = useT();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const updatable =
    item.version != null && item.latestVersion != null && item.version !== item.latestVersion;

  function update() {
    if (!item.latestVersion) return;
    setError(null);
    startTransition(async () => {
      const result = await installFromMarketplaceAction(item.kind, item.key, item.latestVersion!);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setNotice(result.message);
    });
  }

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
        {notice ? (
          <span className="inline-flex items-center gap-1 text-[11px] text-emerald-600 dark:text-emerald-400">
            <Icon name="check" className="h-3.5 w-3.5" />
            {notice}
          </span>
        ) : updatable ? (
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

        <div className="flex items-center gap-2">
          {updatable && canInstall && !notice ? (
            <Button size="sm" variant="primary" onClick={update} busy={pending}>
              {pending ? null : <Icon name="install" className="mr-1 h-3.5 w-3.5" />}
              {pending
                ? t("admin.marketplace.browse.installing")
                : t("admin.marketplace.browse.update")}
            </Button>
          ) : null}

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
        </div>
      </footer>

      {error ? (
        <p
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 px-2.5 py-2 text-[11px] text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300"
        >
          {error}
        </p>
      ) : null}
    </article>
  );
}
