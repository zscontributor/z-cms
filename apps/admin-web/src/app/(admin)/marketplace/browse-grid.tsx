"use client";

import { useMemo, useState, useTransition } from "react";
import { installFromMarketplaceAction } from "@/app/actions/marketplace";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/shell/icon";
import { MediaGallery } from "@/components/ui/media-gallery";
import type { BrowsePackageDto } from "@/lib/api";
import { cn } from "@/lib/cn";
import { formatDateTime } from "@/lib/format";
import { useT } from "@/lib/i18n-provider";
import { describePermission } from "@/lib/plugin-permissions";

type MarketplaceTab = "plugin" | "theme";

type CategoryDefinition = {
  key: string;
  keywords: string[];
  permissions?: string[];
};

type PackageWithTaxonomy = BrowsePackageDto & {
  category?: string | null;
  categories?: string[] | null;
  tags?: string[] | null;
};

const PLUGIN_CATEGORIES: CategoryDefinition[] = [
  {
    key: "seo",
    keywords: ["seo", "search", "sitemap", "schema", "metadata", "redirect"],
  },
  {
    key: "security",
    keywords: ["security", "firewall", "malware", "audit", "spam", "captcha", "2fa", "mfa"],
  },
  {
    key: "performance",
    keywords: ["performance", "cache", "speed", "optimize", "cdn", "image optimization"],
  },
  {
    key: "ecommerce",
    keywords: ["shop", "store", "cart", "checkout", "payment", "commerce", "product"],
  },
  {
    key: "forms",
    keywords: ["form", "contact", "survey", "lead", "submission", "booking"],
  },
  {
    key: "analytics",
    keywords: ["analytics", "tracking", "metrics", "report", "google analytics"],
  },
  {
    key: "marketing",
    keywords: ["marketing", "email", "newsletter", "campaign", "crm", "social", "popup"],
  },
  {
    key: "media",
    keywords: ["media", "gallery", "image", "video", "slider", "embed"],
  },
  {
    key: "membership",
    keywords: ["membership", "member", "subscription", "paywall", "course", "lms", "forum"],
  },
  {
    key: "developer",
    keywords: ["developer", "api", "webhook", "custom field", "migration", "debug", "code"],
  },
  { key: "other", keywords: [] },
];

const THEME_CATEGORIES: CategoryDefinition[] = [
  { key: "blog", keywords: ["blog", "journal", "personal", "writer"] },
  { key: "business", keywords: ["business", "company", "corporate", "agency", "saas"] },
  { key: "ecommerce", keywords: ["shop", "store", "commerce", "product", "market"] },
  { key: "portfolio", keywords: ["portfolio", "creative", "designer", "agency", "showcase"] },
  { key: "news", keywords: ["news", "magazine", "publisher", "editorial"] },
  { key: "education", keywords: ["education", "school", "course", "learning", "lms"] },
  { key: "entertainment", keywords: ["entertainment", "music", "event", "movie", "game"] },
  { key: "food", keywords: ["food", "restaurant", "cafe", "recipe", "drink"] },
  { key: "photography", keywords: ["photo", "photography", "gallery", "image", "visual"] },
  { key: "community", keywords: ["community", "forum", "nonprofit", "membership", "directory"] },
  { key: "other", keywords: [] },
];

/**
 * The catalogue, as a grid of cards a site owner installs from.
 *
 * The one non-obvious decision here is showing a plugin's requested permissions
 * ON the card, before install rather than only in the consent dialog. The consent
 * dialog is the gate; the card is the shop window — and a shopper deciding
 * between two analytics plugins should be able to see that one wants to read
 * content and the other wants to read your users, without clicking Install to
 * find out. The scary ones are marked, so the signal survives a glance.
 */
export function BrowseGrid({
  packages,
  locale,
  canInstallTheme,
  canInstallPlugin,
}: {
  packages: BrowsePackageDto[];
  locale: string;
  canInstallTheme: boolean;
  canInstallPlugin: boolean;
}) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<MarketplaceTab>("plugin");
  const [category, setCategory] = useState("all");
  const categories = tab === "plugin" ? PLUGIN_CATEGORIES : THEME_CATEGORIES;

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return packages.filter((pkg) => {
      if (pkg.kind !== tab) return false;
      if (category !== "all" && packageCategory(pkg) !== category) return false;
      if (!needle) return true;
      return (
        pkg.name.toLowerCase().includes(needle) ||
        pkg.key.toLowerCase().includes(needle) ||
        (pkg.description ?? "").toLowerCase().includes(needle)
      );
    });
  }, [packages, query, tab, category]);

  const tabCounts = useMemo(
    () => ({
      plugin: packages.filter((pkg) => pkg.kind === "plugin").length,
      theme: packages.filter((pkg) => pkg.kind === "theme").length,
    }),
    [packages],
  );

  const categoryCounts = useMemo(() => {
    const counts = new Map<string, number>();
    let total = 0;
    for (const pkg of packages) {
      if (pkg.kind !== tab) continue;
      total += 1;
      const key = packageCategory(pkg);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    counts.set("all", total);
    return counts;
  }, [packages, tab]);

  function selectTab(next: MarketplaceTab) {
    setTab(next);
    setCategory("all");
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-1" role="tablist" aria-label={t("admin.marketplace.browse.tabsLabel")}>
          {(["plugin", "theme"] as const).map((option) => (
            <button
              key={option}
              type="button"
              role="tab"
              aria-selected={tab === option}
              onClick={() => selectTab(option)}
              className={cn(
                "rounded-md px-3 py-1.5 text-xs font-medium transition",
                tab === option
                  ? "bg-[var(--surface-raised)] text-[var(--text)] shadow-sm ring-1 ring-[var(--border-strong)]"
                  : "text-[var(--text-muted)] hover:bg-[var(--surface-sunken)] hover:text-[var(--text)]",
              )}
            >
              {t(`admin.marketplace.browse.tabs.${option}`)}
              <span className="ml-1.5 text-[10px] z-muted">{tabCounts[option]}</span>
            </button>
          ))}
        </div>

        <div className="relative min-w-56 flex-1">
          <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)]">
            <Icon name="search" className="h-4 w-4" />
          </span>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("admin.marketplace.browse.searchPlaceholder")}
            className="z-input w-full pl-8"
            aria-label={t("admin.marketplace.browse.searchPlaceholder")}
          />
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5" aria-label={t("admin.marketplace.browse.categoriesLabel")}>
        {["all", ...categories.map((item) => item.key)].map((option) => {
          const count = categoryCounts.get(option) ?? 0;
          return (
            <button
              key={option}
              type="button"
              onClick={() => setCategory(option)}
              disabled={option !== "all" && count === 0}
              className={cn(
                "rounded-full border px-2.5 py-1 text-[11px] font-medium transition",
                category === option
                  ? "bg-[var(--surface-raised)] text-[var(--text)] shadow-sm ring-1 ring-[var(--border-strong)]"
                  : "border-[var(--border)] text-[var(--text-muted)] hover:bg-[var(--surface-sunken)] hover:text-[var(--text)]",
                option !== "all" && count === 0 && "opacity-40 hover:bg-transparent",
              )}
            >
              {t(`admin.marketplace.browse.categories.${tab}.${option}`)}
              <span className="ml-1 text-[10px]">{count}</span>
            </button>
          );
        })}
      </div>

      {filtered.length === 0 ? (
        <p className="z-card p-8 text-center text-sm z-muted">
          {t("admin.marketplace.browse.noMatch")}
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {filtered.map((pkg) => (
            <PackageCard
              key={`${pkg.kind}:${pkg.key}`}
              pkg={pkg}
              locale={locale}
              canInstall={pkg.kind === "theme" ? canInstallTheme : canInstallPlugin}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function packageCategory(pkg: BrowsePackageDto): string {
  const declared = declaredCategories(pkg).find((value) =>
    categoryDefinitions(pkg.kind).some((category) => category.key === value),
  );
  if (declared) return declared;

  const haystack = [pkg.key, pkg.name, pkg.description ?? ""].join(" ").toLowerCase();
  const matched = categoryDefinitions(pkg.kind).find((category) =>
    category.keywords.some((keyword) => haystack.includes(keyword)),
  );

  return matched?.key ?? "other";
}

function declaredCategories(pkg: BrowsePackageDto): string[] {
  const withTaxonomy = pkg as PackageWithTaxonomy;
  const values = [
    withTaxonomy.category,
    ...(Array.isArray(withTaxonomy.categories) ? withTaxonomy.categories : []),
    ...(Array.isArray(withTaxonomy.tags) ? withTaxonomy.tags : []),
  ];
  return values
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

function categoryDefinitions(kind: BrowsePackageDto["kind"]): CategoryDefinition[] {
  return kind === "plugin" ? PLUGIN_CATEGORIES : THEME_CATEGORIES;
}

function PackageCard({
  pkg,
  locale,
  canInstall,
}: {
  pkg: BrowsePackageDto;
  locale: string;
  canInstall: boolean;
}) {
  const t = useT();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // "Installed and current" vs "installed but the marketplace has a newer one":
  // the second is the state that earns an Update button instead of a done tick.
  const upToDate = pkg.installed && pkg.installedVersion === pkg.latestVersion;
  const updatable = pkg.installed && !upToDate;

  function install() {
    setError(null);
    startTransition(async () => {
      const result = await installFromMarketplaceAction(pkg.kind, pkg.key, pkg.latestVersion);
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
            <Badge tone="info">{t(`admin.marketplace.kind.${pkg.kind}`)}</Badge>
            {upToDate ? (
              <Badge tone="success">{t("admin.marketplace.browse.installedBadge")}</Badge>
            ) : null}
            {updatable ? (
              <Badge tone="warning">
                {t("admin.marketplace.browse.updateBadge", { version: pkg.latestVersion })}
              </Badge>
            ) : null}
          </div>
          <h3 className="mt-1.5 truncate text-sm font-semibold">{pkg.name}</h3>
          <p className="truncate text-[11px] z-muted">
            <code className="font-mono">
              {pkg.key}@{pkg.latestVersion}
            </code>
          </p>
        </div>
      </header>

      {/* The shop window. A theme is a look, and a paragraph of prose is a poor
          way to buy one — so the screenshots come before the description, and any
          of them opens full-size. Renders nothing when the publisher shipped none. */}
      <MediaGallery
        screenshots={pkg.screenshots}
        video={pkg.video}
        name={pkg.name}
      />

      {pkg.description ? (
        <p className="line-clamp-3 text-xs leading-5 z-muted">{pkg.description}</p>
      ) : null}

      {/* The publisher, because the same package means different things from a
          verified author and an anonymous one. */}
      <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
        {pkg.publisher ? (
          <>
            <Badge tone={pkg.publisher.verified ? "success" : "neutral"}>
              {t(
                pkg.publisher.verified
                  ? "admin.marketplace.publisherVerified"
                  : "admin.marketplace.publisherUnverified",
              )}
            </Badge>
            <span className="z-muted">
              {pkg.publisher.name} <code className="font-mono">@{pkg.publisher.slug}</code>
            </span>
          </>
        ) : (
          <span className="z-muted">{pkg.author}</span>
        )}
      </div>

      {pkg.kind === "plugin" && pkg.permissions.length > 0 ? (
        <div className="rounded-md border border-[var(--border)] bg-[var(--surface-sunken)] p-2.5">
          <p className="text-[10px] font-semibold uppercase tracking-wider z-muted">
            {t("admin.marketplace.browse.wants")}
          </p>
          <ul className="mt-1.5 flex flex-wrap gap-1">
            {pkg.permissions.map((permission) => {
              const copy = describePermission(permission, t);
              return (
                <li key={permission}>
                  <span
                    className={cn(
                      "inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] leading-4",
                      copy.sensitive
                        ? "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300"
                        : "border-[var(--border)] text-[var(--text-muted)]",
                    )}
                    title={copy.detail}
                  >
                    {copy.label}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      <footer className="mt-auto flex items-center justify-between gap-2 pt-1">
        <span className="text-[10px] z-muted">
          {t("admin.marketplace.browse.updated", {
            date: formatDateTime(pkg.updatedAt, locale),
          })}
        </span>

        {notice ? (
          <span className="text-[11px] text-emerald-600 dark:text-emerald-400">{notice}</span>
        ) : upToDate ? (
          <span className="inline-flex items-center gap-1 text-[11px] text-emerald-600 dark:text-emerald-400">
            <Icon name="check" className="h-3.5 w-3.5" />
            {t("admin.marketplace.browse.installedBadge")}
          </span>
        ) : canInstall ? (
          <Button size="sm" variant="primary" onClick={install} disabled={pending}>
            <Icon name="install" className="mr-1 h-3.5 w-3.5" />
            {pending
              ? t("admin.marketplace.browse.installing")
              : updatable
                ? t("admin.marketplace.browse.update")
                : t("admin.marketplace.browse.install")}
          </Button>
        ) : (
          <span className="text-[11px] z-muted">{t("admin.marketplace.browse.installDenied")}</span>
        )}
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
