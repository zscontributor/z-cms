"use server";

import { revalidatePath } from "next/cache";
import {
  BulkDeleteMediaSchema,
  BulkMoveMediaSchema,
  CreateMediaFolderSchema,
  UpdateMediaFolderSchema,
  UpdateMediaSchema,
  type MediaDto,
  type MediaFolderDto,
  type Permission,
} from "@zcmsorg/schemas";
import { ApiError, apiFetch, can, getSession } from "@/lib/api";
import { getT } from "@/lib/locale";

export type UploadResult = { ok: true; media: MediaDto } | { ok: false; error: string };

/**
 * Every media mutation is fired from a dialog on the library page, so none of
 * them throw: the dialog renders the message next to the field that caused it,
 * and an error boundary would throw away the half-typed name the user is still
 * holding.
 */
export type ActionResult<T = void> = { ok: true; data: T } | { ok: false; error: string };

const MAX_BYTES = 20 * 1024 * 1024;

async function denied(permission: Permission): Promise<string | null> {
  const t = await getT();
  const user = await getSession();
  if (!user) return t("auth.session.expired");
  if (!can(user, permission)) return t("auth.forbidden");
  return null;
}

async function toMessage(error: unknown, fallbackKey: string): Promise<string> {
  if (error instanceof ApiError) return error.message;
  return (await getT())(fallbackKey);
}

async function invalid(issues: { message: string }[]): Promise<string> {
  const t = await getT();
  return issues[0]?.message ?? t("common.invalidData");
}

export async function uploadMediaAction(formData: FormData): Promise<UploadResult> {
  const t = await getT();

  const message = await denied("media:upload");
  if (message) return { ok: false, error: message };

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, error: t("media.errors.noFile") };
  }
  if (file.size > MAX_BYTES) {
    return { ok: false, error: t("media.errors.tooLarge") };
  }

  // Rebuild the FormData: the browser's copy may carry extra fields (the React
  // action id among them) that the API's multipart parser would reject.
  const upload = new FormData();
  upload.set("file", file, file.name);
  const folderId = formData.get("folderId");
  if (typeof folderId === "string" && folderId) upload.set("folderId", folderId);

  try {
    const media = await apiFetch<MediaDto>("/media", { method: "POST", formData: upload });
    revalidatePath("/media");
    return { ok: true, media };
  } catch (error) {
    return { ok: false, error: await toMessage(error, "media.errors.uploadFailed") };
  }
}

/**
 * Rename a file, write its alt text, or move it into another folder.
 *
 * A key is read only when the form actually sent it. An absent key means "leave
 * this alone" and an empty one means "clear it" — collapsing the two would wipe
 * someone's alt text every time they moved a file.
 *
 * None of this touches storage: the object key was minted at upload and is not
 * derived from the filename, so the URL of a renamed or moved file is unchanged
 * and no published page breaks.
 */
export async function updateMediaAction(formData: FormData): Promise<ActionResult> {
  const message = await denied("media:update");
  if (message) return { ok: false, error: message };

  const id = String(formData.get("id") ?? "");
  const patch: Record<string, unknown> = {};

  if (formData.has("filename")) patch.filename = String(formData.get("filename") ?? "");
  if (formData.has("alt")) {
    const alt = String(formData.get("alt") ?? "").trim();
    patch.alt = alt === "" ? null : alt;
  }
  if (formData.has("folderId")) {
    const folderId = String(formData.get("folderId") ?? "");
    patch.folderId = folderId === "" ? null : folderId;
  }

  const parsed = UpdateMediaSchema.safeParse(patch);
  if (!parsed.success) return { ok: false, error: await invalid(parsed.error.issues) };

  try {
    await apiFetch<MediaDto>(`/media/${id}`, { method: "PATCH", body: parsed.data });
    revalidatePath("/media");
    return { ok: true, data: undefined };
  } catch (error) {
    return { ok: false, error: await toMessage(error, "common.actionFailed") };
  }
}

export async function deleteMediaAction(formData: FormData): Promise<ActionResult> {
  const message = await denied("media:delete");
  if (message) return { ok: false, error: message };

  try {
    await apiFetch<void>(`/media/${String(formData.get("id") ?? "")}`, { method: "DELETE" });
    revalidatePath("/media");
    return { ok: true, data: undefined };
  } catch (error) {
    return { ok: false, error: await toMessage(error, "common.actionFailed") };
  }
}

/**
 * Move everything currently selected into one folder.
 *
 * The API answers with how many rows it actually moved, and that number is
 * handed back untouched: the selection is what the user clicked, `moved` is what
 * the database did, and a UI that reports the first as if it were the second is
 * lying on the one occasion it matters.
 */
export async function bulkMoveMediaAction(
  formData: FormData,
): Promise<ActionResult<{ moved: number }>> {
  const message = await denied("media:update");
  if (message) return { ok: false, error: message };

  const folderId = String(formData.get("folderId") ?? "");
  const parsed = BulkMoveMediaSchema.safeParse({
    ids: formData.getAll("ids").map(String),
    folderId: folderId === "" ? null : folderId,
  });
  if (!parsed.success) return { ok: false, error: await invalid(parsed.error.issues) };

  try {
    const result = await apiFetch<{ moved: number }>("/media/bulk-move", {
      method: "POST",
      body: parsed.data,
    });
    revalidatePath("/media");
    return { ok: true, data: result };
  } catch (error) {
    return { ok: false, error: await toMessage(error, "common.actionFailed") };
  }
}

export async function bulkDeleteMediaAction(
  formData: FormData,
): Promise<ActionResult<{ deleted: number }>> {
  const message = await denied("media:delete");
  if (message) return { ok: false, error: message };

  const parsed = BulkDeleteMediaSchema.safeParse({
    ids: formData.getAll("ids").map(String),
  });
  if (!parsed.success) return { ok: false, error: await invalid(parsed.error.issues) };

  try {
    const result = await apiFetch<{ deleted: number }>("/media/bulk-delete", {
      method: "POST",
      body: parsed.data,
    });
    revalidatePath("/media");
    return { ok: true, data: result };
  } catch (error) {
    return { ok: false, error: await toMessage(error, "common.actionFailed") };
  }
}

export async function createFolderAction(
  formData: FormData,
): Promise<ActionResult<MediaFolderDto>> {
  const message = await denied("media:update");
  if (message) return { ok: false, error: message };

  const parentId = String(formData.get("parentId") ?? "");
  const parsed = CreateMediaFolderSchema.safeParse({
    name: String(formData.get("name") ?? ""),
    parentId: parentId || null,
  });
  if (!parsed.success) return { ok: false, error: await invalid(parsed.error.issues) };

  try {
    const folder = await apiFetch<MediaFolderDto>("/media/folders", {
      method: "POST",
      body: parsed.data,
    });
    revalidatePath("/media");
    return { ok: true, data: folder };
  } catch (error) {
    return { ok: false, error: await toMessage(error, "common.actionFailed") };
  }
}

/** Rename and/or move. The dialog sends only the keys it changed. */
export async function updateFolderAction(
  formData: FormData,
): Promise<ActionResult<MediaFolderDto>> {
  const message = await denied("media:update");
  if (message) return { ok: false, error: message };

  const id = String(formData.get("id") ?? "");
  const patch: Record<string, unknown> = {};
  if (formData.has("name")) patch.name = String(formData.get("name") ?? "");
  if (formData.has("parentId")) {
    const parentId = String(formData.get("parentId") ?? "");
    patch.parentId = parentId === "" ? null : parentId;
  }

  const parsed = UpdateMediaFolderSchema.safeParse(patch);
  if (!parsed.success) return { ok: false, error: await invalid(parsed.error.issues) };

  try {
    const folder = await apiFetch<MediaFolderDto>(`/media/folders/${id}`, {
      method: "PATCH",
      body: parsed.data,
    });
    revalidatePath("/media");
    return { ok: true, data: folder };
  } catch (error) {
    return { ok: false, error: await toMessage(error, "common.actionFailed") };
  }
}

/**
 * Deletes the folder and its subfolders — never the files inside them.
 *
 * The API moves those up to where the deleted folder sat and reports how many,
 * so the UI can say where they went instead of leaving the user to assume the
 * worst about images their published pages still render.
 */
export async function deleteFolderAction(
  formData: FormData,
): Promise<ActionResult<{ movedFiles: number }>> {
  const message = await denied("media:delete");
  if (message) return { ok: false, error: message };

  const id = String(formData.get("id") ?? "");

  try {
    const result = await apiFetch<{ movedFiles: number }>(`/media/folders/${id}`, {
      method: "DELETE",
    });
    revalidatePath("/media");
    return { ok: true, data: result };
  } catch (error) {
    return { ok: false, error: await toMessage(error, "common.actionFailed") };
  }
}
