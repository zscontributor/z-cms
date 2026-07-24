import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSystemDb } from "@zcmsorg/database";
import type { JobPayloads } from "@zcmsorg/queue";
import sharp from "sharp";

/**
 * Generates derivative images for an uploaded media object.
 *
 * This is why the worker exists and cms-api does not do it inline: resizing a
 * 20MB photo into three sizes is hundreds of milliseconds of CPU that has no
 * business blocking the HTTP response to an upload. The upload returns
 * immediately with the original; the thumbnails appear a moment later.
 *
 * The worker is first-party infrastructure, so unlike plugin-runtime it DOES
 * hold S3 and database credentials — it has to read the original and write the
 * derivatives. That is the line: our own workers are trusted, third-party plugin
 * code never is.
 */

const VARIANTS = [
  { name: "thumb", width: 200, height: 200, fit: "cover" as const },
  { name: "medium", width: 800, fit: "inside" as const },
  { name: "large", width: 1600, fit: "inside" as const },
];

// Only raster formats sharp can process. A PDF or an already-tiny image is left
// with just its original; there is nothing sensible to downscale.
const RASTER = new Set(["image/jpeg", "image/png", "image/webp", "image/avif"]);

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

export async function runMediaVariants(
  data: JobPayloads["media.variants"],
): Promise<{ variants: Record<string, string>; skipped?: string }> {
  if (!RASTER.has(data.mimeType)) {
    return { variants: {}, skipped: `unsupported type ${data.mimeType}` };
  }

  const { client, bucket } = s3();

  const original = await client.send(
    new GetObjectCommand({ Bucket: bucket, Key: data.storageKey }),
  );
  const input = Buffer.from(await original.Body!.transformToByteArray());

  const variants: Record<string, string> = {};
  const dot = data.storageKey.lastIndexOf(".");
  const base = dot >= 0 ? data.storageKey.slice(0, dot) : data.storageKey;

  for (const v of VARIANTS) {
    // Everything becomes WebP: one modern format, meaningfully smaller, and it
    // sidesteps re-encoding a format-specific quirk per variant.
    const key = `${base}.${v.name}.webp`;

    const out = await sharp(input)
      .rotate() // honour EXIF orientation before resizing
      .resize({
        width: v.width,
        height: v.height,
        fit: v.fit,
        withoutEnlargement: true,
      })
      .webp({ quality: 82 })
      .toBuffer();

    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: out,
        ContentType: "image/webp",
        CacheControl: "public, max-age=31536000, immutable",
      }),
    );

    variants[v.name] = key;
  }

  // Record the derivatives and the original's real dimensions. The system client
  // is correct here: the job carries a verified tenant/site, and it runs outside
  // any request transaction.
  const meta = await sharp(input).metadata();
  await getSystemDb().media.updateMany({
    where: { id: data.mediaId, tenantId: data.tenantId, siteId: data.siteId },
    data: {
      variants: variants as never,
      width: meta.width ?? null,
      height: meta.height ?? null,
    },
  });

  return { variants };
}
