import type { MediaFolderDto } from "@zcmsorg/schemas";

/**
 * The tree, derived on both sides of the wire.
 *
 * The API sends folders flat, deliberately (see MediaFoldersService.list): the
 * page needs a folder's ancestors for the breadcrumb and its children for the
 * grid in the same render, and both fall out of one list. These helpers are the
 * only place that shape is interpreted.
 */

export function childrenOf(
  folders: MediaFolderDto[],
  parentId: string | null,
): MediaFolderDto[] {
  return folders.filter((folder) => folder.parentId === parentId);
}

/** Root first, the folder itself last. Empty at the root. */
export function ancestorsOf(folders: MediaFolderDto[], id: string | null): MediaFolderDto[] {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const trail: MediaFolderDto[] = [];

  let cursor = id;
  // A cycle cannot survive the API's checks, but a bounded walk is cheaper than
  // trusting that in a render that would otherwise hang the browser.
  while (cursor && trail.length <= folders.length) {
    const folder = byId.get(cursor);
    if (!folder) break;
    trail.unshift(folder);
    cursor = folder.parentId;
  }
  return trail;
}

export interface FolderOption {
  id: string;
  /** Indented by depth, so a <select> reads as a tree. */
  label: string;
}

/**
 * Every folder, flattened depth-first, for the move pickers.
 *
 * `exclude` drops a folder and its whole subtree — a folder cannot be moved into
 * itself or into one of its own descendants, and an option that is guaranteed to
 * be rejected has no business being offered.
 */
export function folderOptions(
  folders: MediaFolderDto[],
  exclude?: string,
): FolderOption[] {
  const out: FolderOption[] = [];

  const walk = (parentId: string | null, depth: number): void => {
    for (const folder of childrenOf(folders, parentId)) {
      if (folder.id === exclude) continue;
      out.push({ id: folder.id, label: `${"  ".repeat(depth)}${folder.name}` });
      walk(folder.id, depth + 1);
    }
  };

  walk(null, 0);
  return out;
}
