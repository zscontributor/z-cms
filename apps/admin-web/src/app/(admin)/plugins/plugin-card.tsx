"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import {
  activatePluginAction,
  deactivatePluginAction,
  installPluginAction,
  savePluginSettingsAction,
} from "@/app/actions/plugin";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { SchemaSettingsForm } from "@/components/settings/schema-settings-form";
import { Icon } from "@/components/shell/icon";
import type { CatalogPluginDto } from "@/lib/api";
import { useT } from "@/lib/i18n-provider";
import { describePermission, describeStatus } from "@/lib/plugin-permissions";
import { ConsentDialog } from "./consent-dialog";

export function PluginCard({
  plugin,
  canInstall,
  canActivate,
  canConfigure,
}: {
  plugin: CatalogPluginDto;
  canInstall: boolean;
  canActivate: boolean;
  canConfigure: boolean;
}) {
  const t = useT();
  const [consentOpen, setConsentOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [consentError, setConsentError] = useState<string | null>(null);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const status = describeStatus(plugin.status, plugin.installed, t);
  const isActive = plugin.installed && plugin.status === "ACTIVE";
  const isFailed = plugin.installed && plugin.status === "FAILED";
  const granted = plugin.grantedPermissions ?? null;

  /**
   * Has the admin actually seen this plugin's permissions?
   *
   * A core plugin arrives pre-installed and switched off, with NOTHING granted — so
   * `installed` no longer implies `consented`, which it used to. Turning one on
   * without asking would activate a plugin holding `network:fetch` on the strength
   * of a decision nobody made.
   *
   * True when the plugin wants something it has not been given. An admin who
   * deliberately declined a scope is not nagged: they granted a subset, the subset is
   * what they granted, and the plugin runs with it.
   */
  const needsConsent =
    plugin.permissions.length > 0 && (granted === null || granted.length === 0);

  function confirmConsent(next: string[]) {
    setConsentError(null);
    startTransition(async () => {
      const result = await installPluginAction(plugin.key, next);
      if (!result.ok) {
        setConsentError(result.error);
        return;
      }
      setConsentOpen(false);
      setRuntimeError(null);
      setNotice(result.message);

      // Consent was the thing standing between the admin and the switch they just
      // reached for. Granting is not the goal — running the plugin is — so finish
      // the job rather than making them press it twice.
      if (!isActive) {
        const activated = await activatePluginAction(plugin.key);
        if (!activated.ok) setRuntimeError(activated.error);
        else setNotice(activated.message);
      }
    });
  }

  function toggleActivation() {
    setRuntimeError(null);
    setNotice(null);

    // Switching a plugin ON is where consent happens for a pre-installed core plugin.
    // The dialog is where the admin learns zAI reaches api.openai.com and two other
    // hosts; skipping it for the plugins we happen to ship would make the consent
    // screen mean nothing precisely where it should mean the most.
    if (!isActive && needsConsent) {
      setConsentError(null);
      setConsentOpen(true);
      return;
    }

    startTransition(async () => {
      const result = isActive
        ? await deactivatePluginAction(plugin.key)
        : await activatePluginAction(plugin.key);

      // A failed setup() comes back as { ok: false, error } with HTTP 200. It is
      // still a failure: the plugin is now FAILED, and saying otherwise would be
      // a lie the admin discovers on the live site.
      if (!result.ok) setRuntimeError(result.error);
      else setNotice(result.message);
    });
  }

  return (
    <article
      className={
        isActive
          ? "z-card relative flex flex-col border-brand-500 p-4 ring-1 ring-brand-500/30"
          : "z-card relative flex flex-col p-4"
      }
    >
      {canConfigure && plugin.installed && plugin.settingsSchema ? (
        <Button
          size="sm"
          variant="ghost"
          className="absolute right-2 top-2 h-8 w-8 px-0"
          onClick={() => setSettingsOpen(true)}
          aria-label={t("plugins.card.configure")}
        >
          <Icon name="settings" className="h-4 w-4" />
        </Button>
      ) : null}

      <header className="flex items-start justify-between gap-2">
        <div className="min-w-0 pr-8">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold">
            <span className="truncate">{plugin.name}</span>
            {plugin.isCore ? <Badge tone="info">{t("plugins.card.core")}</Badge> : null}
          </h2>
          <p className="mt-0.5 text-[11px] z-muted">
            <code>{plugin.key}</code> · v{plugin.latestVersion ?? "—"} · {plugin.publisher}
          </p>
        </div>
        <Badge tone={status.tone} className="mr-8">
          {status.label}
        </Badge>
      </header>

      <p className="mt-2 line-clamp-3 min-h-8 text-xs z-muted">
        {plugin.description ?? t("plugins.card.noDescription")}
      </p>

      {plugin.capabilities.length > 0 ? (
        <div className="mt-3">
          <p className="text-[10px] font-semibold uppercase tracking-wider z-muted">
            {t("plugins.card.capabilities")}
          </p>
          <ul className="mt-1 flex flex-wrap gap-1">
            {plugin.capabilities.map((capability) => (
              <li key={capability}>
                <Badge tone="neutral" className="font-mono">
                  {capability}
                </Badge>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {plugin.installed ? (
        <div className="mt-3">
          <p className="text-[10px] font-semibold uppercase tracking-wider z-muted">
            {t("plugins.card.grantedHeading")}
          </p>
          {granted === null ? (
            <p className="mt-1 text-[11px] z-muted">{t("plugins.card.grantedUnknown")}</p>
          ) : granted.length === 0 ? (
            <p className="mt-1 text-[11px] z-muted">{t("plugins.card.grantedNone")}</p>
          ) : (
            <ul className="mt-1 flex flex-col gap-0.5">
              {granted.map((permission) => {
                const copy = describePermission(permission, t);
                return (
                  <li
                    key={permission}
                    className="flex items-start gap-1.5 text-[11px] leading-4"
                  >
                    <Icon
                      name="check"
                      size={16}
                      className={
                        copy.sensitive
                          ? "mt-0.5 shrink-0 text-amber-600 dark:text-amber-400"
                          : "mt-0.5 shrink-0 text-brand-500"
                      }
                    />
                    <span>{copy.label}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : plugin.permissions.length > 0 ? (
        <p className="mt-3 text-[11px] z-muted">
          {t("plugins.card.requests", { count: plugin.permissions.length })}
        </p>
      ) : (
        <p className="mt-3 text-[11px] z-muted">{t("plugins.card.requestsNone")}</p>
      )}

      {isFailed && !runtimeError ? (
        <p
          role="alert"
          className="mt-3 rounded-md border border-red-200 bg-red-50 px-2.5 py-2 text-[11px] leading-4 text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300"
        >
          {t("plugins.card.failed")}
        </p>
      ) : null}

      {runtimeError ? (
        <div
          role="alert"
          className="mt-3 rounded-md border border-red-200 bg-red-50 px-2.5 py-2 dark:border-red-900 dark:bg-red-950/40"
        >
          <p className="text-[11px] font-semibold text-red-700 dark:text-red-300">
            {t("plugins.card.activateFailedTitle")}
          </p>
          <p className="mt-1 break-words font-mono text-[11px] leading-4 text-red-700/90 dark:text-red-300/90">
            {runtimeError}
          </p>
        </div>
      ) : null}

      {notice ? (
        <p role="status" className="mt-3 text-[11px] text-emerald-600 dark:text-emerald-400">
          {notice}
        </p>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-2 pt-1">
        {!plugin.installed ? (
          <Button
            size="sm"
            variant="primary"
            disabled={!canInstall || pending}
            onClick={() => {
              setConsentError(null);
              setConsentOpen(true);
            }}
          >
            {t("plugins.card.install")}
          </Button>
        ) : (
          <>
            {canActivate ? (
              <Button
                size="sm"
                variant={isActive ? "secondary" : "primary"}
                disabled={pending}
                onClick={toggleActivation}
              >
                {pending
                  ? t("common.working")
                  : isActive
                    ? t("plugins.card.deactivate")
                    : t("plugins.card.activate")}
              </Button>
            ) : null}

            {isActive && plugin.key === "vn.zsoft.plugin.zai" ? (
              <Link href="/zai" className="inline-flex h-8 items-center rounded-md bg-[var(--accent)] px-3 text-xs font-medium text-white">
                Open zAI
              </Link>
            ) : null}

            {canInstall ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={pending}
                onClick={() => {
                  setConsentError(null);
                  setConsentOpen(true);
                }}
              >
                {t("plugins.card.changePermissions")}
              </Button>
            ) : null}
          </>
        )}
      </div>

      {!canInstall && !plugin.installed ? (
        <p className="mt-2 text-[11px] z-muted">{t("plugins.card.installDenied")}</p>
      ) : null}

      <Dialog
        open={plugin.installed && settingsOpen && Boolean(plugin.settingsSchema)}
        onClose={() => setSettingsOpen(false)}
        title={t("plugins.card.configure")}
        description={t("plugins.card.settingsGenerated")}
        className="w-[min(44rem,calc(100vw-2rem))]"
      >
        {plugin.settingsSchema ? (
          <SchemaSettingsForm
            idPrefix={`plugin-${plugin.key}`}
            schema={plugin.settingsSchema}
            settings={plugin.settings ?? {}}
            disabled={!canConfigure}
            onSave={(values) => savePluginSettingsAction(plugin.key, values)}
            emptyText={t("plugins.settings.empty")}
            deniedText={t("plugins.settings.denied")}
          />
        ) : null}
      </Dialog>

      <ConsentDialog
        open={consentOpen}
        onClose={() => setConsentOpen(false)}
        onConfirm={confirmConsent}
        pluginName={plugin.name}
        publisher={plugin.publisher}
        permissions={plugin.permissions}
        networkHosts={plugin.networkHosts}
        initialGranted={granted}
        mode={plugin.installed ? "update" : "install"}
        pending={pending}
        error={consentError}
      />
    </article>
  );
}
