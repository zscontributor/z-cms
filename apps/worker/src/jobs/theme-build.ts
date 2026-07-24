import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSystemDb } from "@zcmsorg/database";
import { buildPackage, packDirectory, sha256 } from "@zcmsorg/package";
import type { JobPayloads } from "@zcmsorg/queue";
import { generateAndBuild } from "@zcmsorg/theme-codegen";

/**
 * Turns a drawing from the Theme Editor into a built, signed, installed theme.
 *
 * The division of labour is the point:
 *
 *   the worker   generates the code, runs esbuild, signs the package. Slow, CPU-
 *                bound work that has no business inside an HTTP request.
 *   cms-api      decides whether the result may be installed — verifies it against
 *                the pinned operator key, refuses an id that impersonates a
 *                built-in or a marketplace theme, scans it, stores it, and
 *                registers it QUARANTINED.
 *
 * The worker does NOT write the ThemeVersion row, even though it holds the
 * credentials to. Registration policy lives in one place (SideloadService), and a
 * second copy of it here would be a second door — the two would drift, and the one
 * that forgot a check is the one that gets used. So the built bytes go back through
 * the very same gate a hand-uploaded .zcms goes through.
 */

interface DraftRow {
  id: string;
  key: string;
  name: string;
  version: string;
  description: string | null;
  document: unknown;
  author: { name: string } | null;
}

function operatorPrivateKey(): string {
  const key = process.env.OPERATOR_PRIVATE_KEY?.replace(/\\n/g, "\n");
  if (!key) {
    // The offline-sign posture: the operator deliberately kept the private key off
    // the server, so nothing here can sign. A configuration, not a bug — but a
    // drawn theme cannot be built without it, so name the switch that is off.
    throw new Error(
      "Building a design needs OPERATOR_PRIVATE_KEY on this instance. It is configured for offline signing, where packages are signed with `zcms pack --operator-key` instead.",
    );
  }
  return key;
}

function operatorPublicKey(): string {
  const key = process.env.OPERATOR_PUBLIC_KEY?.replace(/\\n/g, "\n");
  if (!key) throw new Error("OPERATOR_PUBLIC_KEY is not set; nothing could verify the build.");
  return key;
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

/**
 * Stages the unsigned payload and records the digest the AUTHOR will sign.
 *
 * Signing happens in the author's browser, in a request that comes later — so the
 * exact bytes have to survive until then. Rebuilding at seal time would not do: a
 * tar carries mtimes, so the same design packed twice hashes to two different
 * digests, and the signature would be over a payload that no longer exists.
 */
async function stagePayload(
  dir: string,
  draftId: string,
): Promise<{ checksum: string; ref: string }> {
  const payload = await packDirectory(dir);
  const checksum = sha256(payload);
  const ref = `staging/theme-payload/${draftId}.tgz`;

  const { client, bucket } = s3();
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: ref,
      Body: payload,
      ContentType: "application/octet-stream",
    }),
  );
  return { checksum, ref };
}

/** Hands the built package to cms-api's sideload gate. Mirrors mail-send's callback. */
async function install(
  file: Buffer,
  by: { tenantId: string; actorId: string },
): Promise<{ key: string; version: string; reviewStatus: string }> {
  const apiUrl = (process.env.CMS_API_URL ?? "http://localhost:4100").replace(/\/+$/, "");

  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(file)]), "theme.zcms");
  form.append("tenantId", by.tenantId);
  form.append("actorId", by.actorId);
  form.append("kind", "theme");

  const res = await fetch(`${apiUrl}/api/v1/sideload/internal/built`, {
    method: "POST",
    headers: { "x-internal-token": process.env.CMS_INTERNAL_TOKEN ?? "" },
    body: form,
    // The far side scans the package, which unpacks it — generous, but bounded.
    signal: AbortSignal.timeout(60_000),
  });

  const text = await res.text();
  if (!res.ok) {
    // The API's message is the useful one ("id impersonates a built-in", "scan
    // rejected"), and it is what the author needs to read on their draft.
    throw new Error(`cms-api refused the built theme (${res.status}): ${text.slice(0, 500)}`);
  }
  return JSON.parse(text);
}

export async function runThemeBuild(data: JobPayloads["theme.build"]): Promise<unknown> {
  const db = getSystemDb();
  const draft = (await db.themeDraft.findFirst({
    where: { id: data.draftId, tenantId: data.tenantId },
    include: { author: { select: { name: true } } },
  })) as DraftRow | null;

  if (!draft) throw new Error(`Theme draft ${data.draftId} is gone.`);

  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "zcms-theme-build-"));
  try {
    await generateAndBuild({
      dir,
      // The document comes from the ROW, never from the job payload: a copy in
      // Redis would be stale the moment somebody saved again.
      document: draft.document,
      identity: {
        id: draft.key,
        name: draft.name,
        version: draft.version,
        ...(draft.description ? { description: draft.description } : {}),
        // The person who drew it. Not the tenant: a theme's author is a credit,
        // shown to whoever installs the package.
        authorName: draft.author?.name ?? "Unknown",
      },
    });

    // Staged FIRST, and unconditionally: this is what the author signs to publish,
    // and it must not depend on whether the instance can also install locally. An
    // operator who never turned on sideloading can still draw a theme and put it on
    // the marketplace.
    const staged = await stagePayload(dir, draft.id);

    // Operator key as both publisher and operator — a locally built theme speaks
    // only for itself. The same call packFromZip makes on the sideload path.
    const priv = operatorPrivateKey();
    const { file } = await buildPackage(dir, "theme", priv, operatorPublicKey(), {
      operatorPrivateKey: priv,
    });

    const result = await install(file, { tenantId: data.tenantId, actorId: data.actorId });

    await db.themeDraft.update({
      where: { id: draft.id },
      data: {
        status: "BUILT",
        buildError: null,
        lastBuiltAt: new Date(),
        payloadChecksum: staged.checksum,
        payloadRef: staged.ref,
      },
    });

    return { ...result, checksum: staged.checksum };
  } catch (error) {
    // The reason goes on the ROW, not only into the worker's log. Somebody pressed
    // Build and walked away; the answer has to be waiting for them in the editor,
    // not in a log they cannot read.
    await db.themeDraft
      .update({
        where: { id: draft.id },
        data: { status: "FAILED", buildError: (error as Error).message.slice(0, 2000) },
      })
      .catch(() => undefined);
    // Rethrown so BullMQ records the failure and the dead-letter queue shows it.
    // Without it the draft would say FAILED while the queue said all was well.
    throw error;
  } finally {
    // The temp tree holds the whole generated theme. Leaving it behind is a slow
    // disk leak, and it leaks exactly when builds are failing — which is when disk
    // headroom matters most.
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
