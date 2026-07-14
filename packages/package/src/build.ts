import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { packDirectory, unpackTo } from "./archive";
import { assertManifestIdentity } from "./manifest-rules";
import { validateMedia } from "./media";
import { sha256, signChecksum } from "./signing";
import {
  PackageError,
  type PackageEnvelope,
  type PackageKind,
  type PackageManifest,
  type SignedPackage,
} from "./types";

const ENVELOPE_FILE = "zcms-package.json";
const PAYLOAD_FILE = "payload.tgz";

/** Reads and sanity-checks the manifest a package directory must carry. */
export function readManifest(dir: string, kind: PackageKind): PackageManifest {
  const file = kind === "theme" ? "theme.json" : "plugin.json";
  const full = path.join(dir, file);

  if (!fs.existsSync(full)) {
    throw new PackageError(`Missing ${file} in "${dir}".`);
  }

  const raw = JSON.parse(fs.readFileSync(full, "utf8")) as Record<string, unknown>;

  for (const field of ["id", "name", "version", "author", "engine"]) {
    if (!raw[field]) throw new PackageError(`${file} is missing the required field "${field}".`);
  }

  // Present is not the same as usable. Until this ran, a `name` could be a
  // megabyte of newlines and every check here would have said yes to it.
  // The marketplace re-runs this on upload — a package did not necessarily come
  // out of our packer, and an author who wants a hostile name would not use it.
  assertManifestIdentity(raw, file);

  const entry = String(raw.entry ?? "dist/index.js");
  if (!fs.existsSync(path.join(dir, entry))) {
    throw new PackageError(
      `Entry "${entry}" does not exist. Build the package before packing it.`,
    );
  }

  const manifest = { ...(raw as object), kind, entry } as PackageManifest;

  // Screenshots are checked here, at pack time, so the author hears "that image is
  // 4MB" from their own terminal rather than from a reviewer a day later. The
  // marketplace checks them again on publish — it does not assume the package it
  // was handed came out of this packer.
  validateMedia(dir, manifest);

  return manifest;
}

/**
 * Builds a signed package from a source directory.
 *
 * The result is one file: a tar containing the envelope (manifest + checksum +
 * publisher signature) and the payload (the tar.gz of the actual files). One
 * file means one thing to upload, one thing to store, and one thing to verify.
 *
 * `opts.operatorPrivateKey`, when given, adds an `operatorSignature` over the same
 * checksum — the sideload route (`verifyOperator`). This is how `zcms pack
 * --operator-key` and cms-api's server-sign path stamp a package for an instance
 * whose operator vouches for it. The operator is also the publisher of their own
 * sideload, so pass their key as `publisherPrivateKey`/`publisherPublicKey` too; the
 * runtime never checks the publisher signature on the operator track, but the
 * envelope format requires the fields and the manifest identity still travels.
 */
export async function buildPackage(
  dir: string,
  kind: PackageKind,
  publisherPrivateKey: string,
  publisherPublicKey: string,
  opts: { operatorPrivateKey?: string } = {},
): Promise<{ file: Buffer; envelope: PackageEnvelope }> {
  const manifest = readManifest(dir, kind);
  const payload = await packDirectory(dir);
  const checksum = sha256(payload);

  const envelope: PackageEnvelope = {
    checksum,
    manifest,
    publisherSignature: signChecksum(checksum, publisherPrivateKey),
    // Trimmed: a PEM read from disk ends in a newline, the same PEM stored in a
    // database usually does not, and comparing the two byte-for-byte then fails
    // on whitespace — reported to the publisher as "unknown key", which sends
    // them looking for a problem that does not exist.
    publisherKey: publisherPublicKey.trim(),
  };

  if (opts.operatorPrivateKey) {
    envelope.operatorSignature = signChecksum(checksum, opts.operatorPrivateKey);
  }

  return { file: await wrap(envelope, payload), envelope };
}

/** Wraps envelope + payload into the single .zcms file. */
export async function wrap(
  envelope: PackageEnvelope,
  payload: Buffer,
): Promise<Buffer> {
  const staging = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "zcms-pkg-"));
  try {
    fs.writeFileSync(
      path.join(staging, ENVELOPE_FILE),
      JSON.stringify(envelope, null, 2),
    );
    fs.writeFileSync(path.join(staging, PAYLOAD_FILE), payload);
    return await packDirectory(staging);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

/** Opens a .zcms file WITHOUT trusting it: nothing is executed, nothing is run. */
export async function openPackage(file: Buffer): Promise<SignedPackage> {
  const staging = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "zcms-open-"));
  try {
    await unpackTo(file, staging);

    const envelopePath = path.join(staging, ENVELOPE_FILE);
    const payloadPath = path.join(staging, PAYLOAD_FILE);

    if (!fs.existsSync(envelopePath) || !fs.existsSync(payloadPath)) {
      throw new PackageError("File is not a valid Z-CMS package.");
    }

    const envelope = JSON.parse(
      fs.readFileSync(envelopePath, "utf8"),
    ) as PackageEnvelope;

    return { envelope, payload: fs.readFileSync(payloadPath) };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

/** Extracts a VERIFIED payload to disk. Verify first; this function does not. */
/**
 * Unpacks a payload into `dest`, ATOMICALLY.
 *
 * The obvious implementation — `rm -rf dest` then unpack into it — has a window
 * in which `dest` exists and is empty or half-written. Two concurrent loads of
 * the same theme hit it immediately: site-runtime resolves the theme in
 * `generateMetadata` and again in the page component, so the second call's
 * `rmSync` deletes the directory the first call has just finished populating and
 * is about to read. The symptom is an intermittent "entry is not in the package"
 * on a cold cache, and it is invisible once the cache is warm — which is exactly
 * the kind of bug that only ever appears in production.
 *
 * So: unpack into a private temporary directory and `rename` it into place.
 * Rename is atomic on POSIX, so a reader sees either the old directory or the
 * complete new one, never a partial one.
 */
export async function installPayload(
  payload: Buffer,
  dest: string,
): Promise<string[]> {
  const staging = `${dest}.tmp-${randomUUID().slice(0, 8)}`;

  try {
    const written = await unpackTo(payload, staging);

    // rename() refuses a non-empty destination, so the old copy goes first. The
    // gap between the two is small and, unlike the naive version, does not span
    // the whole (slow) unpack.
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(staging, dest);

    return written;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}
