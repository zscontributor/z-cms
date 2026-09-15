import {
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Post,
  Res,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from "@nestjs/swagger";
import { DeleteObjectsCommand, GetObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { db } from "@zcmsorg/database";
import type { SiteBackupDto } from "@zcmsorg/schemas";
import type { Response } from "express";
import type { Readable } from "node:stream";
import { Actor, RequirePermissions } from "../auth/decorators";
import { AuditService } from "../audit/audit.module";
import { t } from "../common/i18n";
import type { RequestActor } from "../common/request-context";
import { ApiAuthed, ApiNotFound, ApiZodResponse } from "../openapi/decorators";
import { QueueService } from "../queue/queue.module";

/**
 * Backups of a site: requested here, built by the worker, downloaded from here.
 *
 * The archive is the worker's job (`apps/worker/src/jobs/site-backup.ts`); this
 * module owns the ROW — the thing the admin polls while the archive is being
 * built — and the download, which streams each part out of the bucket through
 * the API. Through the API and not from a public URL, because the media bucket
 * is world-readable by design (that is how a browser fetches an image), and a
 * site's entire database is not something to leave at a guessable path in it.
 *
 * Nothing here reads the site's content. Everything is scoped by the same two
 * checks the sites controller uses: RLS narrows to the tenant, `mayUseSite` to
 * the sites this person holds a role on, and a miss is the one 404 for both.
 */

/** How long a finished backup stays downloadable. */
const RETENTION_DAYS = 7;

/** Mirrors the worker's default; only the row's value matters once it is written. */
function partBytesFromEnv(config: ConfigService): number {
  const mb = Number(config.get<string>("SITE_BACKUP_PART_MB") ?? 256);
  return Math.max(16, Number.isFinite(mb) ? Math.floor(mb) : 256) * 1024 * 1024;
}

function backupFilename(slug: string, at: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${at.getUTCFullYear()}${p(at.getUTCMonth() + 1)}${p(at.getUTCDate())}-${p(at.getUTCHours())}${p(at.getUTCMinutes())}`;
  return `${slug}-${stamp}.zip`;
}

interface StoredPart {
  index: number;
  storageKey: string;
  size: number;
  sha256: string;
}

type BackupRow = NonNullable<Awaited<ReturnType<ReturnType<typeof db>["siteBackup"]["findFirst"]>>>;

/** The public shape: storage keys stay inside, the part's file name goes out. */
export function toSiteBackupDto(row: BackupRow): SiteBackupDto {
  const parts = (Array.isArray(row.parts) ? row.parts : []) as unknown as StoredPart[];
  const summary = (row.summary ?? {}) as { counts?: Record<string, number>; mediaBytes?: number };
  return {
    id: row.id,
    siteId: row.siteId,
    status: row.status,
    filename: row.filename,
    partBytes: row.partBytes,
    totalBytes: row.totalBytes === null ? null : Number(row.totalBytes),
    parts: parts.map((p) => ({
      index: p.index,
      filename: p.storageKey.slice(p.storageKey.lastIndexOf("/") + 1),
      size: p.size,
      sha256: p.sha256,
    })),
    summary:
      row.status === "READY" && summary.counts
        ? { counts: summary.counts, mediaBytes: summary.mediaBytes ?? 0 }
        : null,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt.toISOString(),
  };
}

function mayUseSite(actor: RequestActor, id: string): boolean {
  return !actor.siteIds || actor.siteIds.includes(id);
}

@Injectable()
export class SiteBackupsService {
  private readonly s3: S3Client;
  private readonly bucket: string;

  constructor(
    private readonly config: ConfigService,
    private readonly queue: QueueService,
    private readonly audit: AuditService,
  ) {
    this.bucket = config.getOrThrow<string>("S3_BUCKET");
    this.s3 = new S3Client({
      endpoint: config.getOrThrow<string>("S3_ENDPOINT"),
      region: config.get<string>("S3_REGION") ?? "us-east-1",
      credentials: {
        accessKeyId: config.getOrThrow<string>("S3_ACCESS_KEY"),
        secretAccessKey: config.getOrThrow<string>("S3_SECRET_KEY"),
      },
      forcePathStyle: true,
    });
  }

  /** The site, or the shared 404. */
  private async site(actor: RequestActor, siteId: string): Promise<{ id: string; slug: string }> {
    const site = mayUseSite(actor, siteId)
      ? await db().site.findUnique({ where: { id: siteId }, select: { id: true, slug: true } })
      : null;
    if (!site) throw new NotFoundException(t()("errors.sites.notFound"));
    return site;
  }

  async list(actor: RequestActor, siteId: string): Promise<SiteBackupDto[]> {
    await this.site(actor, siteId);
    const rows = await db().siteBackup.findMany({
      where: { siteId },
      orderBy: { createdAt: "desc" },
      take: 20,
    });
    return rows.map(toSiteBackupDto);
  }

  async get(actor: RequestActor, siteId: string, backupId: string): Promise<SiteBackupDto> {
    await this.site(actor, siteId);
    const row = await db().siteBackup.findFirst({ where: { id: backupId, siteId } });
    if (!row) throw new NotFoundException(t()("errors.backups.notFound"));
    return toSiteBackupDto(row);
  }

  /**
   * Creates the row and queues the build. One in flight per site: a second
   * request while one is building would archive the same bytes twice and, on a
   * large site, double the worker's disk for nothing.
   */
  async create(actor: RequestActor, siteId: string): Promise<SiteBackupDto> {
    const site = await this.site(actor, siteId);

    const inFlight = await db().siteBackup.findFirst({
      where: { siteId, status: { in: ["PENDING", "RUNNING"] } },
      select: { id: true },
    });
    if (inFlight) throw new ConflictException(t()("errors.backups.inProgress"));

    const now = new Date();
    const row = await db().siteBackup.create({
      data: {
        tenantId: actor.tenantId,
        siteId,
        filename: backupFilename(site.slug, now),
        partBytes: partBytesFromEnv(this.config),
        createdById: actor.userId,
        expiresAt: new Date(now.getTime() + RETENTION_DAYS * 86_400_000),
      },
    });

    // The row above commits when this REQUEST ends (TenantInterceptor), which is
    // after the enqueue below. A short delay keeps the worker from asking for a
    // row that is not visible yet; the worker also retries a miss, for the day
    // the commit takes longer than this.
    await this.queue.enqueue(
      "site.backup",
      { tenantId: actor.tenantId, siteId, backupId: row.id },
      { jobId: `site.backup:${row.id}`, delayMs: 1500 },
    );
    await this.audit.record(actor, "site.backup.requested", "site", siteId, { backupId: row.id });

    return toSiteBackupDto(row);
  }

  /**
   * Streams one part to the caller.
   *
   * `Range` is honoured — passed straight through to the bucket — so a browser
   * or `curl -C -` can resume a part that was cut off, which for a 256 MB file
   * on a home connection is not a luxury.
   *
   * Returns as soon as the stream is flowing, NOT when it ends. The request runs
   * inside the tenant transaction (see TenantInterceptor), and that transaction
   * has a timeout measured in seconds; a part takes as long as the caller's
   * connection takes. Everything that needs the database happens before this
   * returns, and the bytes that follow need only the bucket and the socket.
   */
  async download(
    actor: RequestActor,
    siteId: string,
    backupId: string,
    index: number,
    range: string | undefined,
    res: Response,
  ): Promise<void> {
    await this.site(actor, siteId);
    const row = await db().siteBackup.findFirst({ where: { id: backupId, siteId } });
    if (!row || row.status !== "READY") throw new NotFoundException(t()("errors.backups.notFound"));

    const parts = (Array.isArray(row.parts) ? row.parts : []) as unknown as StoredPart[];
    const part = parts.find((p) => p.index === index);
    if (!part) throw new NotFoundException(t()("errors.backups.partNotFound"));

    const object = await this.s3.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: part.storageKey, Range: range }),
    );
    const filename = part.storageKey.slice(part.storageKey.lastIndexOf("/") + 1);

    res.status(object.ContentRange ? 206 : 200);
    res.setHeader("content-type", "application/octet-stream");
    res.setHeader("content-disposition", `attachment; filename="${filename}"`);
    res.setHeader("accept-ranges", "bytes");
    res.setHeader("cache-control", "private, no-store");
    if (object.ContentLength !== undefined) res.setHeader("content-length", String(object.ContentLength));
    if (object.ContentRange) res.setHeader("content-range", object.ContentRange);
    res.setHeader("x-part-sha256", part.sha256);

    const body = object.Body as Readable;
    // A bucket read that fails mid-stream cannot become an HTTP error any more
    // (the status line went out with the first byte); cutting the socket is the
    // one honest signal left, and it is what makes the client's checksum fail.
    body.on("error", (err) => res.destroy(err));
    res.on("close", () => body.destroy());
    body.pipe(res);
  }

  async remove(actor: RequestActor, siteId: string, backupId: string): Promise<void> {
    await this.site(actor, siteId);
    const row = await db().siteBackup.findFirst({ where: { id: backupId, siteId } });
    if (!row) throw new NotFoundException(t()("errors.backups.notFound"));
    // A build in progress would write parts after this delete; let it finish
    // (or fail) and delete then. The row's status says which.
    if (row.status === "PENDING" || row.status === "RUNNING") {
      throw new ConflictException(t()("errors.backups.inProgress"));
    }

    await this.deletePrefix(`backups/${siteId}/${backupId}/`);
    await db().siteBackup.delete({ where: { id: backupId } });
    await this.audit.record(actor, "site.backup.deleted", "site", siteId, { backupId });
  }

  private async deletePrefix(prefix: string): Promise<void> {
    let token: string | undefined;
    do {
      const page = await this.s3.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }),
      );
      const keys = (page.Contents ?? []).map((o) => o.Key).filter((k): k is string => !!k);
      if (keys.length) {
        await this.s3.send(
          new DeleteObjectsCommand({
            Bucket: this.bucket,
            Delete: { Objects: keys.map((Key) => ({ Key })) },
          }),
        );
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
  }
}

@ApiTags("Sites")
@Controller("sites/:id/backups")
export class SiteBackupsController {
  constructor(private readonly backups: SiteBackupsService) {}

  @Get()
  @ApiOperation({
    summary: "List a site's backups",
    description: "The twenty most recent, newest first, whatever their state.",
  })
  @ApiAuthed("site:update")
  @ApiZodResponse("SiteBackupDto", { isArray: true })
  @ApiNotFound("No such site — or not one of yours.")
  @RequirePermissions("site:update")
  list(@Actor() actor: RequestActor, @Param("id") id: string): Promise<SiteBackupDto[]> {
    return this.backups.list(actor, id);
  }

  @Post()
  @HttpCode(202)
  @ApiOperation({
    summary: "Request a backup of a site",
    description:
      "Queues a background job that archives every row and every media file the " +
      "site owns into one zip, split into parts of a fixed size. Poll the returned " +
      "backup until its status is READY, then download each part and join them. " +
      "One backup may be in progress per site at a time.",
  })
  @ApiAuthed("site:update")
  @ApiZodResponse("SiteBackupDto", { status: 202, description: "The backup, PENDING." })
  @ApiResponse({ status: 409, description: "A backup of this site is already being built." })
  @ApiNotFound("No such site — or not one of yours.")
  @RequirePermissions("site:update")
  create(@Actor() actor: RequestActor, @Param("id") id: string): Promise<SiteBackupDto> {
    return this.backups.create(actor, id);
  }

  @Get(":backupId")
  @ApiOperation({ summary: "Read one backup", description: "Poll this while it builds." })
  @ApiAuthed("site:update")
  @ApiZodResponse("SiteBackupDto")
  @ApiNotFound("No such backup.")
  @RequirePermissions("site:update")
  get(
    @Actor() actor: RequestActor,
    @Param("id") id: string,
    @Param("backupId") backupId: string,
  ): Promise<SiteBackupDto> {
    return this.backups.get(actor, id, backupId);
  }

  @Get(":backupId/parts/:index")
  @ApiOperation({
    summary: "Download one part of a backup",
    description:
      "Streams the part as an attachment. Honours `Range`, so an interrupted " +
      "download can resume. The part's SHA-256 rides in `X-Part-Sha256`. Join " +
      "parts in order (`cat name.zip.* > name.zip`) to recover the archive.",
  })
  @ApiParam({ name: "index", description: "1-based part number." })
  @ApiAuthed("site:update")
  @ApiResponse({
    status: 200,
    description: "The part's bytes.",
    content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } },
  })
  @ApiNotFound("No such backup, not READY yet, or no such part.")
  @RequirePermissions("site:update")
  async download(
    @Actor() actor: RequestActor,
    @Param("id") id: string,
    @Param("backupId") backupId: string,
    @Param("index") index: string,
    @Res() res: Response,
  ): Promise<void> {
    const n = Number(index);
    if (!Number.isInteger(n) || n < 1) throw new NotFoundException(t()("errors.backups.partNotFound"));
    const range = res.req.headers.range;
    await this.backups.download(actor, id, backupId, n, range, res);
  }

  @Delete(":backupId")
  @HttpCode(204)
  @ApiOperation({
    summary: "Delete a backup",
    description: "Removes the archive's parts from storage and the record of it.",
  })
  @ApiAuthed("site:update")
  @ApiResponse({ status: 204, description: "Deleted." })
  @ApiResponse({ status: 409, description: "Still being built — wait for it to finish." })
  @ApiNotFound("No such backup.")
  @RequirePermissions("site:update")
  remove(
    @Actor() actor: RequestActor,
    @Param("id") id: string,
    @Param("backupId") backupId: string,
  ): Promise<void> {
    return this.backups.remove(actor, id, backupId);
  }
}

@Module({
  controllers: [SiteBackupsController],
  providers: [SiteBackupsService],
  exports: [SiteBackupsService],
})
export class SiteBackupsModule {}
