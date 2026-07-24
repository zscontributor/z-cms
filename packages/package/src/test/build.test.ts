import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { packDirectory } from "../archive";
import { buildPackage, installPayload, openPackage, readManifest, wrap } from "../build";
import { generateKeyPair, sha256, verifyPublisher } from "../signing";
import { PackageError, type PackageEnvelope, type PackageManifest } from "../types";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "zcms-build-test-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function write(dir: string, rel: string, content: string | Buffer): void {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

const MANIFEST = {
  id: "vn.zsoft.theme.corporate",
  name: "Corporate",
  version: "1.0.0",
  author: { name: "Z-SOFT" },
  engine: ">=0.1.0",
};

/** A source directory a publisher would actually run `build` against. */
function themeDir(
  manifest: Record<string, unknown> = MANIFEST,
  { entryFile = "dist/index.js", name = "theme" }: { entryFile?: string; name?: string } = {},
): string {
  const dir = path.join(tmp, name);
  write(dir, "theme.json", JSON.stringify(manifest));
  if (entryFile) write(dir, entryFile, "export default {}\n");
  return dir;
}

describe("readManifest", () => {
  it("reads a theme manifest and stamps it with its kind", () => {
    const manifest = readManifest(themeDir(), "theme");

    expect(manifest.id).toBe("vn.zsoft.theme.corporate");
    expect(manifest.kind).toBe("theme");
  });

  it("reads a plugin manifest from plugin.json rather than theme.json", () => {
    const dir = path.join(tmp, "plugin");
    write(dir, "plugin.json", JSON.stringify({ ...MANIFEST, id: "vn.zsoft.plugin.seo" }));
    write(dir, "dist/index.js", "export default {}\n");

    expect(readManifest(dir, "plugin").kind).toBe("plugin");
  });

  it("refuses a directory with no manifest file", () => {
    const dir = path.join(tmp, "bare");
    write(dir, "dist/index.js", "export default {}\n");

    expect(() => readManifest(dir, "theme")).toThrow(/Missing theme.json/);
  });

  it("refuses a theme manifest that is missing a plugin.json when asked for a plugin", () => {
    // The kind decides the filename; a theme directory is not a plugin directory.
    expect(() => readManifest(themeDir(), "plugin")).toThrow(/Missing plugin.json/);
  });

  it.each(["id", "name", "version", "author", "engine"])(
    'refuses a manifest that is missing the required field "%s"',
    (field) => {
      // A package with no id or no version cannot be addressed, pinned or revoked
      // later — the kill switch needs both to name what it is killing.
      const incomplete: Record<string, unknown> = { ...MANIFEST };
      delete incomplete[field];

      expect(() => readManifest(themeDir(incomplete), "theme")).toThrow(
        new RegExp(`missing the required field "${field}"`),
      );
    },
  );

  it("defaults the entry to dist/index.js when the manifest does not name one", () => {
    expect(readManifest(themeDir(), "theme").entry).toBe("dist/index.js");
  });

  it("keeps an explicit entry declared by the manifest", () => {
    const dir = themeDir({ ...MANIFEST, entry: "dist/theme.mjs" }, { entryFile: "dist/theme.mjs" });

    expect(readManifest(dir, "theme").entry).toBe("dist/theme.mjs");
  });

  it("refuses a manifest whose entry file has not been built", () => {
    // Publishing a package whose entry does not exist produces a signed release
    // that every runtime downloads and then fails to load. Catch it at pack time.
    const dir = themeDir(MANIFEST, { entryFile: "" });
    write(dir, "dist/other.js", "x");

    expect(() => readManifest(dir, "theme")).toThrow(/does not exist/);
  });

  it("throws PackageError, so the CLI can tell a bad package from a crash", () => {
    expect(() => readManifest(path.join(tmp, "nowhere"), "theme")).toThrow(PackageError);
  });
});

describe("buildPackage", () => {
  it("produces an envelope whose checksum and signature describe the payload", async () => {
    const publisher = generateKeyPair();

    const { file, envelope } = await buildPackage(
      themeDir(),
      "theme",
      publisher.privateKey,
      publisher.publicKey,
    );
    const { payload } = await openPackage(file);

    expect(envelope.checksum).toBe(sha256(payload));
    expect(() => verifyPublisher(envelope, payload)).not.toThrow();
  });

  it("produces a file that opens back into the same envelope and payload", async () => {
    const publisher = generateKeyPair();

    const built = await buildPackage(
      themeDir(),
      "theme",
      publisher.privateKey,
      publisher.publicKey,
    );
    const opened = await openPackage(built.file);

    expect(opened.envelope).toEqual(built.envelope);
    expect(sha256(opened.payload)).toBe(built.envelope.checksum);
  });

  it("stores the publisher key trimmed, so a PEM read from disk still matches one from a database", async () => {
    // A trailing newline on one side of the comparison is reported to a publisher
    // as "unknown key", which sends them hunting a problem that does not exist.
    const publisher = generateKeyPair();

    const { envelope } = await buildPackage(
      themeDir(),
      "theme",
      publisher.privateKey,
      `${publisher.publicKey}\n\n`,
    );

    expect(envelope.publisherKey).toBe(publisher.publicKey.trim());
  });

  it("leaves the package unsigned by the marketplace — that signature is not the publisher's to make", async () => {
    const publisher = generateKeyPair();

    const { envelope } = await buildPackage(
      themeDir(),
      "theme",
      publisher.privateKey,
      publisher.publicKey,
    );

    expect(envelope.marketplaceSignature).toBeUndefined();
  });

  it("refuses to build a package whose manifest is invalid", async () => {
    const publisher = generateKeyPair();
    const dir = themeDir({ ...MANIFEST, version: "" });

    await expect(
      buildPackage(dir, "theme", publisher.privateKey, publisher.publicKey),
    ).rejects.toThrow(PackageError);
  });
});

describe("wrap / openPackage", () => {
  function envelopeFor(payload: Buffer): PackageEnvelope {
    const publisher = generateKeyPair();
    const checksum = sha256(payload);
    return {
      checksum,
      manifest: { ...MANIFEST, kind: "theme", entry: "dist/index.js" } as PackageManifest,
      publisherSignature: "sig",
      publisherKey: publisher.publicKey,
    };
  }

  it("round-trips an envelope and its payload byte-for-byte", async () => {
    const payload = Buffer.from("the tar.gz bytes of a theme");
    const envelope = envelopeFor(payload);

    const opened = await openPackage(await wrap(envelope, payload));

    expect(opened.envelope).toEqual(envelope);
    expect(opened.payload.equals(payload)).toBe(true);
  });

  it("refuses a gzipped tar that carries no envelope", async () => {
    // Anyone can upload a .tgz and call it a .zcms. Being able to unpack it is
    // not the same as it being a package.
    const dir = path.join(tmp, "not-a-package");
    write(dir, "readme.txt", "just some files");
    const file = await packDirectory(dir);

    await expect(openPackage(file)).rejects.toThrow(/not a valid Z-CMS package/);
  });

  it("refuses a package whose payload file is missing", async () => {
    const dir = path.join(tmp, "half");
    write(dir, "zcms-package.json", JSON.stringify(envelopeFor(Buffer.from("x"))));
    const file = await packDirectory(dir);

    await expect(openPackage(file)).rejects.toThrow(/not a valid Z-CMS package/);
  });

  it("refuses bytes that are not an archive at all", async () => {
    await expect(openPackage(Buffer.from("PK\x03\x04 nope"))).rejects.toThrow();
  });

  it("leaves no staging directory behind after opening a package", async () => {
    // openPackage runs on every download. A leaked temp dir per call turns a busy
    // runtime into a disk-full incident.
    // Other suites open packages concurrently, so we assert only that OUR call
    // leaves nothing new behind — not an absolute count of the shared tmpdir.
    const before = new Set(
      fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith("zcms-open-")),
    );
    const payload = Buffer.from("payload");

    await openPackage(await wrap(envelopeFor(payload), payload));

    const leaked = fs
      .readdirSync(os.tmpdir())
      .filter((f) => f.startsWith("zcms-open-") && !before.has(f));
    expect(leaked).toEqual([]);
  });
});

describe("installPayload", () => {
  async function payloadOf(files: Record<string, string>): Promise<Buffer> {
    const dir = path.join(tmp, `payload-${Object.keys(files).length}-${Math.random()}`);
    for (const [rel, content] of Object.entries(files)) write(dir, rel, content);
    return packDirectory(dir);
  }

  it("unpacks a payload into a destination that does not exist yet", async () => {
    const dest = path.join(tmp, "cache", "theme", "1.0.0");

    const written = await installPayload(
      await payloadOf({ "dist/index.js": "v1" }),
      dest,
    );

    expect(written).toEqual(["dist/index.js"]);
    expect(fs.readFileSync(path.join(dest, "dist/index.js"), "utf8")).toBe("v1");
  });

  it("replaces an existing destination completely, leaving none of the old files", async () => {
    // An upgrade that merges into the old directory leaves the previous version's
    // files behind — including ones a security fix was meant to delete.
    const dest = path.join(tmp, "cache", "theme");
    await installPayload(await payloadOf({ "dist/index.js": "v1", "old.js": "stale" }), dest);

    await installPayload(await payloadOf({ "dist/index.js": "v2" }), dest);

    expect(fs.readFileSync(path.join(dest, "dist/index.js"), "utf8")).toBe("v2");
    expect(fs.existsSync(path.join(dest, "old.js"))).toBe(false);
  });

  it("leaves the previous install untouched when the new payload is refused", async () => {
    // The unpack happens in a private staging directory precisely so a hostile or
    // corrupt payload cannot destroy the working copy a live site is serving.
    const dest = path.join(tmp, "cache", "theme");
    await installPayload(await payloadOf({ "dist/index.js": "v1" }), dest);

    await expect(installPayload(Buffer.from("not an archive"), dest)).rejects.toThrow();

    expect(fs.readFileSync(path.join(dest, "dist/index.js"), "utf8")).toBe("v1");
  });

  it("leaves no partial staging directory behind when the payload is refused", async () => {
    const dest = path.join(tmp, "cache", "theme");

    await expect(installPayload(Buffer.from("not an archive"), dest)).rejects.toThrow();

    const siblings = fs.existsSync(path.dirname(dest))
      ? fs.readdirSync(path.dirname(dest))
      : [];
    expect(siblings.filter((f) => f.startsWith("theme.tmp-"))).toEqual([]);
  });

  it("leaves no staging directory behind after a successful install", async () => {
    const dest = path.join(tmp, "cache", "theme");

    await installPayload(await payloadOf({ "dist/index.js": "v1" }), dest);

    expect(fs.readdirSync(path.join(tmp, "cache"))).toEqual(["theme"]);
  });
});
