"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  CreateContentSchema,
  UpdateContentSchema,
  type BlockDocument,
  type ContentDto,
  type ContentStatus,
  type Permission,
} from "@zcmsorg/schemas";
import { ApiError, apiFetch, can, getSession } from "@/lib/api";
import { getT } from "@/lib/locale";

export interface ContentFormPayload {
  /** Absent for a new document. */
  id?: string;
  contentTypeId: string;
  typeKey: string;
  title: string;
  slug: string;
  locale: string;
  /**
   * Set only when this document is being created as the translation of another.
   * Carrying it on an update would be a way to silently re-parent a page into
   * someone else's translation group; the API refuses it there.
   */
  translationGroupId?: string;
  excerpt: string;
  status: ContentStatus;
  data: Record<string, unknown>;
  blocks: BlockDocument;
  seo: {
    title?: string;
    description?: string;
    ogImage?: string;
    canonical?: string;
    noindex?: boolean;
  };
}

export type SaveResult =
  | { ok: true; id: string; status: ContentStatus; updatedAt: string }
  | { ok: false; error: string };

async function assertPermission(permission: Permission): Promise<string | null> {
  const t = await getT();
  const user = await getSession();
  if (!user) return t("auth.session.expired");
  if (!can(user, permission)) return t("auth.forbidden");
  return null;
}

async function toMessage(error: unknown): Promise<string> {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return (await getT())("common.unknownError");
}

/** Empty strings are how HTML forms say "unset"; the API wants them gone. */
function pruneSeo(seo: ContentFormPayload["seo"]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(seo)) {
    if (value === undefined || value === "" || value === false) continue;
    out[key] = value;
  }
  return out;
}

export async function saveContentAction(payload: ContentFormPayload): Promise<SaveResult> {
  const denied = await assertPermission(payload.id ? "content:update" : "content:create");
  if (denied) return { ok: false, error: denied };

  const base = {
    title: payload.title,
    slug: payload.slug,
    // No fallback locale here on purpose. An empty value means "the site's
    // default", and the API is the only side that knows what that is — a constant
    // written here would file the entry under a language the site may not publish.
    ...(payload.locale ? { locale: payload.locale } : {}),
    excerpt: payload.excerpt || undefined,
    data: payload.data ?? {},
    blocks: payload.blocks ?? [],
    seo: pruneSeo(payload.seo),
    status: payload.status,
  };

  try {
    let content: ContentDto;

    if (payload.id) {
      const parsed = UpdateContentSchema.safeParse(base);
      if (!parsed.success) {
        return { ok: false, error: await firstIssue(parsed.error.issues) };
      }
      content = await apiFetch<ContentDto>(`/contents/${payload.id}`, {
        method: "PATCH",
        body: parsed.data,
      });
    } else {
      const parsed = CreateContentSchema.safeParse({
        ...base,
        contentTypeId: payload.contentTypeId,
        // Present only when this is a translation of an existing page. Absent, the
        // database mints a fresh group and the page stands alone — which is what a
        // genuinely new page is.
        ...(payload.translationGroupId
          ? { translationGroupId: payload.translationGroupId }
          : {}),
      });
      if (!parsed.success) {
        return { ok: false, error: await firstIssue(parsed.error.issues) };
      }
      content = await apiFetch<ContentDto>("/contents", {
        method: "POST",
        body: parsed.data,
      });
    }

    revalidatePath(`/content/${payload.typeKey}`);
    revalidatePath(`/content/${payload.typeKey}/${content.id}`);
    revalidatePath("/");

    return {
      ok: true,
      id: content.id,
      status: content.status,
      updatedAt: content.updatedAt,
    };
  } catch (error) {
    return { ok: false, error: await toMessage(error) };
  }
}

async function firstIssue(issues: { path: PropertyKey[]; message: string }[]): Promise<string> {
  const issue = issues[0];
  if (!issue) return (await getT())("common.invalidData");
  const path = issue.path.map(String).join(".");
  return path ? `${path}: ${issue.message}` : issue.message;
}

/** Used by the list rows (plain <form action>), so it takes FormData. */
export async function publishContentAction(formData: FormData): Promise<void> {
  const id = String(formData.get("id") ?? "");
  const typeKey = String(formData.get("typeKey") ?? "");
  const publish = String(formData.get("publish") ?? "true") === "true";

  const denied = await assertPermission("content:publish");
  if (denied) throw new Error(denied);

  await apiFetch<ContentDto>(`/contents/${id}/${publish ? "publish" : "unpublish"}`, {
    method: "POST",
  });

  revalidatePath(`/content/${typeKey}`);
  revalidatePath(`/content/${typeKey}/${id}`);
  revalidatePath("/");
}

export async function deleteContentAction(formData: FormData): Promise<void> {
  const id = String(formData.get("id") ?? "");
  const typeKey = String(formData.get("typeKey") ?? "");
  const returnToList = String(formData.get("returnToList") ?? "false") === "true";

  const denied = await assertPermission("content:delete");
  if (denied) throw new Error(denied);

  await apiFetch<void>(`/contents/${id}`, { method: "DELETE" });

  revalidatePath(`/content/${typeKey}`);
  revalidatePath("/");

  if (returnToList) redirect(`/content/${typeKey}`);
}
