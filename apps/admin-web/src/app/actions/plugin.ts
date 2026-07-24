"use server";

import { revalidatePath } from "next/cache";
import type { Permission } from "@zcmsorg/schemas";
import { ApiError, apiFetch, can, getSession } from "@/lib/api";
import { getT } from "@/lib/locale";
import { isKnownPermission } from "@/lib/plugin-permissions";

export type PluginActionResult = { ok: true; message: string } | { ok: false; error: string };

function toMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.message;
  return fallback;
}

/**
 * Installs (or re-consents to) a plugin with an explicit grant.
 *
 * `granted` is a SUBSET of what the plugin asked for — the admin may uncheck
 * anything on the consent screen. The API rejects a grant that exceeds the
 * manifest with a 400, so the UI must only ever offer `plugin.permissions`;
 * this action does not widen the set, it only forwards it.
 */
export async function installPluginAction(
  key: string,
  granted: string[],
): Promise<PluginActionResult> {
  const t = await getT();

  const user = await getSession();
  if (!user) return { ok: false, error: t("auth.session.expired") };
  if (!can(user, "plugin:install")) {
    return { ok: false, error: t("plugins.actions.installDenied") };
  }

  const grantedPermissions: Permission[] = granted.filter(isKnownPermission);

  try {
    await apiFetch<{ ok: true; granted: Permission[] }>(
      `/plugins/${encodeURIComponent(key)}/install`,
      { method: "POST", body: { grantedPermissions } },
    );
    revalidatePath("/plugins");
    return {
      ok: true,
      message:
        grantedPermissions.length === 0
          ? t("plugins.actions.installedWithoutPermissions")
          : t("plugins.actions.installedWithPermissions", {
              count: grantedPermissions.length,
            }),
    };
  } catch (error) {
    return { ok: false, error: toMessage(error, t("plugins.actions.installFailed")) };
  }
}

/**
 * Activation runs the plugin's setup() inside the sandbox. A 200 with
 * `{ ok: false, error }` means setup() threw and the plugin is now FAILED —
 * that is a failure, and it is reported as one rather than swallowed.
 */
export async function activatePluginAction(key: string): Promise<PluginActionResult> {
  const t = await getT();

  const user = await getSession();
  if (!user) return { ok: false, error: t("auth.session.expired") };
  if (!can(user, "plugin:activate")) {
    return { ok: false, error: t("plugins.actions.activateDenied") };
  }

  try {
    const result = await apiFetch<{ ok: boolean; error?: string }>(
      `/plugins/${encodeURIComponent(key)}/activate`,
      { method: "POST" },
    );
    revalidatePath("/plugins");
    if (!result.ok) {
      return {
        ok: false,
        error: result.error ?? t("plugins.actions.setupFailed"),
      };
    }
    return { ok: true, message: t("plugins.actions.activated") };
  } catch (error) {
    return { ok: false, error: toMessage(error, t("plugins.actions.activateFailed")) };
  }
}

export async function deactivatePluginAction(key: string): Promise<PluginActionResult> {
  const t = await getT();

  const user = await getSession();
  if (!user) return { ok: false, error: t("auth.session.expired") };
  if (!can(user, "plugin:activate")) {
    return { ok: false, error: t("plugins.actions.activateDenied") };
  }

  try {
    await apiFetch<{ ok: true }>(`/plugins/${encodeURIComponent(key)}/deactivate`, {
      method: "POST",
    });
    revalidatePath("/plugins");
    return { ok: true, message: t("plugins.actions.deactivated") };
  } catch (error) {
    return { ok: false, error: toMessage(error, t("plugins.actions.deactivateFailed")) };
  }
}

/** Opaque JSON, exactly like theme settings: the shape belongs to the plugin. */
export async function savePluginSettingsAction(
  key: string,
  settings: Record<string, unknown>,
): Promise<PluginActionResult> {
  const t = await getT();

  const user = await getSession();
  if (!user) return { ok: false, error: t("auth.session.expired") };
  if (!can(user, "plugin:configure")) {
    return { ok: false, error: t("plugins.actions.configureDenied") };
  }

  try {
    await apiFetch<{ ok: true }>(`/plugins/${encodeURIComponent(key)}/settings`, {
      method: "PATCH",
      body: settings,
    });
    revalidatePath("/plugins");
    return { ok: true, message: t("plugins.actions.settingsSaved") };
  } catch (error) {
    return { ok: false, error: toMessage(error, t("plugins.actions.settingsSaveFailed")) };
  }
}
