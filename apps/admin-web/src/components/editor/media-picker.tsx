"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { MediaDto, Paginated } from "@zcmsorg/schemas";
import { uploadMediaAction } from "@/app/actions/media";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/field";
import { Icon } from "@/components/shell/icon";
import { cn } from "@/lib/cn";
import { adminAssetPath } from "@/lib/assets";
import { useT } from "@/lib/i18n-provider";

/**
 * `mode` decides what the field stores: content-type fields of type "media" are
 * validated as a uuid by buildContentDataSchema, while block props hold a plain
 * URL because a theme renders them directly.
 */
export function MediaPickerField({
  value,
  onChange,
  mode,
  placeholder,
  id,
}: {
  value: string;
  onChange: (value: string) => void;
  mode: "id" | "url";
  placeholder?: string;
  id?: string;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);

  return (
    <>
      <div className="flex gap-2">
        <Input
          id={id}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder ?? (mode === "id" ? t("media.picker.idPlaceholder") : "https://…")}
        />
        <Button onClick={() => setOpen(true)} className="shrink-0">
          {t("common.select")}
        </Button>
        {value ? (
          <Button variant="ghost" onClick={() => onChange("")} className="shrink-0">
            {t("common.clear")}
          </Button>
        ) : null}
      </div>

      {mode === "url" && value ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={value}
          alt=""
          className="mt-2 h-20 w-auto rounded-md border border-[var(--border)] object-cover"
        />
      ) : null}

      <MediaPickerDialog
        open={open}
        onClose={() => setOpen(false)}
        onSelect={([media]) => {
          if (media) onChange(mode === "id" ? media.id : media.url);
          setOpen(false);
        }}
      />
    </>
  );
}

/**
 * Picks files out of the library — and puts new ones into it.
 *
 * Uploading from here writes through the same server action as the media page,
 * so a file picked up mid-sentence in the editor is a first-class library asset:
 * it can be reused, it is listed on /media, and it is not some private blob
 * attached to one post.
 *
 * `multiple` turns the grid into a checklist and defers to the footer button;
 * single mode keeps the old one-click-and-done behaviour, which is what the
 * media *field* wants.
 */
export function MediaPickerDialog({
  open,
  onClose,
  onSelect,
  multiple = false,
  imagesOnly = false,
}: {
  open: boolean;
  onClose: () => void;
  onSelect: (media: MediaDto[]) => void;
  multiple?: boolean;
  imagesOnly?: boolean;
}) {
  const t = useT();
  const inputRef = useRef<HTMLInputElement>(null);
  const [items, setItems] = useState<MediaDto[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [selected, setSelected] = useState<MediaDto[]>([]);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  const load = useCallback(
    async (target: number) => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(adminAssetPath(`/api/media?page=${target}`), {
          cache: "no-store",
        });
        if (!res.ok) throw new Error(t("media.picker.loadFailed"));
        const data = (await res.json()) as Paginated<MediaDto>;
        setItems(data.items);
        setPage(data.page);
        setTotalPages(Math.max(1, data.totalPages));
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : t("media.picker.loadFailed"));
      } finally {
        setLoading(false);
      }
    },
    [t],
  );

  useEffect(() => {
    if (!open) return;
    setSelected([]);
    setError(null);
    void load(1);
  }, [open, load]);

  async function upload(files: FileList | null) {
    if (!files || files.length === 0 || uploading) return;
    const list = Array.from(files).filter(
      (file) => !imagesOnly || file.type.startsWith("image/"),
    );
    if (list.length === 0) return;

    setUploading(true);
    setError(null);
    const uploaded: MediaDto[] = [];

    for (const [index, file] of list.entries()) {
      setProgress(
        t("media.uploader.progress", {
          index: index + 1,
          total: list.length,
          name: file.name,
        }),
      );
      const formData = new FormData();
      formData.set("file", file);
      const result = await uploadMediaAction(formData);
      if (!result.ok) {
        setError(`${file.name}: ${result.error}`);
        break;
      }
      uploaded.push(result.media);
    }

    setProgress(null);
    setUploading(false);
    if (inputRef.current) inputRef.current.value = "";
    if (uploaded.length === 0) return;

    // Freshly uploaded files come back pre-selected: the reason someone uploaded
    // mid-edit is that they want *these* files, not a trip back through the grid.
    setSelected((current) => (multiple ? [...current, ...uploaded] : uploaded));

    // The grid is server-paginated, so the new files only exist in the list once
    // page 1 is re-fetched. Confirm straight away in single mode instead.
    if (!multiple) {
      onSelect(uploaded.slice(0, 1));
      return;
    }
    await load(1);
  }

  const visible = imagesOnly
    ? items.filter((media) => media.mimeType.startsWith("image/"))
    : items;
  const isSelected = (media: MediaDto) => selected.some((item) => item.id === media.id);

  function toggle(media: MediaDto) {
    if (!multiple) {
      onSelect([media]);
      return;
    }
    setSelected((current) =>
      current.some((item) => item.id === media.id)
        ? current.filter((item) => item.id !== media.id)
        : [...current, media],
    );
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t("media.picker.title")}
      className="z-[120] w-[min(48rem,calc(100vw-2rem))]"
      footer={
        <>
          <Button
            size="sm"
            disabled={loading || page <= 1}
            onClick={() => void load(page - 1)}
          >
            {t("common.pagination.previous")}
          </Button>
          <span className="mr-auto self-center text-[11px] z-muted">
            {t("common.pagination.page", { page, totalPages })}
          </span>
          <Button
            size="sm"
            disabled={loading || page >= totalPages}
            onClick={() => void load(page + 1)}
          >
            {t("common.pagination.next")}
          </Button>
          <Button size="sm" onClick={onClose}>
            {t("common.close")}
          </Button>
          {multiple ? (
            <Button
              size="sm"
              variant="primary"
              disabled={selected.length === 0}
              onClick={() => onSelect(selected)}
            >
              {t("media.picker.insert", { count: selected.length })}
            </Button>
          ) : null}
        </>
      }
    >
      <div
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          void upload(event.dataTransfer.files);
        }}
        className={cn(
          "mb-3 flex items-center justify-between gap-3 rounded-md border border-dashed px-3 py-2.5 transition-colors",
          dragging
            ? "border-brand-500 bg-brand-50 dark:bg-brand-500/10"
            : "border-[var(--border-strong)]",
        )}
      >
        <span className="flex min-w-0 items-center gap-2">
          <Icon name="upload" size={18} className="shrink-0 z-muted" />
          <span className="truncate text-[11px] z-muted">
            {progress ?? t("media.uploader.hint")}
          </span>
        </span>
        <input
          ref={inputRef}
          type="file"
          multiple
          hidden
          accept={imagesOnly ? "image/*" : undefined}
          onChange={(event) => void upload(event.target.files)}
        />
        <Button
          size="sm"
          disabled={uploading}
          onClick={() => inputRef.current?.click()}
          className="shrink-0"
        >
          {uploading ? t("media.uploader.uploading") : t("media.uploader.choose")}
        </Button>
      </div>

      {error ? <p className="mb-2 text-xs text-red-600 dark:text-red-400">{error}</p> : null}
      {loading ? (
        <p className="py-8 text-center text-xs z-muted">{t("common.loading")}</p>
      ) : null}

      {!loading && visible.length === 0 && !error ? (
        <p className="py-8 text-center text-xs z-muted">{t("media.picker.empty")}</p>
      ) : null}

      <div className="z-scroll-thin grid max-h-[50vh] grid-cols-3 gap-2 overflow-y-auto sm:grid-cols-4">
        {visible.map((media) => {
          const active = isSelected(media);
          return (
            <button
              key={media.id}
              type="button"
              onClick={() => toggle(media)}
              aria-pressed={multiple ? active : undefined}
              className={cn(
                "group relative overflow-hidden rounded-md border text-left",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40",
                active
                  ? "border-brand-500 ring-2 ring-brand-500/40"
                  : "border-[var(--border)] hover:border-brand-500",
              )}
            >
              <MediaThumb media={media} />
              {active ? (
                <span className="absolute right-1 top-1 flex size-5 items-center justify-center rounded-full bg-brand-500 text-white">
                  <Icon name="check" size={13} />
                </span>
              ) : null}
              <span className="block truncate px-1.5 py-1 text-[10px] z-muted">
                {media.filename}
              </span>
            </button>
          );
        })}
      </div>
    </Dialog>
  );
}

export function MediaThumb({ media }: { media: MediaDto }) {
  if (media.mimeType.startsWith("image/")) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={media.url}
        alt={media.alt ?? media.filename}
        loading="lazy"
        className="aspect-4/3 w-full bg-[var(--surface-sunken)] object-cover"
      />
    );
  }
  return (
    <span className="flex aspect-4/3 w-full items-center justify-center bg-[var(--surface-sunken)] text-[10px] uppercase z-muted">
      {media.mimeType.split("/")[1] ?? "file"}
    </span>
  );
}
