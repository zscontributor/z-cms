"use client";

import { useMemo, useState } from "react";
import type { CatalogPluginDto } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/table";
import { SearchField } from "@/components/ui/search-field";
import { SideloadActions, SideloadUpload } from "@/components/sideload-controls";
import { useT } from "@/lib/i18n-provider";
import { PluginCard } from "./plugin-card";

/**
 * The plugin catalogue with one search box filtering every shelf — sideloaded,
 * installed and available — client-side over the already-loaded lists. The
 * sideload upload stays put no matter the query: it is an action, not a result.
 */
export function PluginBrowser({
  sideloaded,
  installed,
  available,
  isEmpty,
  canInstall,
  canActivate,
  canConfigure,
  canSideload,
}: {
  sideloaded: CatalogPluginDto[];
  installed: CatalogPluginDto[];
  available: CatalogPluginDto[];
  isEmpty: boolean;
  canInstall: boolean;
  canActivate: boolean;
  canConfigure: boolean;
  canSideload: boolean;
}) {
  const t = useT();
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();

  const filteredSideloaded = useMemo(
    () => sideloaded.filter((plugin) => matches(plugin, needle)),
    [sideloaded, needle],
  );
  const filteredInstalled = useMemo(
    () => installed.filter((plugin) => matches(plugin, needle)),
    [installed, needle],
  );
  const filteredAvailable = useMemo(
    () => available.filter((plugin) => matches(plugin, needle)),
    [available, needle],
  );

  const noMatches =
    needle.length > 0 &&
    filteredSideloaded.length === 0 &&
    filteredInstalled.length === 0 &&
    filteredAvailable.length === 0;

  return (
    <>
      {isEmpty ? (
        <div className="z-card">
          <EmptyState
            title={t("plugins.emptyTitle")}
            description={t("plugins.emptyDescription")}
          />
        </div>
      ) : (
        <div className="mb-4 flex justify-end">
          <SearchField
            value={query}
            onChange={setQuery}
            placeholder={t("plugins.searchPlaceholder")}
            className="w-full sm:max-w-xs"
          />
        </div>
      )}

      {canSideload || sideloaded.length > 0 ? (
        <section className="mb-6">
          <div className="mb-2">
            <div>
              <h2 className="text-sm font-semibold">{t("appearance.sideload.heading")}</h2>
              <p className="mt-0.5 text-[11px] z-muted">{t("plugins.sideloadHint")}</p>
            </div>
            {canSideload ? (
              <div className="mt-2 flex justify-start">
                <SideloadUpload kind="plugin" />
              </div>
            ) : null}
          </div>

          {filteredSideloaded.length > 0 ? (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {filteredSideloaded.map((plugin) => {
                const approved = plugin.reviewStatus === "APPROVED";
                return (
                  <article
                    key={plugin.key}
                    className="z-card border-amber-300/60 p-4 dark:border-amber-800/60"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <h3 className="truncate text-sm font-semibold">{plugin.name}</h3>
                        <p className="mt-0.5 text-[11px] z-muted">
                          <code>{plugin.key}</code>
                          {plugin.latestVersion ? ` · v${plugin.latestVersion}` : null}
                        </p>
                      </div>
                      <Badge tone={approved ? "warning" : "danger"}>
                        {approved
                          ? t("appearance.sideload.unverified")
                          : t("appearance.sideload.pending")}
                      </Badge>
                    </div>
                    {plugin.description ? (
                      <p className="mt-2 line-clamp-3 text-xs z-muted">{plugin.description}</p>
                    ) : null}
                    {approved ? (
                      <p className="mt-2 text-[11px] z-muted">{t("plugins.sideloadApprovedHint")}</p>
                    ) : null}
                    {canSideload && plugin.latestVersion ? (
                      <SideloadActions
                        kind="plugin"
                        itemKey={plugin.key}
                        version={plugin.latestVersion}
                        reviewStatus={plugin.reviewStatus ?? "QUARANTINED"}
                      />
                    ) : null}
                  </article>
                );
              })}
            </div>
          ) : null}
        </section>
      ) : null}

      {filteredInstalled.length > 0 ? (
        <section className="mb-6">
          <h2 className="mb-2 text-sm font-semibold">{t("plugins.installedHeading")}</h2>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {filteredInstalled.map((plugin) => (
              <PluginCard
                key={plugin.key}
                plugin={plugin}
                canInstall={canInstall}
                canActivate={canActivate}
                canConfigure={canConfigure}
              />
            ))}
          </div>
        </section>
      ) : null}

      {filteredAvailable.length > 0 ? (
        <section>
          <h2 className="mb-2 text-sm font-semibold">{t("plugins.catalogHeading")}</h2>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {filteredAvailable.map((plugin) => (
              <PluginCard
                key={plugin.key}
                plugin={plugin}
                canInstall={canInstall}
                canActivate={canActivate}
                canConfigure={canConfigure}
              />
            ))}
          </div>
        </section>
      ) : null}

      {noMatches ? (
        <p className="z-card p-8 text-center text-sm z-muted">{t("plugins.noMatch")}</p>
      ) : null}
    </>
  );
}

function matches(plugin: CatalogPluginDto, needle: string): boolean {
  if (!needle) return true;
  return (
    plugin.name.toLowerCase().includes(needle) ||
    plugin.key.toLowerCase().includes(needle) ||
    (plugin.description ?? "").toLowerCase().includes(needle) ||
    plugin.publisher.toLowerCase().includes(needle)
  );
}
