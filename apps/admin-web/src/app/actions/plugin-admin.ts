"use server";

import { revalidatePath } from "next/cache";
import {
  ApiError,
  createPluginRow,
  deletePluginRow,
  getSession,
  updatePluginRow,
  type PluginRow,
} from "@/lib/api";
import { getT } from "@/lib/locale";

export type PluginRowResult =
  /** `id` is set by create, so the screen can open the record it just made. */
  | { ok: true; id?: string }
  | { ok: false; error: string };

function toMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

/**
 * These are thin pass-throughs to the plugin-admin endpoints, which are where
 * every real check lives: the endpoint resolves the resource from the installed
 * manifest, enforces the resource's own read/write permission against the caller,
 * and builds the query with the audited builders. A server action cannot name a
 * plugin permission ahead of time, so it does not try — it forwards, and the
 * endpoint refuses what it must.
 */

export async function createPluginRowAction(
  pluginKey: string,
  resourceKey: string,
  row: PluginRow,
): Promise<PluginRowResult> {
  const t = await getT();
  if (!(await getSession())) return { ok: false, error: t("auth.session.expired") };
  try {
    const created = await createPluginRow(pluginKey, resourceKey, row);
    revalidatePath(`/x/${pluginKey}/${resourceKey}`);
    const id = created.row?.id;
    return { ok: true, ...(id === null || id === undefined ? {} : { id: String(id) }) };
  } catch (error) {
    return { ok: false, error: toMessage(error, t("common.error")) };
  }
}

export async function updatePluginRowAction(
  pluginKey: string,
  resourceKey: string,
  id: string,
  patch: PluginRow,
): Promise<PluginRowResult> {
  const t = await getT();
  if (!(await getSession())) return { ok: false, error: t("auth.session.expired") };
  try {
    await updatePluginRow(pluginKey, resourceKey, id, patch);
    revalidatePath(`/x/${pluginKey}/${resourceKey}`);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: toMessage(error, t("common.error")) };
  }
}

export async function deletePluginRowAction(
  pluginKey: string,
  resourceKey: string,
  id: string,
): Promise<PluginRowResult> {
  const t = await getT();
  if (!(await getSession())) return { ok: false, error: t("auth.session.expired") };
  try {
    await deletePluginRow(pluginKey, resourceKey, id);
    revalidatePath(`/x/${pluginKey}/${resourceKey}`);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: toMessage(error, t("common.error")) };
  }
}
