"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { MediaFolderDto } from "@zcmsorg/schemas";
import {
  createFolderAction,
  deleteFolderAction,
  updateFolderAction,
} from "@/app/actions/media";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/field";
import { Icon } from "@/components/shell/icon";
import { useT } from "@/lib/i18n-provider";
import { childrenOf, folderOptions } from "./folder-tree";

export function FolderGrid({
  folders,
  currentId,
  canManage,
  canDelete,
}: {
  folders: MediaFolderDto[];
  /** The folder being browsed; null at the root. */
  currentId: string | null;
  canManage: boolean;
  canDelete: boolean;
}) {
  const t = useT();
  const children = childrenOf(folders, currentId);

  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<MediaFolderDto | null>(null);
  const [deleting, setDeleting] = useState<MediaFolderDto | null>(null);

  if (children.length === 0 && !canManage) return null;

  return (
    <section className="mb-4">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-xs font-semibold z-muted">{t("media.folders.title")}</h2>
        {canManage ? (
          <Button size="sm" onClick={() => setCreating(true)}>
            <Icon name="folderPlus" size={16} />
            {t("media.folders.new")}
          </Button>
        ) : null}
      </div>

      {children.length === 0 ? (
        <p className="rounded-md border border-dashed border-[var(--border-strong)] px-3 py-4 text-center text-[11px] z-muted">
          {t("media.folders.empty")}
        </p>
      ) : (
        <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
          {children.map((folder) => (
            <li key={folder.id} className="z-card flex items-center gap-2 p-2">
              <Link
                href={`/media?folder=${folder.id}`}
                className="flex min-w-0 flex-1 items-center gap-2 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40"
              >
                <Icon name="folder" size={20} className="shrink-0 text-brand-500" />
                <span className="min-w-0">
                  <span className="block truncate text-[11px] font-medium" title={folder.name}>
                    {folder.name}
                  </span>
                  <span className="block text-[10px] z-muted">
                    {t("media.folders.count", {
                      files: folder.fileCount,
                      folders: folder.subfolderCount,
                    })}
                  </span>
                </span>
              </Link>

              {canManage ? (
                <Button
                  size="sm"
                  variant="ghost"
                  className="shrink-0 px-1.5"
                  title={t("media.folders.edit")}
                  aria-label={t("media.folders.editAria", { name: folder.name })}
                  onClick={() => setEditing(folder)}
                >
                  <Icon name="pencil" size={16} />
                </Button>
              ) : null}

              {canDelete ? (
                <Button
                  size="sm"
                  variant="ghost"
                  className="shrink-0 px-1.5 hover:text-red-600 dark:hover:text-red-400"
                  title={t("common.delete")}
                  aria-label={t("media.folders.deleteAria", { name: folder.name })}
                  onClick={() => setDeleting(folder)}
                >
                  <Icon name="trash" size={16} />
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <CreateFolderDialog
        open={creating}
        parentId={currentId}
        onClose={() => setCreating(false)}
      />
      <EditFolderDialog
        folder={editing}
        folders={folders}
        onClose={() => setEditing(null)}
      />
      <DeleteFolderDialog folder={deleting} onClose={() => setDeleting(null)} />
    </section>
  );
}

/** Shared plumbing: run a server action, show its message, refresh on success. */
function useFolderAction(onDone: () => void) {
  const t = useT();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function run(
    action: (formData: FormData) => Promise<{ ok: true; data: unknown } | { ok: false; error: string }>,
    fields: Record<string, string>,
    after?: (data: unknown) => void,
  ) {
    setError(null);
    const formData = new FormData();
    for (const [key, value] of Object.entries(fields)) formData.set(key, value);

    startTransition(async () => {
      const result = await action(formData);
      if (!result.ok) {
        setError(result.error || t("common.actionFailed"));
        return;
      }
      after?.(result.data);
      router.refresh();
      onDone();
    });
  }

  return { run, pending, error, setError };
}

function CreateFolderDialog({
  open,
  parentId,
  onClose,
}: {
  open: boolean;
  parentId: string | null;
  onClose: () => void;
}) {
  const t = useT();
  const [name, setName] = useState("");
  const { run, pending, error } = useFolderAction(() => {
    setName("");
    onClose();
  });

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t("media.folders.newTitle")}
      description={t("media.folders.newDescription")}
      footer={
        <>
          <Button onClick={onClose} disabled={pending}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="primary"
            disabled={pending || name.trim() === ""}
            onClick={() => run(createFolderAction, { name, parentId: parentId ?? "" })}
          >
            {pending ? t("common.saving") : t("media.folders.create")}
          </Button>
        </>
      }
    >
      <Field label={t("media.folders.name")} htmlFor="folder-name">
        <Input
          id="folder-name"
          value={name}
          autoFocus
          maxLength={60}
          onChange={(event) => setName(event.target.value)}
          placeholder={t("media.folders.namePlaceholder")}
        />
      </Field>
      {error ? (
        <p role="alert" className="mt-2 text-[11px] text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : null}
    </Dialog>
  );
}

function EditFolderDialog({
  folder,
  folders,
  onClose,
}: {
  folder: MediaFolderDto | null;
  folders: MediaFolderDto[];
  onClose: () => void;
}) {
  const t = useT();
  const [name, setName] = useState("");
  const [parentId, setParentId] = useState("");
  const { run, pending, error } = useFolderAction(onClose);

  // Re-seed the fields each time a different folder opens the dialog. `key` on
  // the Dialog would do it too, but only by throwing away the mounted <dialog>.
  const [seeded, setSeeded] = useState<string | null>(null);
  if (folder && seeded !== folder.id) {
    setSeeded(folder.id);
    setName(folder.name);
    setParentId(folder.parentId ?? "");
  }

  if (!folder) return null;

  // Its own subtree is not on offer: the API rejects that move, and an option
  // that always fails is a trap, not a choice.
  const options = folderOptions(folders, folder.id);

  return (
    <Dialog
      open
      onClose={onClose}
      title={t("media.folders.editTitle")}
      description={t("media.folders.editDescription")}
      footer={
        <>
          <Button onClick={onClose} disabled={pending}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="primary"
            disabled={pending || name.trim() === ""}
            onClick={() => run(updateFolderAction, { id: folder.id, name, parentId })}
          >
            {pending ? t("common.saving") : t("common.save")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label={t("media.folders.name")} htmlFor="folder-rename">
          <Input
            id="folder-rename"
            value={name}
            autoFocus
            maxLength={60}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <Field label={t("media.folders.parent")} htmlFor="folder-parent">
          <Select
            id="folder-parent"
            value={parentId}
            onChange={(event) => setParentId(event.target.value)}
          >
            <option value="">{t("media.folders.root")}</option>
            {options.map((option) => (
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

function DeleteFolderDialog({
  folder,
  onClose,
}: {
  folder: MediaFolderDto | null;
  onClose: () => void;
}) {
  const t = useT();
  const [moved, setMoved] = useState<number | null>(null);
  const { run, pending, error } = useFolderAction(onClose);

  if (!folder) return null;

  return (
    <Dialog
      open
      onClose={onClose}
      title={t("media.folders.deleteTitle", { name: folder.name })}
      // Says what happens to the files, because the thing a user fears here is
      // that deleting a folder deletes the images their published pages render.
      description={t("media.folders.deleteDescription")}
      footer={
        <>
          <Button onClick={onClose} disabled={pending}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="destructive"
            disabled={pending}
            onClick={() =>
              run(deleteFolderAction, { id: folder.id }, (data) => {
                setMoved((data as { movedFiles: number }).movedFiles);
              })
            }
          >
            {pending ? t("common.deleting") : t("common.delete")}
          </Button>
        </>
      }
    >
      <p className="text-xs z-muted">
        {t("media.folders.deleteSummary", {
          files: folder.fileCount,
          folders: folder.subfolderCount,
        })}
      </p>
      {moved !== null ? (
        <p className="mt-2 text-[11px] z-muted">{t("media.folders.deleteMoved", { count: moved })}</p>
      ) : null}
      {error ? (
        <p role="alert" className="mt-2 text-[11px] text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : null}
    </Dialog>
  );
}
