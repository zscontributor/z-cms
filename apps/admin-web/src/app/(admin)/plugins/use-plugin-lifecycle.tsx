"use client";

import { useState, useTransition, type ReactNode } from "react";
import {
  activatePluginAction,
  deactivatePluginAction,
  installPluginAction,
  savePluginSettingsAction,
  uninstallPluginAction,
} from "@/app/actions/plugin";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { SchemaSettingsForm } from "@/components/settings/schema-settings-form";
import type { CatalogPluginDto } from "@/lib/api";
import { useT } from "@/lib/i18n-provider";
import { describeStatus } from "@/lib/plugin-permissions";
import { ConsentDialog } from "./consent-dialog";

/** Which lifecycle a caller drives — the per-site screen or the organization screen. */
export type PluginTier = "site" | "org";

export interface PluginLifecycle {
  status: ReturnType<typeof describeStatus>;
  isActive: boolean;
  isFailed: boolean;
  granted: string[] | null;
  needsConsent: boolean;
  /** On the per-site screen, an org-wide plugin runs here but is owned elsewhere. */
  managedElsewhere: boolean;
  pending: boolean;
  notice: string | null;
  runtimeError: string | null;
  settingsOpen: boolean;
  /** Open the consent/permissions dialog (install, or change permissions). */
  openConsent: () => void;
  /** Turn the plugin on or off — routes through consent first when needed. */
  toggleActivation: () => void;
  openSettings: () => void;
  closeSettings: () => void;
  /** Open the irreversible-uninstall confirmation. */
  openUninstall: () => void;
  /** The modal dialogs (consent + settings + uninstall). Render once, anywhere. */
  dialogs: ReactNode;
}

/**
 * The whole install / activate / consent / configure lifecycle of a single
 * plugin, lifted out of the card so a list row's detail drawer can drive the
 * exact same behaviour — one source of truth for both the site and org screens.
 *
 * The two nested `<dialog>`s (consent + settings) come back as `dialogs`: the
 * caller renders them wherever it likes and the top-layer stacking sorts out
 * showing them above whatever opened them (a card, or the detail drawer).
 */
export function usePluginLifecycle(
  plugin: CatalogPluginDto,
  tier: PluginTier,
  canConfigure: boolean,
): PluginLifecycle {
  const t = useT();

  // On the per-site screen, a plugin the tenant turned on org-wide runs here but is
  // owned by the organization screen: show it, but let no site-level button touch it.
  const managedElsewhere = tier === "site" && plugin.orgActive;
  const [consentOpen, setConsentOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [uninstallOpen, setUninstallOpen] = useState(false);
  const [consentError, setConsentError] = useState<string | null>(null);
  const [uninstallError, setUninstallError] = useState<string | null>(null);
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
      const result = await installPluginAction(plugin.key, next, tier);
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
        const activated = await activatePluginAction(plugin.key, tier);
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
        ? await deactivatePluginAction(plugin.key, tier)
        : await activatePluginAction(plugin.key, tier);

      // A failed setup() comes back as { ok: false, error } with HTTP 200. It is
      // still a failure: the plugin is now FAILED, and saying otherwise would be
      // a lie the admin discovers on the live site.
      if (!result.ok) setRuntimeError(result.error);
      else setNotice(result.message);
    });
  }

  function confirmUninstall() {
    setUninstallError(null);
    startTransition(async () => {
      const result = await uninstallPluginAction(plugin.key, tier);
      if (!result.ok) {
        setUninstallError(result.error);
        return;
      }
      setUninstallOpen(false);
      setRuntimeError(null);
      // The plugin drops back to "not installed" after revalidation; leave the
      // panel open on its new state and say what happened.
      setNotice(result.message);
    });
  }

  const dialogs = (
    <>
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
            onSave={(values) => savePluginSettingsAction(plugin.key, values, tier)}
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

      <Dialog
        open={uninstallOpen}
        onClose={() => setUninstallOpen(false)}
        title={t("plugins.confirmUninstall.title", { name: plugin.name })}
        footer={
          <>
            <Button variant="secondary" onClick={() => setUninstallOpen(false)} disabled={pending}>
              {t("common.cancel")}
            </Button>
            <Button variant="destructive" onClick={confirmUninstall} disabled={pending}>
              {pending ? t("common.working") : t("plugins.confirmUninstall.confirm")}
            </Button>
          </>
        }
      >
        <p className="text-xs leading-5 z-muted">{t("plugins.confirmUninstall.body")}</p>
        <p className="mt-2 text-xs leading-5 text-red-700 dark:text-red-300">
          {t("plugins.confirmUninstall.irreversible")}
        </p>
        {uninstallError ? (
          <p
            role="alert"
            className="mt-3 rounded-md border border-red-200 bg-red-50 px-2.5 py-2 text-[11px] leading-4 text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300"
          >
            {uninstallError}
          </p>
        ) : null}
      </Dialog>
    </>
  );

  return {
    status,
    isActive,
    isFailed,
    granted,
    needsConsent,
    managedElsewhere,
    pending,
    notice,
    runtimeError,
    settingsOpen,
    openConsent: () => {
      setConsentError(null);
      setConsentOpen(true);
    },
    toggleActivation,
    openSettings: () => setSettingsOpen(true),
    closeSettings: () => setSettingsOpen(false),
    openUninstall: () => {
      setUninstallError(null);
      setUninstallOpen(true);
    },
    dialogs,
  };
}
