"use server";

import { revalidatePath } from "next/cache";
import { ApiError, apiFetch, can, getSession, type PackageKind } from "@/lib/api";
import { getT } from "@/lib/locale";

export type SideloadActionResult =
  | { ok: true; message: string }
  | { ok: false; error: string };

function segment(value: string): string {
  return encodeURIComponent(value);
}

function scopeFor(kind: PackageKind): "theme:sideload" | "plugin:sideload" {
  return kind === "theme" ? "theme:sideload" : "plugin:sideload";
}

function revalidateFor(kind: PackageKind): void {
  revalidatePath(kind === "theme" ? "/appearance" : "/plugins");
}

/**
 * Installs a theme or plugin from an uploaded, operator-signed `.zcms`.
 *
 * A server action is a public endpoint, so the scope is re-checked here rather than
 * trusted from a hidden button. The heavy lifting — verify against the operator key,
 * scan, refuse an impersonating id, store QUARANTINED — is all on cms-api; this only
 * relays the file and re-scopes.
 */
export async function sideloadAction(
  kind: PackageKind,
  formData: FormData,
): Promise<SideloadActionResult> {
  const t = await getT();

  const user = await getSession();
  if (!user) return { ok: false, error: t("auth.session.expired") };
  if (!can(user, scopeFor(kind))) {
    return { ok: false, error: t("appearance.sideload.denied") };
  }

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, error: t("appearance.sideload.noFile") };
  }

  // Rebuild the FormData so the React action id and any other stray fields do not
  // reach the API's multipart parser.
  const upload = new FormData();
  upload.set("file", file, file.name);

  try {
    const res = await apiFetch<{ key: string; version: string; reviewStatus: string }>(
      `/sideload/${segment(kind)}`,
      { method: "POST", formData: upload, siteScoped: false },
    );
    revalidateFor(kind);
    return {
      ok: true,
      message: t("appearance.sideload.uploaded", { name: res.key, version: res.version }),
    };
  } catch (error) {
    const message =
      error instanceof ApiError ? error.message : t("appearance.sideload.uploadFailed");
    return { ok: false, error: message };
  }
}

/** Approves a quarantined sideload so runtimes may fetch it. */
export async function approveSideloadAction(
  kind: PackageKind,
  key: string,
  version: string,
): Promise<SideloadActionResult> {
  const t = await getT();

  const user = await getSession();
  if (!user) return { ok: false, error: t("auth.session.expired") };
  if (!can(user, scopeFor(kind))) {
    return { ok: false, error: t("appearance.sideload.denied") };
  }

  try {
    await apiFetch<{ ok: boolean }>(
      `/sideload/${segment(kind)}/${segment(key)}/${segment(version)}/approve`,
      { method: "POST", siteScoped: false },
    );
    revalidateFor(kind);
    revalidatePath("/", "layout");
    return { ok: true, message: t("appearance.sideload.approved", { name: key }) };
  } catch (error) {
    const message =
      error instanceof ApiError ? error.message : t("appearance.sideload.actionFailed");
    return { ok: false, error: message };
  }
}

/** Uninstalls a sideload: falls sites back, purges runtimes, deletes rows + bytes. */
export async function uninstallSideloadAction(
  kind: PackageKind,
  key: string,
  version: string,
): Promise<SideloadActionResult> {
  const t = await getT();

  const user = await getSession();
  if (!user) return { ok: false, error: t("auth.session.expired") };
  if (!can(user, scopeFor(kind))) {
    return { ok: false, error: t("appearance.sideload.denied") };
  }

  try {
    await apiFetch<{ ok: boolean }>(
      `/sideload/${segment(kind)}/${segment(key)}/${segment(version)}`,
      { method: "DELETE", siteScoped: false },
    );
    revalidateFor(kind);
    revalidatePath("/", "layout");
    return { ok: true, message: t("appearance.sideload.removed", { name: key }) };
  } catch (error) {
    const message =
      error instanceof ApiError ? error.message : t("appearance.sideload.actionFailed");
    return { ok: false, error: message };
  }
}
