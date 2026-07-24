"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import type { BlockDocument, ContentStatus, ContentTypeDto } from "@zcmsorg/schemas";
import { ContentStatusSchema } from "@zcmsorg/schemas";
import {
  deleteContentAction,
  publishContentAction,
  saveContentAction,
  type ContentFormPayload,
} from "@/app/actions/content";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Checkbox, Field, Input, Select, Textarea } from "@/components/ui/field";
import { Icon } from "@/components/shell/icon";
import type { ContentTypeOption } from "@/lib/block-registry";
import { STATUS_TONES, formatDateTime, statusKey } from "@/lib/format";
import { useLocale, useT } from "@/lib/i18n-provider";
import { isValidSlug, slugify } from "@/lib/slugify";
import { BlockEditor } from "./block-editor";
import { DynamicFields, normalizeFieldValues } from "./dynamic-fields";

const STATUSES = ContentStatusSchema.options;

function isRedirect(error: unknown): boolean {
  const digest = (error as { digest?: unknown } | null)?.digest;
  return typeof digest === "string" && digest.startsWith("NEXT_REDIRECT");
}

export interface EditorInitial {
  id?: string;
  title: string;
  slug: string;
  locale: string;
  /**
   * Set when this document is a *translation being created* — the group of the
   * page it translates. The locale is then fixed: the author chose which language
   * they were translating into before they got here, and letting them change it
   * mid-edit would either collide with an existing sibling or silently move the
   * page to a language nobody asked for.
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
  path?: string;
  updatedAt?: string;
}

export interface EditorPermissions {
  canSave: boolean;
  canPublish: boolean;
  canDelete: boolean;
}

export function ContentEditor({
  type,
  initial,
  permissions,
  contentTypes,
}: {
  type: ContentTypeDto;
  initial: EditorInitial;
  permissions: EditorPermissions;
  /**
   * Every content type on the site — not just the one being edited. A
   * `core/content-list` block on this page lists *some other* type ("the latest
   * posts", on a landing page), so the block editor needs the whole set to offer
   * as a choice. The screen has already paid for this list: resolving `type` from
   * the URL key goes through the same cached `listContentTypes()` call.
   */
  contentTypes: ContentTypeOption[];
}) {
  const t = useT();
  const uiLocale = useLocale();
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const [id, setId] = useState(initial.id);
  const [title, setTitle] = useState(initial.title);
  const [slug, setSlug] = useState(initial.slug);
  const locale = initial.locale;
  const [excerpt, setExcerpt] = useState(initial.excerpt);
  const [status, setStatus] = useState<ContentStatus>(initial.status);
  const [data, setData] = useState<Record<string, unknown>>(initial.data);
  const [blocks, setBlocks] = useState<BlockDocument>(initial.blocks);
  const [seo, setSeo] = useState(initial.seo);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  // The slug follows the title only until the user takes it over — after that,
  // silently rewriting a published URL because someone fixed a typo in the
  // heading would break every inbound link.
  const [slugLocked, setSlugLocked] = useState(Boolean(initial.id) && initial.slug !== "");

  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(initial.updatedAt ?? null);
  const readOnly = !permissions.canSave;

  const path = useMemo(() => {
    const prefix = type.routePrefix ? `/${type.routePrefix}` : "";
    return `${prefix}/${slug}`.replace(/\/+$/, "") || "/";
  }, [type.routePrefix, slug]);

  const slugError = slug !== "" && !isValidSlug(slug);

  function onTitle(value: string) {
    setTitle(value);
    if (!slugLocked) setSlug(slugify(value));
  }

  function payload(nextStatus: ContentStatus): ContentFormPayload {
    return {
      id,
      contentTypeId: type.id,
      typeKey: type.key,
      title: title.trim(),
      slug,
      locale,
      ...(initial.translationGroupId
        ? { translationGroupId: initial.translationGroupId }
        : {}),
      excerpt: excerpt.trim(),
      status: nextStatus,
      data: normalizeFieldValues(type.fields, data),
      blocks,
      seo,
    };
  }

  function validate(): string | null {
    if (!title.trim()) return t("content.editor.titleRequired");
    if (slugError) return t("content.editor.slugInvalid");
    for (const field of type.fields) {
      if (!field.required) continue;
      const value = data[field.key];
      if (value === undefined || value === null || value === "") {
        return t("content.editor.fieldRequired", { label: field.label });
      }
    }
    return null;
  }

  function save(nextStatus: ContentStatus, thenPublish?: boolean) {
    const invalid = validate();
    if (invalid) {
      setError(invalid);
      return;
    }
    setError(null);

    startTransition(async () => {
      const result = await saveContentAction(payload(nextStatus));
      if (!result.ok) {
        setError(result.error);
        return;
      }

      const wasNew = !id;
      setId(result.id);
      setStatus(result.status);
      setSavedAt(result.updatedAt);

      if (thenPublish) {
        const formData = new FormData();
        formData.set("id", result.id);
        formData.set("typeKey", type.key);
        formData.set("publish", nextStatus === "PUBLISHED" ? "true" : "false");
        try {
          await publishContentAction(formData);
          setStatus(nextStatus === "PUBLISHED" ? "PUBLISHED" : "DRAFT");
        } catch (cause) {
          setError(
            cause instanceof Error ? cause.message : t("content.editor.publishFailed"),
          );
          return;
        }
      }

      if (wasNew) {
        router.replace(`/content/${type.key}/${result.id}`);
      } else {
        router.refresh();
      }
    });
  }

  function remove() {
    startTransition(async () => {
      if (!id) return;
      const formData = new FormData();
      formData.set("id", id);
      formData.set("typeKey", type.key);
      formData.set("returnToList", "true");
      try {
        await deleteContentAction(formData);
      } catch (cause) {
        // The action ends in redirect(); Next signals that by throwing an error
        // carrying a NEXT_REDIRECT digest, which is control flow, not a failure.
        if (isRedirect(cause)) return;
        setError(cause instanceof Error ? cause.message : t("content.editor.deleteFailed"));
        setConfirmingDelete(false);
      }
    });
  }

  const isPublished = status === "PUBLISHED";

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
      {/* ---------------------------------------------------------------- main */}
      <div className="flex flex-col gap-4">
        <section className="z-card p-4">
          <div className="flex flex-col gap-4">
            <Field label={t("content.editor.title")} htmlFor="title" required>
              <Input
                id="title"
                value={title}
                disabled={readOnly}
                onChange={(event) => onTitle(event.target.value)}
                placeholder={t("content.editor.titlePlaceholder", {
                  type: type.name.toLowerCase(),
                })}
                className="text-base font-medium"
              />
            </Field>

            <Field
              label={t("content.editor.slug")}
              htmlFor="slug"
              hint={t("content.editor.slugHint", { path })}
            >
              <div className="flex gap-2">
                <Input
                  id="slug"
                  value={slug}
                  disabled={readOnly}
                  onChange={(event) => {
                    setSlugLocked(true);
                    setSlug(event.target.value);
                  }}
                  placeholder={t("content.editor.slugPlaceholder")}
                  className="font-mono text-xs"
                />
                <Button
                  disabled={readOnly || !title.trim()}
                  onClick={() => {
                    setSlug(slugify(title));
                    setSlugLocked(false);
                  }}
                  className="shrink-0"
                  title={t("content.editor.regenerateHint")}
                >
                  {t("content.editor.regenerate")}
                </Button>
              </div>
              {slugError ? (
                <p className="mt-1 text-[11px] text-red-600 dark:text-red-400">
                  {t("content.editor.slugInvalid")}
                </p>
              ) : null}
            </Field>

            <Field
              label={t("content.editor.excerpt")}
              htmlFor="excerpt"
              hint={t("content.editor.excerptHint")}
            >
              <Textarea
                id="excerpt"
                rows={2}
                maxLength={500}
                value={excerpt}
                disabled={readOnly}
                onChange={(event) => setExcerpt(event.target.value)}
              />
            </Field>
          </div>
        </section>

        {type.fields.length > 0 ? (
          <section className="z-card p-4">
            <h2 className="mb-3 text-sm font-semibold">{t("content.editor.fields")}</h2>
            <DynamicFields
              fields={type.fields}
              values={data}
              onChange={(key, value) =>
                setData((current) => ({ ...current, [key]: value }))
              }
            />
          </section>
        ) : null}

        {type.hasBlocks ? (
          <section className="z-card p-4">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold">{t("content.editor.blocks")}</h2>
              <span className="text-[11px] z-muted">
                {t("content.editor.blockCount", { count: blocks.length })}
              </span>
            </div>
            <BlockEditor
              blocks={blocks}
              onChange={setBlocks}
              disabled={readOnly}
              contentTypes={contentTypes}
            />
          </section>
        ) : null}
      </div>

      {/* ------------------------------------------------------------- sidebar */}
      <div className="flex flex-col gap-4 lg:sticky lg:top-[4.5rem] lg:self-start">
        <section className="z-card p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold">{t("content.editor.publishSection")}</h2>
            <Badge tone={STATUS_TONES[status]}>{t(statusKey(status))}</Badge>
          </div>

          <div className="flex flex-col gap-3">
            <Field label={t("content.editor.status")} htmlFor="status">
              <Select
                id="status"
                value={status}
                disabled={readOnly}
                onChange={(event) => setStatus(event.target.value as ContentStatus)}
              >
                {STATUSES.map((value) => (
                  <option
                    key={value}
                    value={value}
                    disabled={value === "PUBLISHED" && !permissions.canPublish}
                  >
                    {t(statusKey(value))}
                  </option>
                ))}
              </Select>
            </Field>

            {error ? (
              <p
                role="alert"
                className="rounded-md border border-red-200 bg-red-50 px-2.5 py-2 text-[11px] text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300"
              >
                {error}
              </p>
            ) : null}

            {permissions.canSave ? (
              <div className="flex flex-col gap-2">
                <Button
                  variant="primary"
                  disabled={pending}
                  onClick={() => save(status)}
                  className="w-full"
                >
                  {pending
                    ? t("common.saving")
                    : id
                      ? t("content.editor.save")
                      : t("content.editor.create")}
                </Button>

                {permissions.canPublish ? (
                  isPublished ? (
                    <Button
                      disabled={pending}
                      onClick={() => save("DRAFT", true)}
                      className="w-full"
                    >
                      <Icon name="eyeOff" size={18} />
                      {t("content.editor.unpublish")}
                    </Button>
                  ) : (
                    <Button
                      disabled={pending}
                      onClick={() => save("PUBLISHED", true)}
                      className="w-full"
                    >
                      <Icon name="eye" size={18} />
                      {t("content.editor.saveAndPublish")}
                    </Button>
                  )
                ) : null}
              </div>
            ) : (
              <p className="text-[11px] z-muted">{t("content.editor.readOnly")}</p>
            )}

            <dl className="space-y-1.5 border-t border-[var(--border)] pt-3 text-[11px]">
              <div className="flex justify-between gap-2">
                <dt className="z-muted">{t("content.editor.locale")}</dt>
                <dd>{locale}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="z-muted">{t("content.editor.updated")}</dt>
                <dd>{formatDateTime(savedAt, uiLocale)}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="z-muted">{t("content.editor.path")}</dt>
                <dd className="truncate font-mono">{path}</dd>
              </div>
            </dl>

            {id && permissions.canDelete ? (
              <Button
                variant="danger"
                size="sm"
                disabled={pending}
                onClick={() => setConfirmingDelete(true)}
                className="w-full"
              >
                <Icon name="trash" size={18} />
                {t("content.editor.delete")}
              </Button>
            ) : null}
          </div>
        </section>

        <section className="z-card p-4">
          <h2 className="mb-3 text-sm font-semibold">{t("content.seo.heading")}</h2>
          <div className="flex flex-col gap-3">
            <Field
              label={t("content.seo.title")}
              htmlFor="seo-title"
              hint={t("content.seo.titleHint", { count: (seo.title ?? "").length })}
            >
              <Input
                id="seo-title"
                maxLength={70}
                disabled={readOnly}
                value={seo.title ?? ""}
                placeholder={title || t("content.seo.titlePlaceholder")}
                onChange={(event) =>
                  setSeo((current) => ({ ...current, title: event.target.value }))
                }
              />
            </Field>

            <Field
              label={t("content.seo.description")}
              htmlFor="seo-description"
              hint={t("content.seo.descriptionHint", {
                count: (seo.description ?? "").length,
              })}
            >
              <Textarea
                id="seo-description"
                rows={3}
                maxLength={200}
                disabled={readOnly}
                value={seo.description ?? ""}
                onChange={(event) =>
                  setSeo((current) => ({ ...current, description: event.target.value }))
                }
              />
            </Field>

            <Field label={t("content.seo.ogImage")} htmlFor="seo-og">
              <Input
                id="seo-og"
                disabled={readOnly}
                value={seo.ogImage ?? ""}
                placeholder="https://…"
                onChange={(event) =>
                  setSeo((current) => ({ ...current, ogImage: event.target.value }))
                }
              />
            </Field>

            <Field label={t("content.seo.canonical")} htmlFor="seo-canonical">
              <Input
                id="seo-canonical"
                disabled={readOnly}
                value={seo.canonical ?? ""}
                placeholder="https://…"
                onChange={(event) =>
                  setSeo((current) => ({ ...current, canonical: event.target.value }))
                }
              />
            </Field>

            <label className="flex items-center gap-2 text-xs">
              <Checkbox
                disabled={readOnly}
                checked={seo.noindex === true}
                onChange={(event) =>
                  setSeo((current) => ({ ...current, noindex: event.target.checked }))
                }
              />
              {t("content.seo.noindex")}
            </label>
          </div>
        </section>
      </div>

      <Dialog
        open={confirmingDelete}
        onClose={() => setConfirmingDelete(false)}
        title={t("content.delete.title")}
        description={t("content.delete.descriptionPermanent", { title })}
        footer={
          <>
            <Button onClick={() => setConfirmingDelete(false)} disabled={pending}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="primary"
              disabled={pending}
              className="bg-red-600 hover:bg-red-700 active:bg-red-800"
              onClick={remove}
            >
              {pending ? t("common.deleting") : t("common.delete")}
            </Button>
          </>
        }
      />
    </div>
  );
}
