import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { db } from "@zcmsorg/database";
import type { MediaDto, Paginated, UpdateMediaInput } from "@zcmsorg/schemas";
import { randomUUID } from "node:crypto";
import { extname } from "node:path";
import { AuditService } from "../audit/audit.module";
import { t } from "../common/i18n";
import { toMediaDto } from "../common/mappers";
import type { RequestActor } from "../common/request-context";
import { QueueService } from "../queue/queue.module";

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
export const MAX_UPLOAD_LABEL = `${MAX_UPLOAD_BYTES / (1024 * 1024)}MB`;

// An allowlist, not a blocklist. A blocklist of "dangerous" types is a losing
// game: anything not explicitly listed here cannot be uploaded, so a new attack
// format is not a new vulnerability. SVG is excluded on purpose — it can carry
// script and would execute on the same origin as the site.
export const ALLOWED_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/avif",
  "image/gif",
  "application/pdf",
]);

/** What the library's type filter offers. Anything not an image is a document. */
export const MEDIA_KINDS = ["image", "document"] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

/**
 * Which folder to list.
 *
 * "root" and `undefined` are NOT the same query and must not be collapsed:
 * browsing the root shows only the files filed at the root, while a search has
 * to reach across every folder or it would answer "no results" about a file the
 * user can see two folders away. The admin sends "root" while browsing and drops
 * the parameter entirely while searching.
 */
export type FolderScope = string | "root" | undefined;

export interface MediaListQuery {
  page: number;
  perPage: number;
  search?: string;
  kind?: MediaKind;
  folder?: FolderScope;
}

@Injectable()
export class MediaService {
  private readonly s3: S3Client;
  private readonly bucket: string;
  private readonly publicUrl: string;

  constructor(
    private readonly config: ConfigService,
    private readonly queue: QueueService,
    private readonly audit: AuditService,
  ) {
    this.bucket = this.config.getOrThrow<string>("S3_BUCKET");
    this.publicUrl = this.config.getOrThrow<string>("S3_PUBLIC_URL");

    this.s3 = new S3Client({
      endpoint: this.config.getOrThrow<string>("S3_ENDPOINT"),
      region: this.config.get<string>("S3_REGION") ?? "us-east-1",
      credentials: {
        accessKeyId: this.config.getOrThrow<string>("S3_ACCESS_KEY"),
        secretAccessKey: this.config.getOrThrow<string>("S3_SECRET_KEY"),
      },
      // Self-hosted S3 services address buckets as a path, not a subdomain.
      forcePathStyle: true,
    });
  }

  async upload(
    actor: RequestActor,
    siteId: string,
    file: Express.Multer.File,
    folderId?: string | null,
  ): Promise<MediaDto> {
    if (!file) throw new BadRequestException(t()("errors.media.noFile"));
    if (file.size > MAX_UPLOAD_BYTES) {
      throw new BadRequestException(
        t()("errors.media.tooLarge", { limit: MAX_UPLOAD_LABEL }),
      );
    }
    if (!ALLOWED_MIME.has(file.mimetype)) {
      throw new BadRequestException(
        t()("errors.media.unsupportedType", { mimeType: file.mimetype }),
      );
    }
    if (folderId) await this.assertFolder(siteId, folderId);

    // The key is generated, never taken from the client's filename: a name like
    // "../../etc/passwd" or a collision with another tenant's object would
    // otherwise be the caller's choice. The site id prefix also means one
    // tenant's objects are trivially separable at the storage layer.
    //
    // Note it carries no folder: the tree is metadata (see MediaFolder), so a
    // file that moves between folders never moves in the bucket and its URL
    // never changes.
    const ext = extname(file.originalname).toLowerCase().slice(0, 10);
    const storageKey = `sites/${siteId}/${randomUUID()}${ext}`;

    // No ACL parameter: read access is a property of the bucket, set once when
    // the bucket is created. Sending a per-object ACL is not portable across S3
    // implementations — RustFS rejects the request outright — and it would put
    // the decision in the upload path, where it does not belong.
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: storageKey,
        Body: file.buffer,
        ContentType: file.mimetype,
        CacheControl: "public, max-age=31536000, immutable",
      }),
    );

    const media = await db().media.create({
      data: {
        tenantId: actor.tenantId,
        siteId,
        storageKey,
        filename: file.originalname,
        mimeType: file.mimetype,
        size: file.size,
        folderId: folderId ?? null,
        uploadedById: actor.userId,
      },
    });

    // Resizing happens off the request path. The upload returns now, with the
    // original; the worker generates thumb/medium/large and records them a moment
    // later. jobId is the media id, so a retry of this upload never queues the
    // work twice.
    await this.queue.enqueue(
      "media.variants",
      {
        tenantId: actor.tenantId,
        siteId,
        mediaId: media.id,
        storageKey,
        mimeType: file.mimetype,
      },
      // BullMQ forbids ":" in a custom job id (it is its own key separator).
      { jobId: `media-variants-${media.id}` },
    );

    await this.audit.record(actor, "media.uploaded", "media", media.id, {
      filename: media.filename,
      mimeType: media.mimeType,
      size: media.size,
    });

    return toMediaDto(media, this.publicUrl);
  }

  async list(siteId: string, query: MediaListQuery): Promise<Paginated<MediaDto>> {
    const where = {
      siteId,
      ...(query.search
        ? {
            OR: [
              { filename: { contains: query.search, mode: "insensitive" as const } },
              { alt: { contains: query.search, mode: "insensitive" as const } },
            ],
          }
        : {}),
      ...(query.kind === "image" ? { mimeType: { startsWith: "image/" } } : {}),
      ...(query.kind === "document" ? { NOT: { mimeType: { startsWith: "image/" } } } : {}),
      ...(query.folder === undefined
        ? {}
        : { folderId: query.folder === "root" ? null : query.folder }),
    };

    const [items, total] = await Promise.all([
      db().media.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (query.page - 1) * query.perPage,
        take: query.perPage,
      }),
      db().media.count({ where }),
    ]);

    return {
      items: items.map((m) => toMediaDto(m, this.publicUrl)),
      page: query.page,
      perPage: query.perPage,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.perPage)),
    };
  }

  /**
   * Rename, describe, or re-file one asset.
   *
   * None of it touches storage. `filename` is a label — the object key was minted
   * at upload and never derived from the name — so a rename cannot break a page
   * that already embeds the file, and neither can a move.
   */
  async update(
    actor: RequestActor,
    siteId: string,
    id: string,
    input: UpdateMediaInput,
  ): Promise<MediaDto> {
    const media = await db().media.findFirst({ where: { id, siteId } });
    if (!media) throw new NotFoundException(t()("errors.media.notFound"));

    if (input.folderId) await this.assertFolder(siteId, input.folderId);

    // Only the keys the caller actually sent. Spreading the whole input would
    // turn "rename this file" into "…and clear its alt text", because an absent
    // key and an explicit null arrive here looking similar but mean the opposite.
    const data: {
      filename?: string;
      alt?: string | null;
      folderId?: string | null;
    } = {};
    if (input.filename !== undefined) data.filename = input.filename;
    if (input.alt !== undefined) data.alt = input.alt;
    if (input.folderId !== undefined) data.folderId = input.folderId;

    if (Object.keys(data).length === 0) return toMediaDto(media, this.publicUrl);

    const updated = await db().media.update({ where: { id }, data });

    await this.audit.record(actor, "media.updated", "media", id, {
      changed: Object.keys(data),
      filename: updated.filename,
    });

    return toMediaDto(updated, this.publicUrl);
  }

  /**
   * Move many files at once.
   *
   * `siteId` is in the WHERE clause, not merely validated: a caller who slips an
   * id from another tenant into the list gets it silently ignored rather than
   * moved. That is why the count is returned — the UI reports what actually
   * happened instead of assuming the selection and the result agree.
   */
  async bulkMove(
    actor: RequestActor,
    siteId: string,
    ids: string[],
    folderId: string | null,
  ): Promise<{ moved: number }> {
    if (folderId) await this.assertFolder(siteId, folderId);

    const { count } = await db().media.updateMany({
      where: { siteId, id: { in: ids } },
      data: { folderId },
    });

    await this.audit.record(actor, "media.bulk_moved", "media", null, {
      requested: ids.length,
      moved: count,
      folderId,
    });

    return { moved: count };
  }

  async bulkRemove(
    actor: RequestActor,
    siteId: string,
    ids: string[],
  ): Promise<{ deleted: number }> {
    // Read them first: once the rows are gone, the audit log cannot say what was
    // deleted, and "10 media rows removed" is not a record anyone can act on.
    const doomed = await db().media.findMany({
      where: { siteId, id: { in: ids } },
      select: { id: true, filename: true, storageKey: true },
    });

    const { count } = await db().media.deleteMany({
      where: { siteId, id: { in: doomed.map((m) => m.id) } },
    });

    await this.audit.record(actor, "media.bulk_deleted", "media", null, {
      requested: ids.length,
      deleted: count,
      files: doomed.map((m) => ({ id: m.id, filename: m.filename, storageKey: m.storageKey })),
    });

    return { deleted: count };
  }

  async remove(actor: RequestActor, siteId: string, id: string): Promise<void> {
    const media = await db().media.findFirst({ where: { id, siteId } });
    if (!media) throw new NotFoundException(t()("errors.media.notFound"));

    // The database row goes; the object stays. Content may still reference the
    // URL, and an orphaned object is cheap while a broken image on a live page
    // is not. A background sweeper reclaims unreferenced objects later.
    await db().media.delete({ where: { id } });

    await this.audit.record(actor, "media.deleted", "media", id, {
      filename: media.filename,
      storageKey: media.storageKey,
    });
  }

  /** A folder id from a client is a claim, not a fact — it may name another site's. */
  private async assertFolder(siteId: string, folderId: string): Promise<void> {
    const folder = await db().mediaFolder.findFirst({
      where: { id: folderId, siteId },
      select: { id: true },
    });
    if (!folder) throw new NotFoundException(t()("errors.media.folderNotFound"));
  }
}
