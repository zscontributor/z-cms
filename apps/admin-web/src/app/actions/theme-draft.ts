"use server";

import { revalidatePath } from "next/cache";
import type { LayoutDocument } from "@zcmsorg/schemas";
import { ApiError, apiFetch, can, getSession } from "@/lib/api";
import type { ThemeDraftDto } from "@/lib/api";
import { getT } from "@/lib/locale";

/**
 * The Theme Editor's writes.
 *
 * Every one of these re-checks `theme:author` even though the API checks it too.
 * That is not redundancy for its own sake: a server action is a public endpoint —
 * Next.js will happily invoke it for anyone who can reach the app — so "the button
 * was hidden" is not an authorisation control. The API's check is the one that
 * matters; this one keeps a denied action from looking like a network error.
 */

export type DraftActionResult<T = void> =
  | { ok: true; data: T }
  | { ok: false; error: string };

function toMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.message;
  return fallback;
}

export async function createThemeDraftAction(input: {
  name: string;
  key: string;
  description?: string;
}): Promise<DraftActionResult<ThemeDraftDto>> {
  const t = await getT();
  const user = await getSession();
  if (!user) return { ok: false, error: t("auth.session.expired") };
  if (!can(user, "theme:author")) return { ok: false, error: t("themeEditor.errors.denied") };

  try {
    const draft = await apiFetch<ThemeDraftDto>("/theme-drafts", {
      method: "POST",
      body: input,
    });
    revalidatePath("/appearance");
    return { ok: true, data: draft };
  } catch (error) {
    return { ok: false, error: toMessage(error, t("themeEditor.errors.createFailed")) };
  }
}

/**
 * Saves the drawing.
 *
 * The document goes up whole rather than as a patch of the node that changed. A
 * layout is a tree, and the operations the editor performs on it — move this widget
 * into that column, delete a section with everything in it — are not expressible as
 * a field update. Sending the tree means the server validates the thing it is about
 * to store, not a delta whose result it would have to compute first.
 */
export async function saveThemeDraftAction(
  id: string,
  patch: { name?: string; description?: string; version?: string; document?: LayoutDocument },
): Promise<DraftActionResult<ThemeDraftDto>> {
  const t = await getT();
  const user = await getSession();
  if (!user) return { ok: false, error: t("auth.session.expired") };
  if (!can(user, "theme:author")) return { ok: false, error: t("themeEditor.errors.denied") };

  try {
    const draft = await apiFetch<ThemeDraftDto>(`/theme-drafts/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: patch,
    });
    return { ok: true, data: draft };
  } catch (error) {
    return { ok: false, error: toMessage(error, t("themeEditor.errors.saveFailed")) };
  }
}

/**
 * Turns the design into a signed, installed theme.
 *
 * Gated on `theme:sideload`, not `theme:author` — the same permission a file upload
 * needs, because this is the same act: putting code nobody reviewed onto the
 * server. Drawing is not building, and the person allowed to move a widget is not
 * automatically the person allowed to install one.
 */
export async function buildThemeDraftAction(id: string): Promise<DraftActionResult> {
  const t = await getT();
  const user = await getSession();
  if (!user) return { ok: false, error: t("auth.session.expired") };
  if (!can(user, "theme:sideload")) {
    return { ok: false, error: t("themeEditor.errors.buildDenied") };
  }

  try {
    await apiFetch<unknown>(`/theme-drafts/${encodeURIComponent(id)}/build`, { method: "POST" });
    revalidatePath("/appearance");
    return { ok: true, data: undefined };
  } catch (error) {
    return { ok: false, error: toMessage(error, t("themeEditor.errors.buildFailed")) };
  }
}

export async function deleteThemeDraftAction(id: string): Promise<DraftActionResult> {
  const t = await getT();
  const user = await getSession();
  if (!user) return { ok: false, error: t("auth.session.expired") };
  if (!can(user, "theme:author")) return { ok: false, error: t("themeEditor.errors.denied") };

  try {
    await apiFetch<unknown>(`/theme-drafts/${encodeURIComponent(id)}`, { method: "DELETE" });
    revalidatePath("/appearance");
    return { ok: true, data: undefined };
  } catch (error) {
    return { ok: false, error: toMessage(error, t("themeEditor.errors.deleteFailed")) };
  }
}
