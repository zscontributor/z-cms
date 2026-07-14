import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { packDirectory } from "../archive";
import { wrap } from "../build";
import { bundleChecksumOnDisk, ensureBundle, type LoaderConfig } from "../loader";
import { generateKeyPair, sha256, signChecksum } from "../signing";
import { PackageError, type PackageEnvelope, type PackageManifest } from "../types";

/**
 * The loader is the boundary between "bytes cms-api sent us" and "code this
 * process is about to execute". Only `fetch` is faked here — the archive, the
 * crypto and the filesystem are all real, because a verification step that only
 * passes against a stub verifier proves nothing.
 */

const MARKER = ".zcms-verified";

let tmp: string;
let cfg: LoaderConfig;
let marketplace: ReturnType<typeof generateKeyPair>;
let publisher: ReturnType<typeof generateKeyPair>;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "zcms-loader-test-"));
  marketplace = generateKeyPair();
  publisher = generateKeyPair();
  cfg = {
    cacheDir: path.join(tmp, "cache"),
    apiUrl: "http://cms-api.test",
    internalToken: "internal-token",
    marketplacePublicKey: marketplace.publicKey,
  };
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function write(dir: string, rel: string, content: string): void {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

const KEY = "vn.zsoft.theme.corporate";
const VERSION = "1.0.0";

function manifestFor(overrides: Partial<PackageManifest> = {}): PackageManifest {
  return {
    id: KEY,
    name: "Corporate",
    version: VERSION,
    kind: "theme",
    author: { name: "Z-SOFT" },
    engine: ">=0.1.0",
    entry: "dist/index.js",
    ...overrides,
  };
}

/**
 * Produces the .zcms bytes cms-api would serve. `signer` is who signs the
 * marketplace signature — an attacker's key by default in the forgery tests.
 */
async function releasedFile(
  {
    manifest = manifestFor(),
    files = { "dist/index.js": "export default { name: 'corporate' }\n" },
    signer = marketplace,
    marketplaceSigned = true,
  }: {
    manifest?: PackageManifest;
    files?: Record<string, string>;
    signer?: ReturnType<typeof generateKeyPair>;
    marketplaceSigned?: boolean;
  } = {},
): Promise<{ file: Buffer; checksum: string }> {
  const src = fs.mkdtempSync(path.join(tmp, "src-"));
  write(src, "theme.json", JSON.stringify(manifest));
  for (const [rel, content] of Object.entries(files)) write(src, rel, content);

  const payload = await packDirectory(src);
  const checksum = sha256(payload);

  const envelope: PackageEnvelope = {
    checksum,
    manifest,
    publisherSignature: signChecksum(checksum, publisher.privateKey),
    publisherKey: publisher.publicKey,
    ...(marketplaceSigned
      ? { marketplaceSignature: signChecksum(checksum, signer.privateKey) }
      : {}),
  };

  return { file: await wrap(envelope, payload), checksum };
}

/** Stubs the one thing that must not be real: the network. */
function stubDownload(file: Buffer): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async () => new Response(new Uint8Array(file), { status: 200 }));
  vi.stubGlobal("fetch", mock);
  return mock;
}

function bundlePath(key = KEY, version = VERSION): string {
  return path.join(cfg.cacheDir, "theme", key, version);
}

describe("ensureBundle", () => {
  it("downloads, verifies and unpacks a package that is not yet cached", async () => {
    const { file, checksum } = await releasedFile();
    const fetchMock = stubDownload(file);

    const bundle = await ensureBundle(cfg, "marketplace", "theme", KEY, VERSION, checksum);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(bundle.checksum).toBe(checksum);
    expect(bundle.entryPath).toBe(path.join(bundlePath(), "dist/index.js"));
    expect(fs.readFileSync(bundle.entryPath, "utf8")).toContain("corporate");
  });

  it("sends the internal token to the bundle endpoint of the configured API", async () => {
    const { file } = await releasedFile();
    const fetchMock = stubDownload(file);

    await ensureBundle(cfg, "marketplace", "theme", KEY, VERSION);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `http://cms-api.test/api/v1/packages/theme/${encodeURIComponent(KEY)}/1.0.0/bundle`,
    );
    expect((init.headers as Record<string, string>)["x-internal-token"]).toBe(
      "internal-token",
    );
  });

  it("writes a marker recording the checksum it verified", async () => {
    const { file, checksum } = await releasedFile();
    stubDownload(file);

    await ensureBundle(cfg, "marketplace", "theme", KEY, VERSION);

    const marker = JSON.parse(
      fs.readFileSync(path.join(bundlePath(), MARKER), "utf8"),
    ) as { checksum: string; manifest: PackageManifest };
    expect(marker.checksum).toBe(checksum);
    expect(marker.manifest.id).toBe(KEY);
  });

  it("returns the cached bundle without downloading it again", async () => {
    // Every page render of every site calls this. A cache that re-downloads is a
    // self-inflicted DDoS on cms-api.
    const { file, checksum } = await releasedFile();
    const fetchMock = stubDownload(file);
    await ensureBundle(cfg, "marketplace", "theme", KEY, VERSION, checksum);
    fetchMock.mockClear();

    const bundle = await ensureBundle(cfg, "marketplace", "theme", KEY, VERSION, checksum);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(bundle.checksum).toBe(checksum);
  });

  it("re-fetches when the cached marker disagrees with the checksum the API registered", async () => {
    // A cache entry whose checksum is not the released one means the version was
    // republished or someone wrote to the cache directory. Both mean: do not use it.
    const dir = bundlePath();
    fs.mkdirSync(path.join(dir, "dist"), { recursive: true });
    fs.writeFileSync(path.join(dir, "dist/index.js"), "export default { evil: true }\n");
    fs.writeFileSync(
      path.join(dir, MARKER),
      JSON.stringify({ checksum: "cafebabe", manifest: manifestFor() }),
    );

    const { file, checksum } = await releasedFile();
    const fetchMock = stubDownload(file);

    const bundle = await ensureBundle(cfg, "marketplace", "theme", KEY, VERSION, checksum);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(bundle.checksum).toBe(checksum);
    expect(fs.readFileSync(bundle.entryPath, "utf8")).toContain("corporate");
  });

  it("re-fetches when the cached entry file has gone missing", async () => {
    const { file, checksum } = await releasedFile();
    const fetchMock = stubDownload(file);
    await ensureBundle(cfg, "marketplace", "theme", KEY, VERSION, checksum);
    fs.rmSync(path.join(bundlePath(), "dist/index.js"));
    fetchMock.mockClear();

    await ensureBundle(cfg, "marketplace", "theme", KEY, VERSION, checksum);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(path.join(bundlePath(), "dist/index.js"))).toBe(true);
  });

  it("refuses a package signed by a key the runtime does not pin, and writes nothing to disk", async () => {
    // THE ATTACK THIS MODULE EXISTS FOR: an attacker who owns cms-api serves a
    // backdoored bundle signed with their own key. The pinned marketplace key is
    // in the runtime's config, so the forgery has nothing to hide behind — and
    // crucially, the hostile bytes must never reach the cache at all.
    const attacker = generateKeyPair();
    const { file } = await releasedFile({
      files: { "dist/index.js": "exfiltrate(process.env)\n" },
      signer: attacker,
    });
    stubDownload(file);

    await expect(ensureBundle(cfg, "marketplace", "theme", KEY, VERSION)).rejects.toThrow(
      /not released by Z-CMS/,
    );
    expect(fs.existsSync(bundlePath())).toBe(false);
  });

  it("refuses a package the marketplace never signed at all", async () => {
    // A publisher-signed package pulled straight from a review queue is authentic
    // and must still not run.
    const { file } = await releasedFile({ marketplaceSigned: false });
    stubDownload(file);

    await expect(ensureBundle(cfg, "marketplace", "theme", KEY, VERSION)).rejects.toThrow(
      /has not been signed by the marketplace/,
    );
    expect(fs.existsSync(bundlePath())).toBe(false);
  });

  it("refuses a package whose checksum differs from the one the API registered", async () => {
    // A genuinely signed but *different* release swapped in for the one the site
    // pinned — a downgrade to a version with a known hole, for instance.
    const { file } = await releasedFile();
    stubDownload(file);

    await expect(
      ensureBundle(cfg, "marketplace", "theme", KEY, VERSION, "0".repeat(64)),
    ).rejects.toThrow(/differs from the registered one/);
    expect(fs.existsSync(bundlePath())).toBe(false);
  });

  it("refuses a package whose manifest names a different id than the one requested", async () => {
    // Substitution: ask for the corporate theme, get a signed-but-unrelated package.
    const { file } = await releasedFile({
      manifest: manifestFor({ id: "vn.zsoft.theme.something-else" }),
    });
    stubDownload(file);

    await expect(ensureBundle(cfg, "marketplace", "theme", KEY, VERSION)).rejects.toThrow(
      /but "vn.zsoft.theme.corporate" was requested/,
    );
    expect(fs.existsSync(bundlePath())).toBe(false);
  });

  it("refuses an entry that points outside the bundle, and removes the unpacked directory", async () => {
    // ATTACK: the manifest is attacker-authored too. unpackTo refuses hostile tar
    // *paths*, but nothing stops a manifest from naming "../../evil" as its entry
    // and having the runtime import whatever is there.
    const { file } = await releasedFile({
      manifest: manifestFor({ entry: "../../evil" }),
    });
    stubDownload(file);

    await expect(ensureBundle(cfg, "marketplace", "theme", KEY, VERSION)).rejects.toThrow(
      /points outside the package/,
    );
    expect(fs.existsSync(bundlePath())).toBe(false);
  });

  it("refuses a package whose declared entry is not inside it, and removes the unpacked directory", async () => {
    const { file } = await releasedFile({
      manifest: manifestFor({ entry: "dist/not-built.js" }),
    });
    stubDownload(file);

    await expect(ensureBundle(cfg, "marketplace", "theme", KEY, VERSION)).rejects.toThrow(
      /is not in the package/,
    );
    expect(fs.existsSync(bundlePath())).toBe(false);
  });

  it("refuses a bundle the API declines to serve", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 404 })));

    await expect(ensureBundle(cfg, "marketplace", "theme", KEY, VERSION)).rejects.toThrow(PackageError);
  });

  it("keeps a hostile key from shaping the cache path", async () => {
    // The key comes from the database. A key of "../../../../etc" must land in a
    // sanitised directory inside the cache, never above it.
    const key = "../../../../etc/passwd";
    const { file } = await releasedFile({ manifest: manifestFor({ id: key }) });
    stubDownload(file);

    const bundle = await ensureBundle(cfg, "marketplace", "theme", key, VERSION);

    // The sanitiser keeps dots but strips separators, so the whole hostile key
    // collapses into ONE path segment under the cache — it can never climb out.
    const themeRoot = path.join(cfg.cacheDir, "theme");
    expect(bundle.dir.startsWith(themeRoot + path.sep)).toBe(true);
    const segments = path.relative(themeRoot, bundle.dir).split(path.sep);
    expect(segments).not.toContain("..");
    expect(fs.existsSync(path.join(themeRoot))).toBe(true);
  });
});

describe("bundleChecksumOnDisk", () => {
  it("reports the checksum recorded when the bundle was verified", async () => {
    const { file, checksum } = await releasedFile();
    stubDownload(file);
    await ensureBundle(cfg, "marketplace", "theme", KEY, VERSION);

    expect(bundleChecksumOnDisk(bundlePath())).toBe(checksum);
  });

  it("reports nothing for a directory that was never verified", () => {
    // A directory with files but no marker was not put there by this loader, so
    // it has no checksum we are willing to vouch for.
    const dir = path.join(tmp, "unverified");
    fs.mkdirSync(dir, { recursive: true });

    expect(bundleChecksumOnDisk(dir)).toBeNull();
  });

  it("reports nothing for a directory that does not exist", () => {
    expect(bundleChecksumOnDisk(path.join(tmp, "nowhere"))).toBeNull();
  });
});
