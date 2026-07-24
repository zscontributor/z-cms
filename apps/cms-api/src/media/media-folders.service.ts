import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { db } from "@zcmsorg/database";
import type {
  CreateMediaFolderInput,
  MediaFolderDto,
  UpdateMediaFolderInput,
} from "@zcmsorg/schemas";
import { AuditService } from "../audit/audit.module";
import { t } from "../common/i18n";
import { toMediaFolderDto } from "../common/mappers";
import type { RequestActor } from "../common/request-context";

/**
 * How deep the tree may go.
 *
 * Not a storage limit — there is no path to overflow, since folders are metadata.
 * It is a UI limit: a breadcrumb that wraps onto three lines has stopped telling
 * anyone where they are, and a library that needs eight levels of nesting needs
 * search, not more nesting.
 */
const MAX_DEPTH = 5;

const COUNTS = { _count: { select: { media: true, children: true } } } as const;

@Injectable()
export class MediaFoldersService {
  constructor(private readonly audit: AuditService) {}

  /**
   * Every folder on the site, flat.
   *
   * The whole tree in one query, on purpose: a media library holds tens of
   * folders, not thousands, and the admin needs the ancestors of the current
   * folder (for the breadcrumb) and its children (for the grid) in the same
   * render. Fetching level by level would be a round trip per breadcrumb crumb.
   */
  async list(siteId: string): Promise<MediaFolderDto[]> {
    const folders = await db().mediaFolder.findMany({
      where: { siteId },
      orderBy: { name: "asc" },
      include: COUNTS,
    });
    return folders.map(toMediaFolderDto);
  }

  async create(
    actor: RequestActor,
    siteId: string,
    input: CreateMediaFolderInput,
  ): Promise<MediaFolderDto> {
    const parentId = input.parentId ?? null;

    if (parentId) {
      const parent = await this.mustFind(siteId, parentId);
      if ((await this.depthOf(siteId, parent.id)) + 1 >= MAX_DEPTH) {
        throw new BadRequestException(t()("errors.media.folderTooDeep", { max: MAX_DEPTH }));
      }
    }
    await this.assertNameFree(siteId, parentId, input.name);

    const folder = await db().mediaFolder.create({
      data: { tenantId: actor.tenantId, siteId, parentId, name: input.name },
      include: COUNTS,
    });

    await this.audit.record(actor, "media.folder.created", "media_folder", folder.id, {
      name: folder.name,
      parentId,
    });

    return toMediaFolderDto(folder);
  }

  async update(
    actor: RequestActor,
    siteId: string,
    id: string,
    input: UpdateMediaFolderInput,
  ): Promise<MediaFolderDto> {
    const folder = await this.mustFind(siteId, id);

    const name = input.name ?? folder.name;
    const parentId = input.parentId !== undefined ? input.parentId : folder.parentId;

    if (parentId !== folder.parentId) {
      if (parentId) {
        if (parentId === id) {
          throw new BadRequestException(t()("errors.media.folderCycle"));
        }
        await this.mustFind(siteId, parentId);
        // Re-parenting a folder into its own subtree would detach that subtree
        // from the root entirely: the loop would still be a valid set of rows,
        // and every folder in it would vanish from the library forever.
        const descendants = await this.descendantIds(siteId, id);
        if (descendants.has(parentId)) {
          throw new BadRequestException(t()("errors.media.folderCycle"));
        }
      }
      const depth = parentId ? (await this.depthOf(siteId, parentId)) + 1 : 0;
      if (depth + (await this.heightOf(siteId, id)) >= MAX_DEPTH) {
        throw new BadRequestException(t()("errors.media.folderTooDeep", { max: MAX_DEPTH }));
      }
    }

    if (name !== folder.name || parentId !== folder.parentId) {
      await this.assertNameFree(siteId, parentId, name, id);
    }

    const updated = await db().mediaFolder.update({
      where: { id },
      data: { name, parentId },
      include: COUNTS,
    });

    await this.audit.record(actor, "media.folder.updated", "media_folder", id, {
      name: updated.name,
      parentId: updated.parentId,
    });

    return toMediaFolderDto(updated);
  }

  /**
   * Deletes the folder and its subfolders — and keeps every file.
   *
   * A folder is a label, so deleting one is a filing decision, not a decision to
   * destroy assets: the files inside (and inside its subfolders) move up to where
   * the deleted folder used to sit. Nobody who tidies up their folders expects
   * the images on their published pages to go dark, and there is no undo for that.
   * Deleting a *file* is the separate, explicit act.
   *
   * Returns how many files were re-filed, so the admin can say so.
   */
  async remove(actor: RequestActor, siteId: string, id: string): Promise<{ movedFiles: number }> {
    const folder = await this.mustFind(siteId, id);

    const subtree = await this.descendantIds(siteId, id);
    subtree.add(id);

    const { count } = await db().media.updateMany({
      where: { siteId, folderId: { in: [...subtree] } },
      data: { folderId: folder.parentId },
    });

    // The subfolders go with it — the FK cascades. The media rows are already
    // out of the way, so the `ON DELETE SET NULL` on media.folder_id never fires
    // and nothing lands at the root by accident.
    await db().mediaFolder.delete({ where: { id } });

    await this.audit.record(actor, "media.folder.deleted", "media_folder", id, {
      name: folder.name,
      subfolders: subtree.size - 1,
      movedFiles: count,
    });

    return { movedFiles: count };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async mustFind(siteId: string, id: string) {
    const folder = await db().mediaFolder.findFirst({ where: { id, siteId } });
    if (!folder) throw new NotFoundException(t()("errors.media.folderNotFound"));
    return folder;
  }

  /**
   * The uniqueness rule the database also enforces, checked here so the caller
   * gets a sentence instead of a constraint violation. The index stays the
   * authority — a race between two creates still ends in one of them failing.
   */
  private async assertNameFree(
    siteId: string,
    parentId: string | null,
    name: string,
    exceptId?: string,
  ): Promise<void> {
    const clash = await db().mediaFolder.findFirst({
      where: {
        siteId,
        parentId,
        name,
        ...(exceptId ? { NOT: { id: exceptId } } : {}),
      },
      select: { id: true },
    });
    if (clash) {
      throw new BadRequestException(t()("errors.media.folderNameTaken", { name }));
    }
  }

  /** Every folder on the site, as `id -> parentId`. The tree is small; one query. */
  private async edges(siteId: string): Promise<Map<string, string | null>> {
    const rows = await db().mediaFolder.findMany({
      where: { siteId },
      select: { id: true, parentId: true },
    });
    return new Map(rows.map((row) => [row.id, row.parentId]));
  }

  /** Levels above `id`: 0 at the root. */
  private async depthOf(siteId: string, id: string): Promise<number> {
    const parents = await this.edges(siteId);
    let depth = 0;
    let cursor = parents.get(id) ?? null;
    while (cursor && depth <= MAX_DEPTH) {
      depth += 1;
      cursor = parents.get(cursor) ?? null;
    }
    return depth;
  }

  /** Levels below `id`: 0 for a leaf. */
  private async heightOf(siteId: string, id: string): Promise<number> {
    const parents = await this.edges(siteId);
    const children = new Map<string, string[]>();
    for (const [child, parent] of parents) {
      if (!parent) continue;
      children.set(parent, [...(children.get(parent) ?? []), child]);
    }

    const walk = (node: string, level: number): number => {
      const kids = children.get(node) ?? [];
      if (kids.length === 0 || level > MAX_DEPTH) return level;
      return Math.max(...kids.map((kid) => walk(kid, level + 1)));
    };
    return walk(id, 0);
  }

  private async descendantIds(siteId: string, id: string): Promise<Set<string>> {
    const parents = await this.edges(siteId);
    const out = new Set<string>();

    // Walk *up* from every folder rather than down from this one: the parent
    // pointer is the edge we have, and it makes a corrupted cycle terminate
    // (the seen-set stops it) instead of hanging the request.
    for (const start of parents.keys()) {
      const seen = new Set<string>();
      let cursor = parents.get(start) ?? null;
      while (cursor && !seen.has(cursor)) {
        if (cursor === id) {
          out.add(start);
          break;
        }
        seen.add(cursor);
        cursor = parents.get(cursor) ?? null;
      }
    }
    return out;
  }
}
