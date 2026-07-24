"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import type { MediaDto, MediaFolderDto } from "@zcmsorg/schemas";
import { bulkDeleteMediaAction, bulkMoveMediaAction } from "@/app/actions/media";
import { MediaThumb } from "@/components/editor/media-picker";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Checkbox, Field, Select } from "@/components/ui/field";
import { Icon } from "@/components/shell/icon";
import { cn } from "@/lib/cn";
import { formatBytes, formatDateTime } from "@/lib/format";
import { useT } from "@/lib/i18n-provider";
import { CopyUrlButton } from "./copy-url-button";
import { FileActions } from "./file-actions";
import { folderOptions } from "./folder-tree";

/**
 * The library grid, with a selection.
 *
 * Selection is page-local and deliberately not persisted in the URL: it is a
 * gesture, not a place. Paginating away from a selection drops it, which is the
 * behaviour that cannot surprise anyone — the alternative is a "Delete (12)"
 * button whose 12 files are no longer on screen.
 */
export function FileGrid({
  items,
  folders,
  locale,
  canUpdate,
  canDelete,
}: {
  items: MediaDto[];
  folders: MediaFolderDto[];
  locale: string;
  canUpdate: boolean;
  canDelete: boolean;
}) {
  const t = useT();
  const [selected, setSelected] = useState<string[]>([]);

  const selectable = canUpdate || canDelete;

  // A refresh (an upload, a delete, a page change) can retire ids that are still
  // selected. Acting on them would ask the API to move files that no longer
  // exist, so the selection is pruned to what is actually on screen.
  useEffect(() => {
    setSelected((current) => current.filter((id) => items.some((item) => item.id === id)));
  }, [items]);

  function toggle(id: string) {
    setSelected((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    );
  }

  const allSelected = items.length > 0 && selected.length === items.length;

  return (
    <>
      {selectable ? (
        <SelectionBar
          selected={selected}
          allSelected={allSelected}
          onSelectAll={() => setSelected(allSelected ? [] : items.map((item) => item.id))}
          onClear={() => setSelected([])}
          folders={folders}
          canUpdate={canUpdate}
          canDelete={canDelete}
        />
      ) : null}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
        {items.map((media) => {
          const active = selected.includes(media.id);
          return (
            <figure
              key={media.id}
              className={cn(
                "z-card relative overflow-hidden transition-shadow",
                active && "ring-2 ring-brand-500/50",
              )}
            >
              {selectable ? (
                <label className="absolute left-1.5 top-1.5 z-10 flex size-6 cursor-pointer items-center justify-center rounded-md bg-[var(--surface-raised)]/90 shadow-sm">
                  <Checkbox
                    checked={active}
                    onChange={() => toggle(media.id)}
                    aria-label={t("media.bulk.selectAria", { name: media.filename })}
                  />
                </label>
              ) : null}

              <MediaThumb media={media} />

              <figcaption className="p-2">
                <p className="truncate text-[11px] font-medium" title={media.filename}>
                  {media.filename}
                </p>
                <p className="mt-0.5 text-[10px] z-muted">
                  {formatBytes(media.size)}
                  {media.width && media.height ? ` · ${media.width}×${media.height}` : ""}
                </p>
                <p className="text-[10px] z-muted">{formatDateTime(media.createdAt, locale)}</p>
                <div className="mt-1.5 flex items-center gap-0.5">
                  <span className="min-w-0 flex-1">
                    <CopyUrlButton url={media.url} />
                  </span>
                  <FileActions
                    media={media}
                    folders={folders}
                    canUpdate={canUpdate}
                    canDelete={canDelete}
                  />
                </div>
              </figcaption>
            </figure>
          );
        })}
      </div>
    </>
  );
}

function SelectionBar({
  selected,
  allSelected,
  onSelectAll,
  onClear,
  folders,
  canUpdate,
  canDelete,
}: {
  selected: string[];
  allSelected: boolean;
  onSelectAll: () => void;
  onClear: () => void;
  folders: MediaFolderDto[];
  canUpdate: boolean;
  canDelete: boolean;
}) {
  const t = useT();
  const [moving, setMoving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const count = selected.length;

  return (
    <div className="mb-3 flex flex-wrap items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--surface-sunken)] px-2.5 py-1.5">
      <Button size="sm" variant="ghost" onClick={onSelectAll}>
        <Icon name={allSelected ? "check" : "grid"} size={16} />
        {allSelected ? t("media.bulk.selectNone") : t("media.bulk.selectAll")}
      </Button>

      <span className="text-[11px] z-muted">
        {count === 0 ? t("media.bulk.none") : t("media.bulk.count", { count })}
      </span>

      <span className="ml-auto flex items-center gap-1.5">
        {canUpdate ? (
          <Button size="sm" disabled={count === 0} onClick={() => setMoving(true)}>
            <Icon name="folder" size={16} />
            {t("media.bulk.move")}
          </Button>
        ) : null}
        {canDelete ? (
          <Button
            size="sm"
            variant="danger"
            disabled={count === 0}
            onClick={() => setDeleting(true)}
          >
            <Icon name="trash" size={16} />
            {t("media.bulk.delete", { count })}
          </Button>
        ) : null}
        {count > 0 ? (
          <Button size="sm" variant="ghost" onClick={onClear}>
            {t("common.clear")}
          </Button>
        ) : null}
      </span>

      {moving ? (
        <MoveDialog
          ids={selected}
          folders={folders}
          onClose={() => setMoving(false)}
          onDone={onClear}
        />
      ) : null}
      {deleting ? (
        <BulkDeleteDialog ids={selected} onClose={() => setDeleting(false)} onDone={onClear} />
      ) : null}
    </div>
  );
}

/** Both bulk dialogs: run the action, report what the API actually did, refresh. */
function useBulkAction(onDone: () => void, onClose: () => void) {
  const t = useT();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function run<T>(
    action: (formData: FormData) => Promise<{ ok: true; data: T } | { ok: false; error: string }>,
    formData: FormData,
  ) {
    setError(null);
    startTransition(async () => {
      const result = await action(formData);
      if (!result.ok) {
        setError(result.error || t("common.actionFailed"));
        return;
      }
      router.refresh();
      onDone();
      onClose();
    });
  }

  return { run, pending, error };
}

function MoveDialog({
  ids,
  folders,
  onClose,
  onDone,
}: {
  ids: string[];
  folders: MediaFolderDto[];
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useT();
  const [folderId, setFolderId] = useState("");
  const { run, pending, error } = useBulkAction(onDone, onClose);

  function move() {
    const formData = new FormData();
    for (const id of ids) formData.append("ids", id);
    formData.set("folderId", folderId);
    run(bulkMoveMediaAction, formData);
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={t("media.bulk.moveTitle", { count: ids.length })}
      description={t("media.bulk.moveDescription")}
      footer={
        <>
          <Button onClick={onClose} disabled={pending}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" disabled={pending} onClick={move}>
            {pending ? t("common.working") : t("media.bulk.moveConfirm")}
          </Button>
        </>
      }
    >
      <Field label={t("media.file.folder")} htmlFor="bulk-folder">
        <Select
          id="bulk-folder"
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
      {error ? (
        <p role="alert" className="mt-2 text-[11px] text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : null}
    </Dialog>
  );
}

function BulkDeleteDialog({
  ids,
  onClose,
  onDone,
}: {
  ids: string[];
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useT();
  const { run, pending, error } = useBulkAction(onDone, onClose);

  function remove() {
    const formData = new FormData();
    for (const id of ids) formData.append("ids", id);
    run(bulkDeleteMediaAction, formData);
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={t("media.bulk.deleteTitle", { count: ids.length })}
      description={t("media.bulk.deleteDescription", { count: ids.length })}
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
      {/* Same honesty as the single delete, and it matters more here: the library
          cannot tell which pages embed these files, and this deletes many at once. */}
      <p className="text-xs z-muted">{t("media.file.deleteWarning")}</p>
      {error ? (
        <p role="alert" className="mt-2 text-[11px] text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : null}
    </Dialog>
  );
}
