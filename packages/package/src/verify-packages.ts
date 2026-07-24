import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createGzip } from "node:zlib";
import { pack as tarPack } from "tar-stream";
import { pipeline } from "node:stream/promises";

import { unpackTo } from "./archive";
import { buildPackage, openPackage, wrap } from "./build";
import { generateKeyPair, sha256, signChecksum, verifyPackage } from "./signing";
import { PackageError } from "./types";

/**
 * Attacks the packaging pipeline.
 *
 * A package is a file uploaded by a stranger and then written to the disk of a
 * machine that later executes part of it. Every check below corresponds to a way
 * that has gone wrong in real software: tar-slip in half the CVE database,
 * unsigned-but-checksummed packages, "verify with the key the package gave us".
 */

let failures = 0;

function check(name: string, passed: boolean, detail: string) {
  console.log(`  ${passed ? "PASS" : "FAIL"}  ${name}\n        ${detail}`);
  if (!passed) failures++;
}

/** Builds a hostile tar.gz by hand — a real packer would never emit these. */
async function hostileTar(
  entries: { name: string; body?: string; type?: "file" | "symlink" | "directory"; linkname?: string }[],
): Promise<Buffer> {
  const t = tarPack();
  const chunks: Buffer[] = [];
  const gz = createGzip();
  gz.on("data", (c: Buffer) => chunks.push(c));
  const done = pipeline(t, gz);

  for (const e of entries) {
    const body = e.body ?? "";
    t.entry(
      {
        name: e.name,
        size: e.type === "symlink" ? 0 : body.length,
        type: e.type ?? "file",
        linkname: e.linkname,
        mode: 0o644,
      },
      e.type === "symlink" ? "" : body,
    );
  }
  t.finalize();
  await done;
  return Buffer.concat(chunks);
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "zcms-verify-"));
  const dest = path.join(tmp, "dest");
  const outside = path.join(tmp, "OUTSIDE_THE_DEST");

  console.log("\nPackage pipeline verification — attacking the installer\n");

  // 1. tar-slip: the entry that walks out of the destination directory.
  try {
    const evil = await hostileTar([
      { name: "../../OUTSIDE_THE_DEST/pwned.txt", body: "owned" },
    ]);
    await unpackTo(evil, dest);
    check(
      "path traversal (../../) is refused",
      false,
      `EXTRACTED — wrote outside dest: ${fs.existsSync(path.join(tmp, "OUTSIDE_THE_DEST")) ? "file landed outside" : "silently rewritten"}`,
    );
  } catch (err) {
    check(
      "path traversal (../../) is refused",
      err instanceof PackageError && !fs.existsSync(outside),
      `rejected: ${(err as Error).message.slice(0, 70)}`,
    );
  }

  // 2. Absolute path — the blunter version of the same attack.
  try {
    const evil = await hostileTar([{ name: "/tmp/zcms-pwned.txt", body: "owned" }]);
    await unpackTo(evil, dest);
    check("absolute path is refused", false, "EXTRACTED");
  } catch (err) {
    check(
      "absolute path is refused",
      err instanceof PackageError,
      `rejected: ${(err as Error).message.slice(0, 70)}`,
    );
  }

  // 3. Symlink — would be read back later as if it were theme content.
  try {
    const evil = await hostileTar([
      { name: "sneaky", type: "symlink", linkname: "/etc/passwd" },
    ]);
    await unpackTo(evil, dest);
    check("symlink entry is refused", false, "EXTRACTED a symlink");
  } catch (err) {
    check(
      "symlink entry is refused",
      err instanceof PackageError,
      `rejected: ${(err as Error).message.slice(0, 70)}`,
    );
  }

  // 3b. Decompression bomb. A few hundred KB of gzip that expands to hundreds of
  //     megabytes — the archive equivalent of a zip bomb. The cap must be on the
  //     UNPACKED size, because the compressed size tells you nothing.
  try {
    // 8 entries × 8MB of zeroes = 64MB unpacked, well past the 50MB ceiling, but
    // it compresses to almost nothing.
    const bomb = await hostileTar(
      Array.from({ length: 8 }, (_, i) => ({
        name: `bomb-${i}.bin`,
        body: "0".repeat(8 * 1024 * 1024),
      })),
    );
    await unpackTo(bomb, dest);
    check(
      "decompression bomb is refused",
      false,
      `EXTRACTED — ${(bomb.length / 1024).toFixed(0)}KB compressed expanded past the cap`,
    );
  } catch (err) {
    check(
      "decompression bomb is refused",
      err instanceof PackageError,
      `rejected: ${(err as Error).message.slice(0, 70)}`,
    );
  }

  // --- Signing --------------------------------------------------------------

  const publisher = generateKeyPair();
  const marketplace = generateKeyPair();
  const attacker = generateKeyPair();

  // A minimal, valid theme package.
  const src = path.join(tmp, "src-theme");
  fs.mkdirSync(path.join(src, "dist"), { recursive: true });
  fs.writeFileSync(
    path.join(src, "theme.json"),
    JSON.stringify({
      id: "vn.test.theme",
      name: "Test",
      version: "1.0.0",
      author: { name: "T" },
      engine: ">=0.1.0",
      entry: "dist/index.js",
    }),
  );
  fs.writeFileSync(path.join(src, "dist", "index.js"), "module.exports = {};");

  const built = await buildPackage(src, "theme", publisher.privateKey, publisher.publicKey);

  // 4. A package the marketplace never signed must not run, however valid it looks.
  {
    const opened = await openPackage(built.file);
    let rejected = false;
    let note = "";
    try {
      verifyPackage(opened.envelope, opened.payload, marketplace.publicKey);
      note = "ACCEPTED an unsigned package";
    } catch (err) {
      rejected = true;
      note = `rejected: ${(err as Error).message.slice(0, 60)}`;
    }
    check("package without a marketplace signature is refused", rejected, note);
  }

  // The marketplace accepts it: counter-signs the checksum.
  const accepted = {
    ...built.envelope,
    marketplaceSignature: signChecksum(built.envelope.checksum, marketplace.privateKey),
  };
  const signedFile = await wrap(accepted, (await openPackage(built.file)).payload);

  // 5. The happy path — this must work, or the whole scheme is theatre.
  {
    const opened = await openPackage(signedFile);
    let ok = false;
    let note = "";
    try {
      verifyPackage(opened.envelope, opened.payload, marketplace.publicKey);
      ok = true;
      note = `checksum ${opened.envelope.checksum.slice(0, 16)}… verified`;
    } catch (err) {
      note = `REJECTED a valid package: ${(err as Error).message}`;
    }
    check("correctly signed package verifies", ok, note);
  }

  // 6. Tampered payload: swap the code, keep the signature. The digest changes,
  //    so the signature no longer matches — this is the whole point of signing
  //    the checksum rather than the metadata.
  {
    const opened = await openPackage(signedFile);
    const tampered = Buffer.concat([opened.payload, Buffer.from("// backdoor")]);
    let rejected = false;
    let note = "";
    try {
      verifyPackage(opened.envelope, tampered, marketplace.publicKey);
      note = "ACCEPTED a modified payload";
    } catch (err) {
      rejected = true;
      note = `rejected: ${(err as Error).message.split("\n")[0]}`;
    }
    check("payload modified after signing is refused", rejected, note);
  }

  // 7. An attacker signs their own package with their own key. Verification uses
  //    the PINNED marketplace key, so it fails — this is the case that breaks if
  //    anyone ever "verifies with the key that came with the package".
  {
    const opened = await openPackage(built.file);
    const forged = {
      ...opened.envelope,
      marketplaceSignature: signChecksum(opened.envelope.checksum, attacker.privateKey),
    };
    let rejected = false;
    let note = "";
    try {
      verifyPackage(forged, opened.payload, marketplace.publicKey);
      note = "ACCEPTED a package signed by an attacker's key";
    } catch (err) {
      rejected = true;
      note = `rejected: ${(err as Error).message.slice(0, 60)}`;
    }
    check("signature from a foreign key is refused", rejected, note);
  }

  // 8. Reproducibility: the same source must produce the same checksum, or no one
  //    can independently verify that a published package matches its source.
  {
    const again = await buildPackage(src, "theme", publisher.privateKey, publisher.publicKey);
    check(
      "packing is reproducible (same source -> same checksum)",
      again.envelope.checksum === built.envelope.checksum,
      again.envelope.checksum === built.envelope.checksum
        ? `stable: ${built.envelope.checksum.slice(0, 24)}…`
        : `checksum drifted: ${built.envelope.checksum.slice(0, 12)} vs ${again.envelope.checksum.slice(0, 12)}`,
    );
  }

  fs.rmSync(tmp, { recursive: true, force: true });

  console.log(
    failures === 0
      ? "\nAll package checks passed — only signed, unmodified packages install.\n"
      : `\n${failures} PACKAGE CHECK(S) FAILED — the distribution pipeline is not safe.\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

void main();
