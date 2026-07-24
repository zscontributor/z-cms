"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { MediaDto, MediaFolderDto } from "@zcmsorg/schemas";
import { deleteMediaAction, updateMediaAction } from "@/app/actions/media";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/field";
import { Icon } from "@/components/shell/icon";
import { useT } from "@/lib/i18n-provider";
import { folderOptions } from "./folder-tree";

/**
 * The per-file actions: rename, alt text, move, delete.
 *
 * Rename/alt/move share one dialog because they are one thought — "fix this
 * file's details" — and because they are one PATCH. Delete is the only one of
 * the four that cannot be undone, so it is the only one behind a confirmation.
 */
export function FileActions({
  media,
  folders,
  canUpdate,
  canDelete,
}: {
  media: MediaDto;
  folders: MediaFolderDto[];
  canUpdate: boolean;
  canDelete: boolean;
}) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);

  if (!canUpdate && !canDelete) return null;

  return (
    <>
      {canUpdate ? (
        <Button
          size="sm"
          variant="ghost"
          className="px-1.5"
          title={t("media.file.edit")}
          aria-label={t("media.file.editAria", { name: media.filename })}
          onClick={() => setEditing(true)}
        >
          <Icon name="pencil" size={16} />
        </Button>
      ) : null}

      {canDelete ? (
        <Button
          size="sm"
          variant="ghost"
          className="px-1.5 hover:text-red-600 dark:hover:text-red-400"
          title={t("common.delete")}
          aria-label={t("media.file.deleteAria", { name: media.filename })}
          onClick={() => setConfirming(true)}
        >
          <Icon name="trash" size={16} />
        </Button>
      ) : null}

      {editing ? (
        <EditFileDialog media={media} folders={folders} onClose={() => setEditing(false)} />
      ) : null}
      {confirming ? (
        <DeleteFileDialog media={media} onClose={() => setConfirming(false)} />
      ) : null}
    </>
  );
}

function EditFileDialog({
  media,
  folders,
  onClose,
}: {
  media: MediaDto;
  folders: MediaFolderDto[];
  onClose: () => void;
}) {
  const t = useT();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [filename, setFilename] = useState(media.filename);
  const [alt, setAlt] = useState(media.alt ?? "");
  const [folderId, setFolderId] = useState(media.folderId ?? "");

  function save() {
    setError(null);
    const formData = new FormData();
    formData.set("id", media.id);
    formData.set("filename", filename.trim());
    formData.set("alt", alt);
    formData.set("folderId", folderId);

    startTransition(async () => {
      const result = await updateMediaAction(formData);
      if (!result.ok) {
        setError(result.error || t("common.actionFailed"));
        return;
      }
      router.refresh();
      onClose();
    });
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={t("media.file.editTitle")}
      // The reassurance belongs here, not in a tooltip: the reason people do not
      // rename files in a CMS is that they assume it will break the live page.
      description={t("media.file.editDescription")}
      footer={
        <>
          <Button onClick={onClose} disabled={pending}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="primary"
            disabled={pending || filename.trim() === ""}
            onClick={save}
          >
            {pending ? t("common.saving") : t("common.save")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label={t("media.file.name")} htmlFor={`name-${media.id}`}>
          <Input
            id={`name-${media.id}`}
            value={filename}
            autoFocus
            maxLength={255}
            onChange={(event) => setFilename(event.target.value)}
          />
        </Field>

        <Field
          label={t("media.file.alt")}
          hint={t("media.file.altHint")}
          htmlFor={`alt-${media.id}`}
        >
          <Input
            id={`alt-${media.id}`}
            value={alt}
            maxLength={500}
            onChange={(event) => setAlt(event.target.value)}
            placeholder={t("media.file.altPlaceholder")}
          />
        </Field>

        <Field label={t("media.file.folder")} htmlFor={`folder-${media.id}`}>
          <Select
            id={`folder-${media.id}`}
            value={folderId}
            onChange={(event) => setFolderId(event.target.value)}
          >
            <option value="">{t("media.folders.root")}</option>
            {folderOptions(folders).map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      {error ? (
        <p role="alert" className="mt-2 text-[11px] text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : null}
    </Dialog>
  );
}

function DeleteFileDialog({ media, onClose }: { media: MediaDto; onClose: () => void }) {
  const t = useT();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function remove() {
    setError(null);
    const formData = new FormData();
    formData.set("id", media.id);

    startTransition(async () => {
      const result = await deleteMediaAction(formData);
      if (!result.ok) {
        setError(result.error || t("common.actionFailed"));
        return;
      }
      router.refresh();
      onClose();
    });
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={t("media.file.deleteTitle")}
      description={t("media.file.deleteDescription", { name: media.filename })}
      footer={
        <>
          <Button onClick={onClose} disabled={pending}>
            {t("common.cancel")}
          </Button>
          <Button variant="destructive" disabled={pending} onClick={remove}>
            {pending ? t("common.deleting") : t("common.delete")}
          </Button>
        </>
      }
    >
      {/* The library does not track which pages embed a file, so it cannot promise
          this is safe — and it says so rather than implying the check was made. */}
      <p className="text-xs z-muted">{t("media.file.deleteWarning")}</p>
      {error ? (
        <p role="alert" className="mt-2 text-[11px] text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : null}
    </Dialog>
  );
}
