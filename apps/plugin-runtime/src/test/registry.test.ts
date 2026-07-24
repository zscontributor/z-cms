import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadSignedPlugin, forgetPlugin, listInstalledKeys } from "../registry";

/**
 * The registry is the LAST checkpoint before a bundle is executed.
 *
 * The built-in path — signed .zcms, verified against the pinned first-party key —
 * lives in registry-builtin.test.ts, because it is worth attacking on its own. What
 * is left here is the marketplace path and the lifecycle around both: which keys the
 * runtime admits it has, and what the kill switch actually drops.
 *
 * There used to be a `describe("loadPlugin")` above this, covering a function that
 * read `dist/index.js` off the volume and ran it unverified. That function is gone,
 * and so are its tests: a loose .js file next to a plugin.json is not a plugin any
 * more, it is a file.
 */

let dir: string;

/** Writes a plugin the way the installer lays one out: <dir>/plugin.json + entry. */
function plant(
  key: string,
  opts: { version?: string; entry?: string; code?: string; noBundle?: boolean } = {},
) {
  const folder = path.join(dir, key.replace(/[^a-zA-Z0-9._-]/g, "_"));
  fs.mkdirSync(folder, { recursive: true });
  const entry = opts.entry ?? "dist/index.js";
  fs.writeFileSync(
    path.join(folder, "plugin.json"),
    JSON.stringify({ id: key, version: opts.version ?? "1.0.0", entry }),
  );
  if (!opts.noBundle) {
    const bundlePath = path.join(folder, entry);
    fs.mkdirSync(path.dirname(bundlePath), { recursive: true });
    fs.writeFileSync(bundlePath, opts.code ?? "module.exports = {};");
  }
  return folder;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "zcms-registry-"));
  process.env.PLUGIN_DIR = dir;
  // Keep every load a fresh disk read so one test cannot poison the next through
  // the module-level cache (which only survives in production anyway).
  delete process.env.NODE_ENV;
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("loadSignedPlugin", () => {
  it("refuses to load a marketplace plugin when the pinned key is not configured", async () => {
    // Without the pinned marketplace key there is no way to verify the download, so
    // the only safe answer is to refuse — never to fetch and run an unverified bundle.
    delete process.env.MARKETPLACE_PUBLIC_KEY;

    await expect(loadSignedPlugin("vn.zsoft.theme.x", "1.0.0")).rejects.toThrow(
      /MARKETPLACE_PUBLIC_KEY is not configured/,
    );
  });
});

describe("forgetPlugin", () => {
  it("removes a purged plugin's cached bundle from disk so it must be re-fetched", () => {
    // The kill switch as the runtime sees it: after a purge, the next invocation has
    // to download again, which the API now refuses. A bundle left on disk would keep
    // running a pulled plugin.
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcms-cache-"));
    process.env.PLUGIN_CACHE_DIR = cacheDir;
    const bundleDir = path.join(cacheDir, "plugin", "vn.zsoft.theme.x", "1.0.0");
    fs.mkdirSync(bundleDir, { recursive: true });
    fs.writeFileSync(path.join(bundleDir, "index.js"), "module.exports = {};");

    forgetPlugin("vn.zsoft.theme.x", "1.0.0");

    expect(fs.existsSync(bundleDir)).toBe(false);
    fs.rmSync(cacheDir, { recursive: true, force: true });
    delete process.env.PLUGIN_CACHE_DIR;
  });

  it("is a no-op that does not throw when there is nothing cached to forget", () => {
    // Purge may arrive for a plugin this runtime never cached. It must not crash.
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcms-cache-"));
    process.env.PLUGIN_CACHE_DIR = cacheDir;

    expect(() => forgetPlugin("vn.zsoft.theme.never", "9.9.9")).not.toThrow();

    fs.rmSync(cacheDir, { recursive: true, force: true });
    delete process.env.PLUGIN_CACHE_DIR;
  });
});

describe("listInstalledKeys", () => {
  it("lists the ids of every installed plugin", () => {
    plant("vn.zsoft.plugin.a");
    plant("vn.zsoft.plugin.b");

    expect(listInstalledKeys().sort()).toEqual(["vn.zsoft.plugin.a", "vn.zsoft.plugin.b"]);
  });

  it("returns an empty list when the plugin directory does not exist", () => {
    process.env.PLUGIN_DIR = path.join(dir, "does-not-exist");

    expect(listInstalledKeys()).toEqual([]);
  });
});
