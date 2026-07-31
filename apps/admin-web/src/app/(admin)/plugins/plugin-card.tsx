"use client";

import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/shell/icon";
import type { CatalogPluginDto } from "@/lib/api";
import { useT } from "@/lib/i18n-provider";
import { PluginInfo } from "./plugin-info";
import { usePluginLifecycle, type PluginTier } from "./use-plugin-lifecycle";

export function PluginCard({
  plugin,
  canInstall,
  canActivate,
  canConfigure,
  tier = "site",
}: {
  plugin: CatalogPluginDto;
  canInstall: boolean;
  canActivate: boolean;
  canConfigure: boolean;
  /** Which lifecycle the card drives — the per-site screen or the organization screen. */
  tier?: PluginTier;
}) {
  const t = useT();
  const life = usePluginLifecycle(plugin, tier, canConfigure);

  return (
    <article
      className={
        life.isActive
          ? "z-card relative flex flex-col border-brand-500 p-4 ring-1 ring-brand-500/30"
          : "z-card relative flex flex-col p-4"
      }
    >
      {canConfigure && plugin.installed && plugin.settingsSchema ? (
        <Button
          size="sm"
          variant="ghost"
          className="absolute right-2 top-2 h-8 w-8 px-0"
          onClick={life.openSettings}
          aria-label={t("plugins.card.configure")}
        >
          <Icon name="settings" className="h-4 w-4" />
        </Button>
      ) : null}

      <header className="flex items-start justify-between gap-2">
        <div className="min-w-0 pr-8">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold">
            <span className="truncate">{plugin.name}</span>
            {plugin.tier === "PLATFORM" ? (
              <Badge tone="info">{t("plugins.card.tier.platform")}</Badge>
            ) : plugin.tier === "ORG" ? (
              <Badge tone="neutral">{t("plugins.card.tier.org")}</Badge>
            ) : null}
          </h2>
          <p className="mt-0.5 text-[11px] z-muted">
            <code>{plugin.key}</code> · v{plugin.latestVersion ?? "—"} · {plugin.publisher}
          </p>
        </div>
        <Badge tone={life.status.tone} className="mr-8">
          {life.status.label}
        </Badge>
      </header>

      <PluginInfo plugin={plugin} granted={life.granted} descriptionClamp />

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
        <div className="mt-4 flex flex-wrap items-center gap-2 pt-1">
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

              {life.isActive && plugin.key === "vn.zsoft.plugin.zai" ? (
                <Link
                  href="/zai"
                  className="inline-flex h-8 items-center rounded-md bg-[var(--accent)] px-3 text-xs font-medium text-white"
                >
                  Open zAI
                </Link>
              ) : null}

              {canInstall ? (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={life.pending}
                  onClick={life.openConsent}
                >
                  {t("plugins.card.changePermissions")}
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
    </article>
  );
}
