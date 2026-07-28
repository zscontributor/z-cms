"use server";

import { revalidatePath } from "next/cache";
import type { MenuDto } from "@zcmsorg/schemas";
import { ApiError, apiFetch, can, getSession } from "@/lib/api";
import { getT } from "@/lib/locale";

/** One item as the PUT endpoint accepts it — no server-assigned id, nested children. */
export interface MenuItemInput {
  label: string;
  /** Per-locale label overrides, keyed by locale. Empty values are dropped server-side. */
  labels?: Record<string, string>;
  url: string;
  target?: string;
  children?: MenuItemInput[];
}

export type SaveMenuResult =
  | { ok: true; message: string; menu: MenuDto }
  | { ok: false; error: string };

/**
 * Create or replace a menu at a location. The cms-api endpoint is whole-tree and
 * idempotent (PUT /menus/:key), so this sends the entire menu the admin edited and
 * gets back the menu as it now stands.
 */
export async function saveMenuAction(input: {
  key: string;
  name: string;
  items: MenuItemInput[];
}): Promise<SaveMenuResult> {
  const t = await getT();

  const user = await getSession();
  if (!user) return { ok: false, error: t("auth.session.expired") };
  if (!can(user, "menu:manage")) return { ok: false, error: t("admin.menus.readOnly") };

  const key = input.key.trim();
  if (!key) return { ok: false, error: t("admin.menus.saveError") };

  try {
    const menu = await apiFetch<MenuDto>(`/menus/${encodeURIComponent(key)}`, {
      method: "PUT",
      body: { name: input.name.trim() || key, items: input.items },
    });

    // The menu is in the header of every page; the public site's cache is dropped
    // by cms-api, and the admin's own list needs to reflect the save.
    revalidatePath("/menus");

    return { ok: true, message: t("admin.menus.saved"), menu };
  } catch (error) {
    if (error instanceof ApiError) return { ok: false, error: error.message };
    return { ok: false, error: t("admin.menus.saveError") };
  }
}
