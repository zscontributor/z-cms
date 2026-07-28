"use client";

import { useCallback, useEffect } from "react";
import type { MediaDto, MediaFolderDto } from "@zcmsorg/schemas";
import { Button, buttonClasses } from "@/components/ui/button";
import { Drawer } from "@/components/ui/drawer";
import { Icon } from "@/components/shell/icon";
import { formatBytes, formatDateTime } from "@/lib/format";
import { useT } from "@/lib/i18n-provider";
import { CopyUrlButton } from "./copy-url-button";
import { FileActions } from "./file-actions";

/**
 * A preview of one file, slid in from the right.
 *
 * The grid thumbnail is a thumbnail — cropped to 4:3 and a few centimetres wide.
 * This is the place to actually *look* at the file: the image at its own aspect
 * ratio, the video or audio with transport controls, and every fact the library
 * knows about it. Prev/Next (and the arrow keys) walk the current page without
 * closing, so reviewing a folder is one gesture; the edit and delete actions are
 * the same {@link FileActions} as the grid card, so nothing behaves differently
 * for being opened here.
 */
export function PreviewDrawer({
  media,
  items,
  folders,
  locale,
  canUpdate,
  canDelete,
  onNavigate,
  onClose,
}: {
  media: MediaDto | null;
  items: MediaDto[];
  folders: MediaFolderDto[];
  locale: string;
  canUpdate: boolean;
  canDelete: boolean;
  onNavigate: (media: MediaDto) => void;
  onClose: () => void;
}) {
  const t = useT();
  const folderName = media?.folderId
    ? folders.find((folder) => folder.id === media.folderId)?.name ?? null
    : null;

  const index = media ? items.findIndex((item) => item.id === media.id) : -1;
  const prev = index > 0 ? items[index - 1] : null;
  const next = index >= 0 && index < items.length - 1 ? items[index + 1] : null;

  // Arrow keys walk the page. Guard against a form field on top (the edit dialog)
  // stealing keystrokes: when focus is in an input, the arrows belong to it.
  const onKeyDown = useCallback(
    (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable) {
        return;
      }
      if (event.key === "ArrowLeft" && prev) {
        event.preventDefault();
        onNavigate(prev);
      } else if (event.key === "ArrowRight" && next) {
        event.preventDefault();
        onNavigate(next);
      }
    },
    [prev, next, onNavigate],
  );

  useEffect(() => {
    if (!media) return;
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [media, onKeyDown]);

  return (
    <Drawer
      open={media !== null}
      onClose={onClose}
      title={media?.filename ?? t("media.preview.title")}
      description={media?.mimeType}
      width="lg"
      footer={
        media ? (
          <>
            <span className="mr-auto min-w-0 flex-1">
              <CopyUrlButton url={media.url} />
            </span>
            <FileActions
              media={media}
              folders={folders}
              canUpdate={canUpdate}
              canDelete={canDelete}
            />
            <a
              href={media.url}
              target="_blank"
              rel="noreferrer"
              className={buttonClasses("primary", "md")}
            >
              <Icon name="external" size={16} />
              {t("media.preview.openOriginal")}
            </a>
          </>
        ) : undefined
      }
    >
      {media ? (
        <div className="flex flex-col gap-4">
          {items.length > 1 ? (
            <div className="flex items-center justify-between gap-2">
              <Button
                size="sm"
                variant="ghost"
                disabled={!prev}
                onClick={() => prev && onNavigate(prev)}
              >
                <Icon name="chevron-left" size={16} />
                {t("media.preview.previous")}
              </Button>
              <span className="text-[11px] z-muted">
                {t("media.preview.position", { index: index + 1, total: items.length })}
              </span>
              <Button
                size="sm"
                variant="ghost"
                disabled={!next}
                onClick={() => next && onNavigate(next)}
              >
                {t("media.preview.next")}
                <Icon name="chevron-right" size={16} />
              </Button>
            </div>
          ) : null}

          <PreviewMedia media={media} noPreviewLabel={t("media.preview.noPreview")} />

          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-xs">
            <Row label={t("media.preview.type")} value={media.mimeType} />
            <Row label={t("media.preview.size")} value={formatBytes(media.size)} />
            {media.width && media.height ? (
              <Row
                label={t("media.preview.dimensions")}
                value={`${media.width} × ${media.height} px`}
              />
            ) : null}
            <Row
              label={t("media.preview.folder")}
              value={folderName ?? t("media.folders.root")}
            />
            <Row
              label={t("media.preview.uploaded")}
              value={formatDateTime(media.createdAt, locale)}
            />
            {media.alt ? <Row label={t("media.preview.alt")} value={media.alt} /> : null}
          </dl>
        </div>
      ) : null}
    </Drawer>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="z-muted">{label}</dt>
      <dd className="min-w-0 break-words font-medium">{value}</dd>
    </>
  );
}

/** The visual itself — image, video, audio, or a placeholder for everything else. */
function PreviewMedia({
  media,
  noPreviewLabel,
}: {
  media: MediaDto;
  noPreviewLabel: string;
}) {
  const frame =
    "flex items-center justify-center overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface-sunken)]";

  if (media.mimeType.startsWith("image/")) {
    return (
      <div className={frame}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={media.url}
          alt={media.alt ?? media.filename}
          className="max-h-[60vh] w-auto max-w-full object-contain"
        />
      </div>
    );
  }

  if (media.mimeType.startsWith("video/")) {
    return (
      <div className={frame}>
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <video src={media.url} controls className="max-h-[60vh] w-full">
          {noPreviewLabel}
        </video>
      </div>
    );
  }

  if (media.mimeType.startsWith("audio/")) {
    return (
      <div className={`${frame} p-6`}>
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <audio src={media.url} controls className="w-full" />
      </div>
    );
  }

  return (
    <div className={`${frame} flex-col gap-2 px-6 py-12 text-center`}>
      <Icon name="doc" size={40} className="z-muted" />
      <span className="text-xs z-muted">{noPreviewLabel}</span>
    </div>
  );
}
