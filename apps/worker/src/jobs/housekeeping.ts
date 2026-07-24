import { DeleteObjectsCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { getSystemDb } from "@zcmsorg/database";

/**
 * Deletes refresh tokens that can no longer authenticate anything.
 *
 * The table only ever grew — a login adds a row, every rotation adds another,
 * nothing removed them. On the auth hot path that is a table with millions of
 * dead rows.
 *
 * The grace period is not cosmetic. A revoked family is evidence: it is what a
 * theft investigation reads. Deleting it the moment it is revoked destroys the
 * only record that the theft happened, so a revoked token lingers for a while
 * before it goes.
 */
const REVOKED_GRACE_DAYS = 30;

export async function runSessionsPrune(): Promise<{ deleted: number }> {
  const db = getSystemDb();
  const now = new Date();
  const graceCutoff = new Date(now.getTime() - REVOKED_GRACE_DAYS * 86_400_000);

  const { count } = await db.refreshToken.deleteMany({
    where: {
      OR: [
        // Expired: it cannot authenticate anything, whatever its state.
        { expiresAt: { lt: now } },
        // Revoked long enough ago that the audit value has passed.
        { revokedAt: { lt: graceCutoff } },
        // Consumed and superseded — the rotation moved on.
        { consumedAt: { lt: graceCutoff } },
      ],
    },
  });

  return { deleted: count };
}

/**
 * Deletes stored objects no media row points at.
 *
 * `media.remove` deletes the database row and leaves the object behind, on
 * purpose: content may still reference the URL, and a broken image on a live page
 * is worse than an orphaned blob. That trade is only honest if something
 * eventually collects them. This is that something.
 *
 * It is also the most dangerous job in the system — a bug here deletes a
 * customer's images — so it is deliberately timid:
 *
 *   - Only objects under `sites/` are considered. Packages, sitemaps and anything
 *     else the platform stores are out of scope entirely.
 *   - An object younger than MIN_AGE is never touched. An upload writes the object
 *     BEFORE the row exists; without this window the sweep would race the upload
 *     and delete a perfectly good image seconds after a customer uploaded it.
 *   - Both originals AND variants are matched, because a variant key
 *     (`<base>.thumb.webp`) is not any row's `storageKey` — it lives in the
 *     `variants` JSON. Matching only `storageKey` would delete every thumbnail in
 *     the system on the first run.
 */
const MIN_AGE_HOURS = 24;
const MAX_DELETIONS_PER_RUN = 1000;

export async function runMediaSweep(): Promise<{
  scanned: number;
  deleted: number;
  skippedTooYoung: number;
}> {
  const bucket = process.env.S3_BUCKET!;
  const s3 = new S3Client({
    endpoint: process.env.S3_ENDPOINT,
    region: process.env.S3_REGION ?? "us-east-1",
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY!,
      secretAccessKey: process.env.S3_SECRET_KEY!,
    },
    forcePathStyle: true,
  });

  // Every key any media row claims — originals and derivatives alike.
  const rows = await getSystemDb().media.findMany({
    select: { storageKey: true, variants: true },
  });

  const claimed = new Set<string>();
  for (const row of rows) {
    claimed.add(row.storageKey);
    for (const key of Object.values((row.variants ?? {}) as Record<string, unknown>)) {
      if (typeof key === "string") claimed.add(key);
    }
  }

  const cutoff = Date.now() - MIN_AGE_HOURS * 3_600_000;
  const orphans: string[] = [];
  let scanned = 0;
  let skippedTooYoung = 0;
  let token: string | undefined;

  do {
    const page = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: "sites/",
        ContinuationToken: token,
      }),
    );

    for (const object of page.Contents ?? []) {
      const key = object.Key;
      if (!key) continue;
      scanned++;

      if (claimed.has(key)) continue;

      // The upload writes the object before it writes the row. Without this
      // window the sweep races a live upload and deletes a good image.
      if ((object.LastModified?.getTime() ?? 0) > cutoff) {
        skippedTooYoung++;
        continue;
      }

      // A site's sitemap is written by us, not by an upload, and no media row
      // claims it.
      if (key.endsWith("/sitemap.xml")) continue;

      orphans.push(key);
      if (orphans.length >= MAX_DELETIONS_PER_RUN) break;
    }

    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token && orphans.length < MAX_DELETIONS_PER_RUN);

  // Chunked: DeleteObjects takes at most 1000 keys.
  for (let i = 0; i < orphans.length; i += 1000) {
    const chunk = orphans.slice(i, i + 1000);
    await s3.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: chunk.map((Key) => ({ Key })) },
      }),
    );
  }

  if (orphans.length) {
    console.warn(
      `[media.sweep] deleted ${orphans.length} orphaned object(s): ${orphans.slice(0, 3).join(", ")}${orphans.length > 3 ? "…" : ""}`,
    );
  }

  return { scanned, deleted: orphans.length, skippedTooYoung };
}
