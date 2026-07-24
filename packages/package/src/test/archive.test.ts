import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { pack, type Headers } from "tar-stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { packDirectory, unpackTo } from "../archive";
import { PackageError } from "../types";

/**
 * The archive is the only place where bytes from a stranger become files on our
 * disk. Every test below that builds a hostile tarball is an attack that reached
 * production once in some other CMS; the assertion is always the same — the
 * package is REFUSED, and nothing of it lands anywhere.
 */

const MAX_UNPACKED_BYTES = 50 * 1024 * 1024;
const MAX_ENTRIES = 2000;

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "zcms-archive-test-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Writes `content` to `rel` inside `dir`, creating parent directories. */
function write(dir: string, rel: string, content: string | Buffer): void {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

/** A directory that looks like a real, buildable theme. */
function themeDir(name = "theme"): string {
  const dir = path.join(tmp, name);
  write(dir, "theme.json", JSON.stringify({ id: "vn.zsoft.theme.x" }));
  write(dir, "dist/index.js", "export default {}\n");
  write(dir, "assets/logo.svg", "<svg/>");
  return dir;
}

/**
 * Builds a tar.gz from raw headers — the attacker's tool. tar-stream is used
 * directly (not mocked) so the bytes we hand to `unpackTo` are exactly the bytes
 * a hostile publisher could upload.
 */
async function hostileTarball(
  entries: Array<{ header: Headers; body?: Buffer | string }>,
): Promise<Buffer> {
  const tarball = pack();
  const chunks: Buffer[] = [];
  tarball.on("data", (c: Buffer) => chunks.push(c));
  const finished = new Promise<void>((resolve, reject) => {
    tarball.on("end", () => resolve());
    tarball.on("error", reject);
  });

  for (const { header, body } of entries) {
    await new Promise<void>((resolve, reject) => {
      tarball.entry(header, body ?? "", (err) => (err ? reject(err) : resolve()));
    });
  }
  tarball.finalize();
  await finished;

  return gzipSync(Buffer.concat(chunks));
}

describe("packDirectory", () => {
  it("produces byte-identical output when the same directory is packed twice", async () => {
    // The reproducible checksum is what lets anyone re-build a published package
    // from source and confirm the marketplace shipped what it claims. If packing
    // stops being deterministic, that audit silently becomes impossible.
    const dir = themeDir();

    const first = await packDirectory(dir);
    const second = await packDirectory(dir);

    expect(first.equals(second)).toBe(true);
  });

  it("produces the same bytes for two directories with identical contents", async () => {
    // Different paths, different mtimes on disk, same package: the archive must
    // depend on the content only, never on where or when it was built.
    const a = themeDir("a");
    const b = themeDir("b");

    expect((await packDirectory(a)).equals(await packDirectory(b))).toBe(true);
  });

  it("changes the archive when a single packed byte changes", async () => {
    const dir = themeDir();
    const before = await packDirectory(dir);

    write(dir, "dist/index.js", "export default { backdoor: true }\n");

    expect((await packDirectory(dir)).equals(before)).toBe(false);
  });

  it("leaves secrets, VCS data and dependencies out of the archive", async () => {
    // Shipping .env or .git into a public marketplace package is a credential
    // leak that no signature check would ever catch — it is a *valid* package.
    const dir = themeDir();
    write(dir, ".env", "DATABASE_URL=postgres://secret");
    write(dir, ".git/config", "[core]");
    write(dir, "node_modules/left-pad/index.js", "module.exports = 1");
    write(dir, ".DS_Store", "junk");
    write(dir, ".turbo/log", "junk");

    const unpacked = await unpackTo(await packDirectory(dir), path.join(tmp, "out"));

    expect(unpacked.sort()).toEqual(["assets/logo.svg", "dist/index.js", "theme.json"]);
  });

  it("leaves dev-only source and tooling out of the archive", async () => {
    // The runtime loads dist/, never src/. A build script that imports `fs` would
    // otherwise be signed and scanned as if it were shipped code.
    const dir = themeDir();
    write(dir, "src/index.ts", "export default {}");
    write(dir, "build.mjs", "import fs from 'node:fs'");
    write(dir, "tsconfig.json", "{}");
    write(dir, "vite.config.ts", "export default {}");
    write(dir, "dist/index.js.map", "{}");

    const unpacked = await unpackTo(await packDirectory(dir), path.join(tmp, "out"));

    expect(unpacked.sort()).toEqual(["assets/logo.svg", "dist/index.js", "theme.json"]);
  });

  it("never packs the publisher's private key", async () => {
    // The workflow every publisher is told to follow is `zcms keygen` (which
    // writes the key into the project directory) followed by `zcms pack .`. So
    // this is not a hypothetical stray file: without this rule the key that signs
    // the package ships INSIDE it — up to the marketplace, then down onto every
    // runtime that installs it, signed by the very key it is leaking. The first
    // package a publisher ever released would forfeit their identity.
    //
    // It has to be silent and unconditional. A warning the author must read is
    // not a control; the safe outcome cannot depend on anyone noticing.
    // The rule is by FILENAME, so these hold placeholder bytes rather than
    // anything key-shaped — a real PEM header here would trip the repository's own
    // secret scanner, which is a control worth not teaching to ignore PEM headers.
    const dir = themeDir();
    write(dir, "publisher-private.pem", "stand-in for the publisher's signing key");
    write(dir, "publisher-public.pem", "stand-in for the publisher's public key");
    write(dir, "keys/signing.key", "stand-in");
    write(dir, "cert.p12", "stand-in");
    write(dir, ".npmrc", "stand-in for a registry token");
    write(dir, "id_ed25519", "stand-in");

    const unpacked = await unpackTo(await packDirectory(dir), path.join(tmp, "out"));

    expect(unpacked.sort()).toEqual(["assets/logo.svg", "dist/index.js", "theme.json"]);
  });

  it("leaves the package's own tests out of the archive", async () => {
    // Tests are dev-only, like src/. Shipping them enlarges what the scanner has
    // to read and what the signature has to cover, for code no runtime will run.
    const dir = themeDir();
    write(dir, "test/theme.test.ts", "import { it } from 'vitest'");

    const unpacked = await unpackTo(await packDirectory(dir), path.join(tmp, "out"));

    expect(unpacked.sort()).toEqual(["assets/logo.svg", "dist/index.js", "theme.json"]);
  });

  it("still ships an asset whose path merely looks like a denied one", async () => {
    // The deny list must not be so eager that it eats a theme's own files. A
    // theme with an `assets/testimonials/` directory is packaging a testimonial,
    // not a test suite.
    const dir = themeDir();
    write(dir, "assets/testimonials/ada.svg", "<svg/>");

    const unpacked = await unpackTo(await packDirectory(dir), path.join(tmp, "out"));

    expect(unpacked).toContain("assets/testimonials/ada.svg");
  });

  it("refuses a directory that contains nothing to pack", async () => {
    const dir = path.join(tmp, "empty");
    fs.mkdirSync(dir);

    await expect(packDirectory(dir)).rejects.toThrow(PackageError);
  });

  it("refuses a directory whose only files are all denied", async () => {
    // An "empty" package is not just a useless one — it would be signed and
    // published as a real release with no content behind the signature.
    const dir = path.join(tmp, "only-denied");
    write(dir, "src/index.ts", "export default {}");
    write(dir, ".env", "SECRET=1");

    await expect(packDirectory(dir)).rejects.toThrow(/No files in/);
  });

  it("refuses a directory with more files than the entry limit", async () => {
    const dir = path.join(tmp, "many");
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i <= MAX_ENTRIES; i++) {
      fs.writeFileSync(path.join(dir, `f${i}.txt`), "x");
    }

    await expect(packDirectory(dir)).rejects.toThrow(/too many files/);
  });
});

describe("unpackTo", () => {
  it("writes every file of a well-formed package, preserving its layout", async () => {
    const dir = themeDir();

    const written = await unpackTo(await packDirectory(dir), path.join(tmp, "out"));

    expect(written.sort()).toEqual(["assets/logo.svg", "dist/index.js", "theme.json"]);
    expect(fs.readFileSync(path.join(tmp, "out", "dist/index.js"), "utf8")).toBe(
      "export default {}\n",
    );
  });

  it("creates the destination directory when it does not exist yet", async () => {
    const dest = path.join(tmp, "deep", "nested", "out");

    await unpackTo(await packDirectory(themeDir()), dest);

    expect(fs.existsSync(path.join(dest, "theme.json"))).toBe(true);
  });

  it("accepts an explicit directory entry inside the destination", async () => {
    const payload = await hostileTarball([
      { header: { name: "assets", type: "directory" } },
      { header: { name: "assets/a.txt", type: "file", size: 1 }, body: "a" },
    ]);
    const dest = path.join(tmp, "out");

    const written = await unpackTo(payload, dest);

    // Directories are not reported as written files, only the file inside is.
    expect(written).toEqual(["assets/a.txt"]);
    expect(fs.statSync(path.join(dest, "assets")).isDirectory()).toBe(true);
  });

  it("rejects a tar entry whose path escapes the destination directory", async () => {
    // ATTACK: tar-slip. "install a theme" becomes "write /etc/cron.d as the
    // server user" if the resolved path is not forced back inside `dest`.
    const payload = await hostileTarball([
      { header: { name: "../../etc/x", type: "file", size: 4 }, body: "evil" },
    ]);
    const dest = path.join(tmp, "out");

    await expect(unpackTo(payload, dest)).rejects.toThrow(/Path traversal/);
    expect(fs.existsSync(path.join(tmp, "etc"))).toBe(false);
    expect(fs.existsSync(path.resolve(dest, "../../etc/x"))).toBe(false);
  });

  it("rejects a traversal hidden behind a legitimate-looking prefix", async () => {
    // ATTACK: "dist/../../escape" — the leading segment makes the path look tame
    // until path.resolve() collapses it.
    const payload = await hostileTarball([
      { header: { name: "dist/../../escape", type: "file", size: 4 }, body: "evil" },
    ]);
    const dest = path.join(tmp, "out");

    await expect(unpackTo(payload, dest)).rejects.toThrow(/Path traversal/);
    expect(fs.existsSync(path.join(tmp, "escape"))).toBe(false);
  });

  it("rejects a tar entry with an absolute path", async () => {
    // ATTACK: absolute-path overwrite. Simpler than a traversal and just as fatal.
    const payload = await hostileTarball([
      { header: { name: "/etc/cron.d/zcms", type: "file", size: 4 }, body: "evil" },
    ]);

    await expect(unpackTo(payload, path.join(tmp, "out"))).rejects.toThrow(
      /Absolute path/,
    );
  });

  it("rejects a tar entry with a Windows drive-letter path", async () => {
    // ATTACK: the same overwrite on a Windows host, where path.isAbsolute() on a
    // POSIX build of Node would happily call "C:/..." a relative path.
    const payload = await hostileTarball([
      { header: { name: "C:/Windows/evil.js", type: "file", size: 4 }, body: "evil" },
    ]);

    await expect(unpackTo(payload, path.join(tmp, "out"))).rejects.toThrow(
      /Absolute path/,
    );
  });

  it("rejects a symlink entry pointing outside the package", async () => {
    // ATTACK: plant a symlink to /etc/passwd, then have the runtime read what it
    // believes is a theme asset. The link is refused rather than followed.
    const payload = await hostileTarball([
      { header: { name: "assets/passwd", type: "symlink", linkname: "/etc/passwd" } },
    ]);
    const dest = path.join(tmp, "out");

    await expect(unpackTo(payload, dest)).rejects.toThrow(/Links are not allowed/);
    expect(fs.existsSync(path.join(dest, "assets/passwd"))).toBe(false);
  });

  it("rejects a symlink entry even when its target is inside the package", async () => {
    // No symlink is safe: a benign-looking one can be re-pointed by a second
    // entry, and the whole class is cheaper to refuse than to reason about.
    const payload = await hostileTarball([
      { header: { name: "dist/index.js", type: "file", size: 2 }, body: "{}" },
      { header: { name: "link.js", type: "symlink", linkname: "dist/index.js" } },
    ]);

    await expect(unpackTo(payload, path.join(tmp, "out"))).rejects.toThrow(
      /Links are not allowed/,
    );
  });

  it("rejects a hardlink entry", async () => {
    // ATTACK: hardlinks bypass symlink checks entirely and give the same result —
    // a file in the package that is really a file somewhere else on the host.
    const payload = await hostileTarball([
      { header: { name: "dist/index.js", type: "file", size: 2 }, body: "{}" },
      { header: { name: "hard", type: "link", linkname: "dist/index.js" } },
    ]);

    await expect(unpackTo(payload, path.join(tmp, "out"))).rejects.toThrow(
      /Links are not allowed/,
    );
  });

  it("rejects an entry that is neither a file nor a directory", async () => {
    // ATTACK: a device node or FIFO in a package. Nothing legitimate needs one,
    // and unpacking one gives an attacker a handle the runtime did not expect.
    const payload = await hostileTarball([
      {
        header: { name: "dev/null", type: "character-device", devmajor: 1, devminor: 3 },
      },
    ]);

    await expect(unpackTo(payload, path.join(tmp, "out"))).rejects.toThrow(
      /unexpected entry/,
    );
  });

  it("rejects a package that decompresses to more than the size limit", async () => {
    // ATTACK: decompression bomb. A few kilobytes of gzip that expand to gigabytes
    // fills the disk of every runtime that pulls the package.
    const bomb = Buffer.alloc(MAX_UNPACKED_BYTES + 1);
    const payload = await hostileTarball([
      { header: { name: "big.bin", type: "file", size: bomb.length }, body: bomb },
    ]);
    const dest = path.join(tmp, "out");

    await expect(unpackTo(payload, dest)).rejects.toThrow(/decompression bomb/);
    expect(fs.existsSync(path.join(dest, "big.bin"))).toBe(false);
  });

  it("rejects a package with more entries than the limit", async () => {
    // ATTACK: inode exhaustion — millions of empty files cost the attacker nothing
    // to compress and cost the host its filesystem.
    const entries = Array.from({ length: MAX_ENTRIES + 1 }, (_, i) => ({
      header: { name: `f${i}.txt`, type: "file", size: 1 } as Headers,
      body: "x",
    }));
    const payload = await hostileTarball(entries);

    await expect(unpackTo(payload, path.join(tmp, "out"))).rejects.toThrow(
      /too many entries/,
    );
  });

  it("reports the first violation rather than the stream teardown that follows it", async () => {
    // A hostile package must produce a diagnosis a human can act on ("path
    // traversal"), not "premature close" from the plumbing that tore down.
    const payload = await hostileTarball([
      { header: { name: "../escape", type: "file", size: 1 }, body: "x" },
      { header: { name: "ok.txt", type: "file", size: 1 }, body: "x" },
    ]);

    await expect(unpackTo(payload, path.join(tmp, "out"))).rejects.toThrow(PackageError);
  });

  it("rejects bytes that are not a gzip archive at all", async () => {
    await expect(
      unpackTo(Buffer.from("this is not a package"), path.join(tmp, "out")),
    ).rejects.toThrow();
  });
});
