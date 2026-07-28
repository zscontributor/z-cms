"use client";

import { useMemo, useRef, useState } from "react";
import type { CatalogPluginDto } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Drawer } from "@/components/ui/drawer";
import { EmptyState } from "@/components/ui/table";
import { SearchField } from "@/components/ui/search-field";
import { SideloadActions, SideloadUpload } from "@/components/sideload-controls";
import { useT } from "@/lib/i18n-provider";
import { describeStatus } from "@/lib/plugin-permissions";
import { PluginDetail } from "./plugin-detail";
import { PluginRow } from "./plugin-row";

/**
 * The plugin catalogue as three lists — sideloaded, installed and available —
 * with one search box filtering every shelf client-side. Rows are deliberately
 * compact: the number of plugins grows without bound, so a scannable list beats
 * a wall of cards. Clicking any row opens a detail drawer where the actual
 * install / activate / configure lifecycle lives.
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
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
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

  // Resolve the open plugin from the current props every render, keyed only on
  // its key. A lifecycle action revalidates the page and hands down a fresh
  // object; looking it up again means the drawer shows the new state instead of
  // the stale snapshot captured when it opened.
  const selected = useMemo(() => {
    if (!selectedKey) return null;
    return (
      installed.find((p) => p.key === selectedKey) ??
      available.find((p) => p.key === selectedKey) ??
      sideloaded.find((p) => p.key === selectedKey) ??
      null
    );
  }, [selectedKey, installed, available, sideloaded]);

  // The drawer keeps its content mounted so it can slide out fully drawn. While it
  // closes, `selected` is already null — so fall back to the last plugin shown, and
  // the panel animates away with content instead of flickering to empty.
  const lastShown = useRef<CatalogPluginDto | null>(null);
  if (selected) lastShown.current = selected;
  const shown = selected ?? lastShown.current;
  const shownIsSideload = shown != null && sideloaded.some((p) => p.key === shown.key);

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
        <div className="mb-4 flex justify-start">
          <SearchField
            value={query}
            onChange={setQuery}
            placeholder={t("plugins.searchPlaceholder")}
            className="w-full sm:max-w-xs"
          />
        </div>
      )}

      {canSideload ? (
        <section className="z-card mb-6 p-4">
          <h2 className="text-sm font-semibold">{t("appearance.sideload.heading")}</h2>
          <p className="mt-0.5 text-[11px] z-muted">{t("plugins.sideloadHint")}</p>
          <div className="mt-3 flex justify-start">
            <SideloadUpload kind="plugin" />
          </div>
        </section>
      ) : null}

      {filteredSideloaded.length > 0 ? (
        <section className="mb-6">
          <h2 className="mb-2 text-sm font-semibold">{t("plugins.sideloadedHeading")}</h2>
          <PluginList>
            {filteredSideloaded.map((plugin) => {
              const approved = plugin.reviewStatus === "APPROVED";
              return (
                <PluginRow
                  key={plugin.key}
                  plugin={plugin}
                  selected={selectedKey === plugin.key}
                  onOpen={() => setSelectedKey(plugin.key)}
                  badge={
                    <Badge tone={approved ? "warning" : "danger"}>
                      {approved
                        ? t("appearance.sideload.unverified")
                        : t("appearance.sideload.pending")}
                    </Badge>
                  }
                />
              );
            })}
          </PluginList>
        </section>
      ) : null}

      {filteredInstalled.length > 0 ? (
        <section className="mb-6">
          <h2 className="mb-2 text-sm font-semibold">{t("plugins.installedHeading")}</h2>
          <PluginList>
            {filteredInstalled.map((plugin) => (
              <ManagedRow
                key={plugin.key}
                plugin={plugin}
                selected={selectedKey === plugin.key}
                onOpen={() => setSelectedKey(plugin.key)}
              />
            ))}
          </PluginList>
        </section>
      ) : null}

      {filteredAvailable.length > 0 ? (
        <section>
          <h2 className="mb-2 text-sm font-semibold">{t("plugins.catalogHeading")}</h2>
          <PluginList>
            {filteredAvailable.map((plugin) => (
              <ManagedRow
                key={plugin.key}
                plugin={plugin}
                selected={selectedKey === plugin.key}
                onOpen={() => setSelectedKey(plugin.key)}
              />
            ))}
          </PluginList>
        </section>
      ) : null}

      {noMatches ? (
        <p className="z-card p-8 text-center text-sm z-muted">{t("plugins.noMatch")}</p>
      ) : null}

      <Drawer
        open={selected != null}
        onClose={() => setSelectedKey(null)}
        title={shown?.name ?? ""}
        description={shown?.key}
        width="md"
      >
        {shown ? (
          shownIsSideload ? (
            <SideloadDetail plugin={shown} canSideload={canSideload} />
          ) : (
            <PluginDetail
              // Reset the detail's local state when a different plugin opens; a
              // revalidation keeps the same key so its notice/error survive.
              key={shown.key}
              plugin={shown}
              canInstall={canInstall}
              canActivate={canActivate}
              canConfigure={canConfigure}
            />
          )
        ) : null}
      </Drawer>
    </>
  );
}

/** The bordered card that turns a set of rows into one divided list. */
function PluginList({ children }: { children: React.ReactNode }) {
  return (
    <div className="z-card divide-y divide-[var(--border)] overflow-hidden">{children}</div>
  );
}

/** A row for an installed/available plugin — its badge is the install status. */
function ManagedRow({
  plugin,
  selected,
  onOpen,
}: {
  plugin: CatalogPluginDto;
  selected: boolean;
  onOpen: () => void;
}) {
  const t = useT();
  const status = describeStatus(plugin.status, plugin.installed, t);
  return (
    <PluginRow
      plugin={plugin}
      selected={selected}
      onOpen={onOpen}
      badge={<Badge tone={status.tone}>{status.label}</Badge>}
    />
  );
}

/** The drawer body for a sideloaded plugin — no lifecycle, just review actions. */
function SideloadDetail({
  plugin,
  canSideload,
}: {
  plugin: CatalogPluginDto;
  canSideload: boolean;
}) {
  const t = useT();
  const approved = plugin.reviewStatus === "APPROVED";
  return (
    <div className="flex flex-col">
      <div>
        <Badge tone={approved ? "warning" : "danger"}>
          {approved ? t("appearance.sideload.unverified") : t("appearance.sideload.pending")}
        </Badge>
      </div>

      <p className="mt-2 text-[11px] z-muted">
        <code>{plugin.key}</code>
        {plugin.latestVersion ? ` · v${plugin.latestVersion}` : null} · {plugin.publisher}
      </p>

      {plugin.description ? (
        <p className="mt-2 text-xs leading-5 z-muted">{plugin.description}</p>
      ) : null}

      {approved ? (
        <p className="mt-3 text-[11px] z-muted">{t("plugins.sideloadApprovedHint")}</p>
      ) : null}

      {canSideload && plugin.latestVersion ? (
        <SideloadActions
          kind="plugin"
          itemKey={plugin.key}
          version={plugin.latestVersion}
          reviewStatus={plugin.reviewStatus ?? "QUARANTINED"}
        />
      ) : null}
    </div>
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
