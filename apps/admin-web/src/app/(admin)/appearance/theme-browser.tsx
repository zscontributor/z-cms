"use client";

import { useMemo, useState } from "react";
import type { InstalledThemeDto, ThemeCatalogEntry } from "@/lib/api";
import { EmptyState } from "@/components/ui/table";
import { MediaGallery } from "@/components/ui/media-gallery";
import { SearchField } from "@/components/ui/search-field";
import { SideloadUpload } from "@/components/sideload-controls";
import { useT } from "@/lib/i18n-provider";
import { ActivateButton } from "./activate-button";
import { ThemeGrid } from "./theme-grid";

/**
 * The theme catalogue with one search box on top that filters every shelf at
 * once — sideloaded, installed and available. The lists are already in memory
 * (the page loads them whole), so the filter is a client-side `includes` rather
 * than a round-trip. The sideload upload stays put regardless of the query: it
 * is an action on the screen, not one of the results being filtered.
 */
export function ThemeBrowser({
  sideloaded,
  verified,
  available,
  activeKey,
  draftIdByKey,
  canActivate,
  canConfigure,
  canSideload,
  canAuthor,
}: {
  sideloaded: InstalledThemeDto[];
  verified: InstalledThemeDto[];
  available: ThemeCatalogEntry[];
  activeKey: string | null;
  draftIdByKey: Record<string, string>;
  canActivate: boolean;
  canConfigure: boolean;
  canSideload: boolean;
  canAuthor: boolean;
}) {
  const t = useT();
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();

  const filteredSideloaded = useMemo(
    () => sideloaded.filter((theme) => matchesInstalled(theme, needle)),
    [sideloaded, needle],
  );
  const filteredVerified = useMemo(
    () => verified.filter((theme) => matchesInstalled(theme, needle)),
    [verified, needle],
  );
  const filteredAvailable = useMemo(
    () => available.filter((entry) => matchesCatalog(entry, needle)),
    [available, needle],
  );

  const installedEmpty = verified.length + sideloaded.length === 0;
  const hasAnyTheme = sideloaded.length + verified.length + available.length > 0;
  const noMatches =
    needle.length > 0 &&
    filteredSideloaded.length === 0 &&
    filteredVerified.length === 0 &&
    filteredAvailable.length === 0;

  return (
    <>
      {hasAnyTheme ? (
        <div className="mb-4 flex justify-start">
          <SearchField
            value={query}
            onChange={setQuery}
            placeholder={t("appearance.searchPlaceholder")}
            className="w-full sm:max-w-xs"
          />
        </div>
      ) : null}

      {canSideload ? (
        <section className="z-card mb-5 p-4">
          <h2 className="text-sm font-semibold">{t("appearance.sideload.heading")}</h2>
          <p className="mt-0.5 text-[11px] z-muted">{t("appearance.sideload.hint")}</p>
          <div className="mt-3 flex justify-start">
            <SideloadUpload kind="theme" />
          </div>
        </section>
      ) : null}

      {filteredSideloaded.length > 0 ? (
        <section className="mb-5">
          <h2 className="mb-2 text-sm font-semibold">
            {t("appearance.sideload.installedHeading")}
          </h2>
          <ThemeGrid
            themes={filteredSideloaded}
            activeKey={activeKey}
            canActivate={canActivate}
            canConfigure={canConfigure}
            canSideload={canSideload}
            canEdit={canAuthor}
            draftIdByKey={draftIdByKey}
            sideloaded
          />
        </section>
      ) : null}

      {installedEmpty ? (
        <div className="z-card">
          <EmptyState
            title={t("appearance.emptyTitle")}
            description={t("appearance.emptyDescription")}
          />
        </div>
      ) : filteredVerified.length > 0 ? (
        <ThemeGrid
          themes={filteredVerified}
          activeKey={activeKey}
          canActivate={canActivate}
          canConfigure={canConfigure}
          canEdit={canAuthor}
          draftIdByKey={draftIdByKey}
        />
      ) : null}

      {filteredAvailable.length > 0 ? (
        <section className="mt-5">
          <h2 className="mb-2 text-sm font-semibold">{t("appearance.available")}</h2>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {filteredAvailable.map((entry) => (
              <article key={entry.key} className="z-card p-4">
                <MediaGallery
                  screenshots={entry.screenshots}
                  name={entry.name}
                  className="mb-3"
                />
                <h3 className="text-sm font-semibold">{entry.name}</h3>
                <p className="mt-0.5 text-[11px] z-muted">
                  {entry.author} · v{entry.versions[entry.versions.length - 1]?.version ?? "—"}
                </p>
                <p className="mt-2 line-clamp-3 text-xs z-muted">{entry.description}</p>
                {canActivate ? (
                  <div className="mt-3">
                    <ActivateButton themeKey={entry.key} name={entry.name} />
                  </div>
                ) : null}
              </article>
            ))}
          </div>
        </section>
      ) : null}

      {noMatches ? (
        <p className="z-card p-8 text-center text-sm z-muted">{t("appearance.noMatch")}</p>
      ) : null}
    </>
  );
}

function matchesInstalled(theme: InstalledThemeDto, needle: string): boolean {
  if (!needle) return true;
  return (
    theme.name.toLowerCase().includes(needle) || theme.key.toLowerCase().includes(needle)
  );
}

function matchesCatalog(entry: ThemeCatalogEntry, needle: string): boolean {
  if (!needle) return true;
  return (
    entry.name.toLowerCase().includes(needle) ||
    entry.key.toLowerCase().includes(needle) ||
    entry.author.toLowerCase().includes(needle) ||
    entry.description.toLowerCase().includes(needle)
  );
}
