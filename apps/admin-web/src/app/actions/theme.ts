"use server";

import { revalidatePath } from "next/cache";
import { ApiError, apiFetch, can, getSession } from "@/lib/api";
import { getT } from "@/lib/locale";

export type ThemeActionResult = { ok: true; message: string } | { ok: false; error: string };

function toMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.message;
  return fallback;
}

export async function activateThemeAction(formData: FormData): Promise<void> {
  const t = await getT();

  const key = String(formData.get("key") ?? "");
  if (!key) throw new Error(t("appearance.errors.missingKey"));

  const user = await getSession();
  if (!user || !can(user, "theme:activate")) {
    throw new Error(t("appearance.errors.activateDenied"));
  }

  await apiFetch<unknown>(`/themes/${encodeURIComponent(key)}/activate`, { method: "POST" });

  revalidatePath("/appearance");
  revalidatePath("/", "layout");
}

/**
 * The settings object is whatever the theme's settingsSchema declared — the
 * admin never types it. Coercion from the form's strings back to number/boolean
 * happens on the client, where the schema is in hand; here it is opaque JSON.
 */
export async function saveThemeSettingsAction(
  key: string,
  settings: Record<string, unknown>,
): Promise<ThemeActionResult> {
  const t = await getT();

  const user = await getSession();
  if (!user) return { ok: false, error: t("auth.session.expired") };
  if (!can(user, "theme:configure")) {
    return { ok: false, error: t("appearance.settings.denied") };
  }

  try {
    await apiFetch<unknown>(`/themes/${encodeURIComponent(key)}/settings`, {
      method: "PATCH",
      body: settings,
    });
    revalidatePath("/appearance");
    return { ok: true, message: t("appearance.settings.saved") };
  } catch (error) {
    return { ok: false, error: toMessage(error, t("appearance.settings.saveFailed")) };
  }
}

export async function seedActiveThemeDemoAction(): Promise<ThemeActionResult> {
  const t = await getT();

  const user = await getSession();
  if (!user) return { ok: false, error: t("auth.session.expired") };
  if (!can(user, "theme:configure")) {
    return { ok: false, error: t("appearance.demo.denied") };
  }

  try {
    const result = await apiFetch<{ content: number; menus: number }>(
      "/themes/active/demo-seed",
      { method: "POST" },
    );
    revalidatePath("/appearance");
    revalidatePath("/", "layout");
    return {
      ok: true,
      message: t("appearance.demo.seeded", {
        content: result.content,
        menus: result.menus,
      }),
    };
  } catch (error) {
    return { ok: false, error: toMessage(error, t("appearance.demo.seedFailed")) };
  }
}
