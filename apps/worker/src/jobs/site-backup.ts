import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough, Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  CopyObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSystemDb } from "@zcmsorg/database";
import type { JobPayloads } from "@zcmsorg/queue";
import archiver from "archiver";

/**
 * Builds a site's backup: one zip of every row and every file the site owns,
 * cut into fixed-size parts and written to the bucket under
 * `backups/<siteId>/<backupId>/`.
 *
 * ONE zip stream, split by byte count — not one zip per section, and not one zip
 * per N megabytes of content. The owner joins the parts with `cat` (or `copy /b`)
 * and has the original archive; there is nothing to reconcile across pieces and
 * no second tool to install. A site whose archive fits in one part gets a single
 * `.zip` and no joining at all.
 *
 * Memory stays flat regardless of the site's size: rows are read in pages and
 * written into the archive as they arrive, media objects are streamed straight
 * from the bucket into the zip, and each part is spooled to a temp file and
 * uploaded the moment it closes, so at most one part's worth of bytes is ever on
 * disk and none of it is in the heap.
 *
 * Reads through the system client. The tenant id comes from the job, which
 * cms-api stamped from a verified session, and every query below is filtered by
 * BOTH tenant and site — the same discipline `media.variants` and the sweep use.
 * A tenant transaction would be the wrong tool here: it is bounded to seconds,
 * and a large site takes minutes.
 */

/** Written into manifest.json so a future importer can tell what it is reading. */
export const BACKUP_FORMAT = 1;

/** Read pages of this many rows, so a table of a million rows never sits in the heap. */
const PAGE = 500;

/** `sha256` of a part, hex, so a download can be checked before it is joined. */
export interface BackupPart {
  index: number;
  storageKey: string;
  size: number;
  sha256: string;
}

/**
 * How big a part may be. Env-tunable because it is a product decision that
 * depends on the customers' connections, not on anything in the code: 256 MiB
 * is small enough to survive a flaky download and large enough that a typical
 * site is one file.
 */
export function partBytesFromEnv(): number {
  const mb = Number(process.env.SITE_BACKUP_PART_MB ?? 256);
  return Math.max(16, Number.isFinite(mb) ? Math.floor(mb) : 256) * 1024 * 1024;
}

function s3(): { client: S3Client; bucket: string } {
  return {
    bucket: process.env.S3_BUCKET!,
    client: new S3Client({
      endpoint: process.env.S3_ENDPOINT,
      region: process.env.S3_REGION ?? "us-east-1",
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY!,
        secretAccessKey: process.env.S3_SECRET_KEY!,
      },
      forcePathStyle: true,
    }),
  };
}

/** Prisma rows carry Dates and BigInts; JSON has neither. */
function jsonify(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, v: unknown) => (typeof v === "bigint" ? v.toString() : v)),
  );
}

/**
 * A JSON array written a page at a time.
 *
 * `[` then each row as it is fetched, `]` at the end — parseable by any JSON
 * reader, and never all in memory at once. `fetch(cursor)` returns the next page
 * of rows and the cursor to ask with next time, or null when there are no more.
 */
function jsonArray<T>(
  fetch: (cursor: string | null) => Promise<{ rows: T[]; next: string | null }>,
): { stream: Readable; count: () => number } {
  let count = 0;
  async function* generate(): AsyncGenerator<string> {
    yield "[";
    let cursor: string | null = null;
    let first = true;
    do {
      const page: { rows: T[]; next: string | null } = await fetch(cursor);
      for (const row of page.rows) {
        yield (first ? "\n" : ",\n") + JSON.stringify(jsonify(row));
        first = false;
        count++;
      }
      cursor = page.next;
    } while (cursor);
    yield "\n]\n";
  }
  return { stream: Readable.from(generate()), count: () => count };
}

/**
 * A Writable that cuts what it is given into files of `partBytes` and hands each
 * finished file to `flush` before starting the next.
 *
 * The temp file is the whole reason this is not a Buffer: a part is hundreds of
 * megabytes, and holding even one in the heap while sharp is resizing images in
 * the next job over is how the worker gets OOM-killed. Disk is plentiful; the
 * file is unlinked as soon as its upload returns.
 */
class PartWriter extends Writable {
  private index = 0;
  private written = 0;
  private hash = createHash("sha256");
  private file: fs.WriteStream | null = null;
  private filePath = "";
  total = 0;
  readonly parts: BackupPart[] = [];

  constructor(
    private readonly partBytes: number,
    private readonly dir: string,
    private readonly flush: (
      filePath: string,
      part: { index: number; size: number; sha256: string },
    ) => Promise<BackupPart>,
  ) {
    super();
  }

  private open(): fs.WriteStream {
    if (!this.file) {
      this.index++;
      this.written = 0;
      this.hash = createHash("sha256");
      this.filePath = path.join(this.dir, `part-${String(this.index).padStart(3, "0")}`);
      this.file = fs.createWriteStream(this.filePath);
    }
    return this.file;
  }

  private async close(): Promise<void> {
    const file = this.file;
    if (!file) return;
    this.file = null;
    await new Promise<void>((resolve, reject) => {
      file.on("error", reject);
      file.end(resolve);
    });
    const part = await this.flush(this.filePath, {
      index: this.index,
      size: this.written,
      sha256: this.hash.digest("hex"),
    });
    this.parts.push(part);
    await fs.promises.unlink(this.filePath).catch(() => undefined);
  }

  override _write(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    (async () => {
      let offset = 0;
      while (offset < chunk.length) {
        const file = this.open();
        const room = this.partBytes - this.written;
        const slice = chunk.subarray(offset, offset + Math.min(room, chunk.length - offset));
        if (!file.write(slice)) await new Promise<void>((r) => file.once("drain", r));
        this.hash.update(slice);
        this.written += slice.length;
        this.total += slice.length;
        offset += slice.length;
        if (this.written >= this.partBytes) await this.close();
      }
    })().then(() => cb(), cb);
  }

  override _final(cb: (err?: Error | null) => void): void {
    // An archive of zero bytes cannot happen (the manifest alone is one), so a
    // still-open file here is the last, short part.
    this.close().then(() => cb(), cb);
  }
}

/** A base file name for the archive: the slug and a minute-resolution stamp. */
export function backupFilename(slug: string, at: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${at.getUTCFullYear()}${p(at.getUTCMonth() + 1)}${p(at.getUTCDate())}-${p(at.getUTCHours())}${p(at.getUTCMinutes())}`;
  return `${slug}-${stamp}.zip`;
}

export async function runSiteBackup(
  data: JobPayloads["site.backup"],
): Promise<{ parts: number; bytes: number }> {
  const db = getSystemDb();
  const backup = await db.siteBackup.findFirst({
    where: { id: data.backupId, siteId: data.siteId, tenantId: data.tenantId },
  });
  // cms-api enqueues inside the request transaction that creates the row, so a
  // fast worker can arrive before the commit. Throwing makes BullMQ retry with
  // backoff; a row that is still missing on the last attempt was deleted (or
  // its site was), and the failure is the right record of that.
  if (!backup) throw new Error(`Backup ${data.backupId} not found (not committed yet, or deleted).`);
  if (backup.status === "READY") return { parts: 0, bytes: 0 };

  await db.siteBackup.update({
    where: { id: backup.id },
    data: { status: "RUNNING", startedAt: new Date(), error: null },
  });

  const { client, bucket } = s3();
  const prefix = `backups/${data.siteId}/${backup.id}/`;
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "zcms-backup-"));

  try {
    const site = await db.site.findFirst({
      where: { id: data.siteId, tenantId: data.tenantId },
      include: { domains: true },
    });
    if (!site) throw new Error("Site no longer exists.");

    const where = { tenantId: data.tenantId, siteId: data.siteId };
    const counts: Record<string, number> = {};
    let mediaBytes = 0;

    /** Multi-part archives are numbered `name.zip.001`; a single part is plain `name.zip`. */
    const uploader = async (
      filePath: string,
      part: { index: number; size: number; sha256: string },
    ): Promise<BackupPart> => {
      const storageKey = `${prefix}${backup.filename}.${String(part.index).padStart(3, "0")}`;
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: storageKey,
          Body: fs.createReadStream(filePath),
          ContentLength: part.size,
          ContentType: "application/octet-stream",
        }),
      );
      return { ...part, storageKey };
    };

    const writer = new PartWriter(backup.partBytes, dir, uploader);
    const archive = archiver("zip", { zlib: { level: 6 } });
    // Surfaces a failure inside the archive (an unreadable media stream, say)
    // as a rejection of the pipeline below, instead of a hung job.
    const done = pipeline(archive, writer);

    // A paged reader for one table: ordered by id so the cursor is stable while
    // the site is being edited underneath us.
    const paged =
      <T extends { id: string }>(
        find: (args: { cursor?: { id: string }; skip?: number; take: number }) => Promise<T[]>,
      ) =>
      async (cursor: string | null) => {
        const rows = await find({
          take: PAGE,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        });
        return { rows, next: rows.length === PAGE ? rows[rows.length - 1]!.id : null };
      };

    const section = async (name: string, fetch: ReturnType<typeof paged>) => {
      const { stream, count } = jsonArray(fetch);
      archive.append(stream, { name: `${name}.json` });
      // archiver reads appended streams in order, so the count is final only once
      // this entry has been consumed. Awaiting the entry keeps the counts honest
      // and, more usefully, keeps one page in flight instead of every table's.
      await new Promise<void>((resolve, reject) => {
        stream.once("end", resolve);
        stream.once("error", reject);
      });
      counts[name] = count();
    };

    // The site itself — everything a re-import would need to recreate the row.
    archive.append(
      JSON.stringify(
        jsonify({
          ...site,
          // The mail password is server-encrypted; the ciphertext is useless
          // anywhere else and a secret nowhere, so it is not in the archive.
        }),
        null,
        2,
      ),
      { name: "site.json" },
    );

    await section("content-types", paged((a) => db.contentType.findMany({ where, orderBy: { id: "asc" }, ...a })));
    await section("contents", paged((a) => db.content.findMany({ where, orderBy: { id: "asc" }, ...a })));
    await section(
      "content-versions",
      paged((a) => db.contentVersion.findMany({ where: { tenantId: data.tenantId, content: { siteId: data.siteId } }, orderBy: { id: "asc" }, ...a })),
    );
    await section("taxonomies", paged((a) => db.taxonomy.findMany({ where, orderBy: { id: "asc" }, ...a })));
    await section("terms", paged((a) => db.term.findMany({ where, orderBy: { id: "asc" }, ...a })));
    // ContentTerm has a composite key and no id; small enough to take whole.
    {
      const rows = await db.contentTerm.findMany({
        where: { tenantId: data.tenantId, content: { siteId: data.siteId } },
      });
      archive.append(JSON.stringify(jsonify(rows), null, 2), { name: "content-terms.json" });
      counts["content-terms"] = rows.length;
    }
    await section(
      "menus",
      paged((a) => db.menu.findMany({ where, include: { items: { orderBy: { order: "asc" } } }, orderBy: { id: "asc" }, ...a })),
    );
    await section("media-folders", paged((a) => db.mediaFolder.findMany({ where, orderBy: { id: "asc" }, ...a })));
    await section(
      "themes",
      paged((a) =>
        db.siteTheme.findMany({
          where,
          include: { theme: { select: { key: true, name: true } }, version: { select: { version: true } } },
          orderBy: { id: "asc" },
          ...a,
        }),
      ),
    );
    await section(
      "plugins",
      paged((a) =>
        db.sitePlugin.findMany({
          where,
          include: { plugin: { select: { key: true, name: true } }, version: { select: { version: true } } },
          orderBy: { id: "asc" },
          ...a,
        }),
      ),
    );
    await section("plugin-data", paged((a) => db.pluginData.findMany({ where, include: { plugin: { select: { key: true } } }, orderBy: { id: "asc" }, ...a })));
    await section(
      "members",
      paged((a) =>
        db.membership.findMany({
          where,
          include: { user: { select: { email: true, name: true } } },
          orderBy: { id: "asc" },
          ...a,
        }),
      ),
    );
    {
      const mail = await db.siteMailSettings.findFirst({ where });
      if (mail) {
        const { passwordEncrypted: _omit, ...rest } = mail;
        archive.append(JSON.stringify(jsonify(rest), null, 2), { name: "mail-settings.json" });
        counts["mail-settings"] = 1;
      }
      const commerce = await db.commerceSettings.findFirst({ where });
      if (commerce) {
        archive.append(JSON.stringify(jsonify(commerce), null, 2), { name: "commerce-settings.json" });
        counts["commerce-settings"] = 1;
      }
    }
    await section(
      "orders",
      paged((a) => db.order.findMany({ where, include: { items: true }, orderBy: { id: "asc" }, ...a })),
    );
    await section("audit-log", paged((a) => db.auditLog.findMany({ where, orderBy: { id: "asc" }, ...a })));

    // Media: the rows as JSON, then every ORIGINAL object under media/<storageKey>.
    // Derivatives are not archived — they are a function of the original and
    // the worker regenerates them on import — so the archive is roughly the
    // size of what was uploaded, not several times it.
    const media = jsonArray(
      paged((a) => db.media.findMany({ where, orderBy: { id: "asc" }, ...a })),
    );
    archive.append(media.stream, { name: "media.json" });
    await new Promise<void>((resolve, reject) => {
      media.stream.once("end", resolve);
      media.stream.once("error", reject);
    });
    counts.media = media.count();

    const objects = await db.media.findMany({
      where,
      select: { storageKey: true, size: true },
      orderBy: { id: "asc" },
    });
    let missing = 0;
    for (const object of objects) {
      let body: Readable;
      try {
        const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: object.storageKey }));
        body = res.Body as Readable;
      } catch (err) {
        // A row whose object is gone (a sweep raced an upload, a bucket restore
        // lost it) must not sink the whole backup. It is listed in the manifest.
        if ((err as { name?: string }).name === "NoSuchKey") {
          missing++;
          continue;
        }
        throw err;
      }
      // Already compressed formats gain nothing from deflate and cost CPU.
      const store = /\.(jpe?g|png|gif|webp|avif|mp4|webm|mp3|m4a|zip|gz|pdf)$/i.test(object.storageKey);
      const through = new PassThrough();
      archive.append(through, { name: `media/${object.storageKey}`, store });
      await pipeline(body, through);
      mediaBytes += object.size;
    }
    counts["media-missing"] = missing;

    const manifest = {
      format: BACKUP_FORMAT,
      createdAt: new Date().toISOString(),
      site: { id: site.id, slug: site.slug, name: site.name, tenantId: site.tenantId },
      counts,
      mediaBytes,
      note:
        "Row exports are JSON arrays named after their table. Media originals sit under " +
        "media/<storageKey>; derivatives were not archived. The SMTP password was not exported.",
    };
    archive.append(JSON.stringify(manifest, null, 2), { name: "manifest.json" });

    await archive.finalize();
    await done;

    // One part gets the plain name — nothing to join.
    if (writer.parts.length === 1) {
      const only = writer.parts[0]!;
      const plain = `${prefix}${backup.filename}`;
      await client.send(
        new CopyObjectCommand({
          Bucket: bucket,
          CopySource: `${bucket}/${only.storageKey}`,
          Key: plain,
        }),
      );
      await client.send(
        new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: [{ Key: only.storageKey }] } }),
      );
      only.storageKey = plain;
    }

    await db.siteBackup.update({
      where: { id: backup.id },
      data: {
        status: "READY",
        finishedAt: new Date(),
        totalBytes: BigInt(writer.total),
        parts: writer.parts as never,
        summary: { counts, mediaBytes } as never,
      },
    });

    return { parts: writer.parts.length, bytes: writer.total };
  } catch (err) {
    await db.siteBackup
      .update({
        where: { id: backup.id },
        data: {
          status: "FAILED",
          finishedAt: new Date(),
          error: (err as Error).message.slice(0, 2000),
        },
      })
      .catch(() => undefined);
    // Half-written parts are not a backup. Clear them so the row and the bucket agree.
    await deletePrefix(client, bucket, prefix).catch(() => undefined);
    throw err;
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Deletes every object under a prefix, 1000 at a time. Returns how many went. */
export async function deletePrefix(client: S3Client, bucket: string, prefix: string): Promise<number> {
  let deleted = 0;
  let token: string | undefined;
  do {
    const page = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }),
    );
    const keys = (page.Contents ?? []).map((o) => o.Key).filter((k): k is string => !!k);
    if (keys.length) {
      await client.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: keys.map((Key) => ({ Key })) },
        }),
      );
      deleted += keys.length;
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return deleted;
}

/**
 * Removes a deleted site's objects: its media and sitemap under `sites/<id>/`,
 * and any backups it had under `backups/<id>/`.
 *
 * The rows are already gone — cms-api deleted them in the request that enqueued
 * this — so there is nothing to check and nothing to leave behind. Idempotent:
 * a retry after a partial run simply finds fewer objects.
 */
export async function runSitePurge(
  data: JobPayloads["site.purge"],
): Promise<{ deleted: number }> {
  // The job is enqueued from inside the request that deletes the rows, so it can
  // exist for a delete whose transaction then rolled back. A site that is still
  // here is a site whose files must stay.
  const alive = await getSystemDb().site.findFirst({
    where: { id: data.siteId, tenantId: data.tenantId },
    select: { id: true },
  });
  if (alive) return { deleted: 0 };

  const { client, bucket } = s3();
  const media = await deletePrefix(client, bucket, `sites/${data.siteId}/`);
  const backups = await deletePrefix(client, bucket, `backups/${data.siteId}/`);
  return { deleted: media + backups };
}

/**
 * Deletes expired backups: the objects first, then the row, so a failure
 * between the two leaves a row that will be tried again tomorrow rather than
 * orphaned objects nothing points at.
 */
export async function runBackupsExpire(): Promise<{ expired: number }> {
  const db = getSystemDb();
  const { client, bucket } = s3();
  const rows = await db.siteBackup.findMany({
    where: { expiresAt: { lt: new Date() } },
    select: { id: true, siteId: true },
    take: 200,
  });
  for (const row of rows) {
    await deletePrefix(client, bucket, `backups/${row.siteId}/${row.id}/`);
    await db.siteBackup.delete({ where: { id: row.id } }).catch(() => undefined);
  }
  return { expired: rows.length };
}
