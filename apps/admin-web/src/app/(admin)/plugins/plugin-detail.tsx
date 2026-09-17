"use client";

import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/shell/icon";
import { UpdateBadge, UpdateButton, hasUpdate } from "@/components/package-update";
import type { CatalogPluginDto } from "@/lib/api";
import { useT } from "@/lib/i18n-provider";
import { PluginInfo } from "./plugin-info";
import { usePluginLifecycle, type PluginTier } from "./use-plugin-lifecycle";

/**
 * The full detail of one plugin, rendered inside the browser's drawer. It carries
 * the same install / activate / configure lifecycle as {@link PluginCard} — they
 * share `usePluginLifecycle` — but has room to lay everything out top-to-bottom
 * instead of squeezing it into a grid cell.
 */
export function PluginDetail({
  plugin,
  latestVersion = null,
  canInstall,
  canActivate,
  canConfigure,
  tier = "site",
}: {
  plugin: CatalogPluginDto;
  /** Newest version the marketplace offers, when this plugin exists there; else null. */
  latestVersion?: string | null;
  canInstall: boolean;
  canActivate: boolean;
  canConfigure: boolean;
  tier?: PluginTier;
}) {
  const t = useT();
  const life = usePluginLifecycle(plugin, tier, canConfigure);
  const updatable = plugin.installed && hasUpdate(plugin.latestVersion, latestVersion);

  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone={life.status.tone}>{life.status.label}</Badge>
        {updatable ? <UpdateBadge latestVersion={latestVersion!} /> : null}
        {plugin.tier === "PLATFORM" ? (
          <Badge tone="info">{t("plugins.card.tier.platform")}</Badge>
        ) : plugin.tier === "ORG" ? (
          <Badge tone="neutral">{t("plugins.card.tier.org")}</Badge>
        ) : null}
      </div>

      <p className="mt-2 text-[11px] z-muted">
        <code>{plugin.key}</code> · v{plugin.latestVersion ?? "—"} · {plugin.publisher}
      </p>

      <PluginInfo plugin={plugin} granted={life.granted} />

      {life.isFailed && !life.runtimeError ? (
        <p
          role="alert"
          className="mt-3 rounded-md border border-red-200 bg-red-50 px-2.5 py-2 text-[11px] leading-4 text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300"
        >
          {t("plugins.card.failed")}
        </p>
      ) : null}

      {life.runtimeError ? (
        <div
          role="alert"
          className="mt-3 rounded-md border border-red-200 bg-red-50 px-2.5 py-2 dark:border-red-900 dark:bg-red-950/40"
        >
          <p className="text-[11px] font-semibold text-red-700 dark:text-red-300">
            {t("plugins.card.activateFailedTitle")}
          </p>
          <p className="mt-1 break-words font-mono text-[11px] leading-4 text-red-700/90 dark:text-red-300/90">
            {life.runtimeError}
          </p>
        </div>
      ) : null}

      {life.notice ? (
        <p role="status" className="mt-3 text-[11px] text-emerald-600 dark:text-emerald-400">
          {life.notice}
        </p>
      ) : null}

      {life.managedElsewhere ? (
        <p className="mt-4 rounded-md border border-brand-200 bg-brand-50 px-2.5 py-2 text-[11px] leading-4 text-brand-800 dark:border-brand-900 dark:bg-brand-950/40 dark:text-brand-200">
          {t("plugins.card.managedOrgWide")}
        </p>
      ) : (
        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-[var(--border)] pt-4">
          {!plugin.installed ? (
            <Button
              size="sm"
              variant="primary"
              disabled={!canInstall}
              busy={life.pending}
              onClick={life.openConsent}
            >
              {life.pending ? t("plugins.consent.installing") : t("plugins.card.install")}
            </Button>
          ) : (
            <>
              {canActivate ? (
                <Button
                  size="sm"
                  variant={life.isActive ? "secondary" : "primary"}
                  busy={life.pending}
                  onClick={life.toggleActivation}
                >
                  {life.pending
                    ? t("common.working")
                    : life.isActive
                      ? t("plugins.card.deactivate")
                      : t("plugins.card.activate")}
                </Button>
              ) : null}

              {updatable && canInstall ? (
                <UpdateButton kind="plugin" itemKey={plugin.key} latestVersion={latestVersion!} />
              ) : null}

              {canConfigure && plugin.settingsSchema ? (
                <Button size="sm" variant="ghost" disabled={life.pending} onClick={life.openSettings}>
                  <Icon name="settings" className="mr-1 h-4 w-4" />
                  {t("plugins.card.configure")}
                </Button>
              ) : null}

              {life.isActive && plugin.key === "vn.zsoft.plugin.zai" ? (
                <Link
                  href="/zai"
                  className="inline-flex h-8 items-center rounded-md bg-[var(--accent)] px-3 text-xs font-medium text-white"
                >
                  Open zAI
                </Link>
              ) : null}

              {canInstall ? (
                <Button size="sm" variant="ghost" disabled={life.pending} onClick={life.openConsent}>
                  {t("plugins.card.changePermissions")}
                </Button>
              ) : null}

              {/* Destructive and irreversible — kept to the right, away from the
                  reversible switches, and behind a confirmation. */}
              {canInstall ? (
                <Button
                  size="sm"
                  variant="danger"
                  className="ml-auto"
                  disabled={life.pending}
                  onClick={life.openUninstall}
                >
                  <Icon name="trash" className="mr-1 h-4 w-4" />
                  {t("plugins.card.uninstall")}
                </Button>
              ) : null}
            </>
          )}
        </div>
      )}

      {!life.managedElsewhere && !canInstall && !plugin.installed ? (
        <p className="mt-2 text-[11px] z-muted">{t("plugins.card.installDenied")}</p>
      ) : null}

      {life.dialogs}
    </div>
  );
}
