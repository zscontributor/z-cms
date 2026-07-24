import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * `zcms` is a process entrypoint: everything happens inside `main()`, which runs
 * on import and calls `process.exit`. None of its functions are exported, so it
 * cannot be imported without executing. Rather than restructure the source to
 * make it importable, this suite drives the REAL binary as a subprocess — which
 * is also how a publisher actually uses it. It exercises argument parsing, the
 * command dispatch table, the error messages, and a full keygen -> pack -> verify
 * round-trip against real temp directories.
 *
 * These run in a child process, so they do not register on v8's line counter;
 * the coverage floor for this package is 0 for exactly that reason (see
 * vitest.config.ts). The behaviour coverage here is nonetheless real.
 */

const execFileAsync = promisify(execFile);

// __dirname (this package's tsconfig compiles to CommonJS, and vitest provides it).
// This file lives in src/test/, so both targets are one level up from it: the CLI
// entrypoint in src/, and the package's own node_modules two levels up. Getting
// either wrong does not fail loudly — the child process simply produces no output,
// and every assertion below fails on an empty string.
const MAIN = path.join(__dirname, "..", "main.ts");
const TSX = path.join(__dirname, "..", "..", "node_modules", ".bin", "tsx");

interface Run {
  stdout: string;
  stderr: string;
  code: number;
}

/** Runs `zcms <args>` and captures stdout, stderr and the exit code. */
async function zcms(args: string[]): Promise<Run> {
  try {
    const { stdout, stderr } = await execFileAsync(TSX, [MAIN, ...args]);
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", code: e.code ?? 1 };
  }
}

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "zcms-cli-test-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** A built theme directory the CLI would accept for packing. */
function themeDir(id = "vn.zsoft.theme.corporate"): string {
  const dir = path.join(tmp, "theme");
  fs.mkdirSync(path.join(dir, "dist"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "theme.json"),
    JSON.stringify({ id, name: "Corporate", version: "1.0.0", author: { name: "Z-SOFT" }, engine: ">=0.1.0" }),
  );
  fs.writeFileSync(path.join(dir, "dist", "index.js"), "export default {}\n");
  return dir;
}

/** Runs keygen into a fresh dir and returns the two key paths. */
async function keys(): Promise<{ priv: string; pub: string }> {
  const out = path.join(tmp, "keys");
  await zcms(["keygen", "--out", out]);
  return {
    priv: path.join(out, "publisher-private.pem"),
    pub: path.join(out, "publisher-public.pem"),
  };
}

describe("command dispatch", () => {
  it("prints usage and exits 0 when given no command", async () => {
    // Bare `zcms` is a user asking what it does, not an error.
    const { stdout, code } = await zcms([]);

    expect(stdout).toContain("the packaging tool for Z-CMS");
    expect(code).toBe(0);
  });

  it("prints usage and exits non-zero on an unknown command", async () => {
    // A typo'd command must fail the shell, so a script built on it does not
    // sail past a step that never ran.
    const { stdout, code } = await zcms(["frobnicate"]);

    expect(stdout).toContain("zcms keygen");
    expect(code).toBe(1);
  });
});

describe("keygen", () => {
  it("writes a publisher key pair into the requested directory", async () => {
    const out = path.join(tmp, "keys");

    const { code } = await zcms(["keygen", "--out", out]);

    expect(code).toBe(0);
    expect(fs.readFileSync(path.join(out, "publisher-private.pem"), "utf8")).toContain(
      "BEGIN PRIVATE KEY",
    );
    expect(fs.readFileSync(path.join(out, "publisher-public.pem"), "utf8")).toContain(
      "BEGIN PUBLIC KEY",
    );
  });

  it("writes the private key readable only by its owner", async () => {
    // A private key other users on the box can read is not private. keygen sets
    // 0600; a regression to a default mode is a real key-disclosure bug.
    const out = path.join(tmp, "keys");
    await zcms(["keygen", "--out", out]);

    const mode = fs.statSync(path.join(out, "publisher-private.pem")).mode & 0o777;

    expect(mode).toBe(0o600);
  });

  it("refuses to overwrite an existing private key", async () => {
    // Overwriting a private key orphans every package it ever signed. The second
    // run must fail loudly rather than clobber it.
    const out = path.join(tmp, "keys");
    await zcms(["keygen", "--out", out]);

    const { stderr, code } = await zcms(["keygen", "--out", out]);

    expect(stderr).toMatch(/already exists/);
    expect(code).toBe(1);
  });
});

describe("pack", () => {
  it("refuses to pack with no source directory", async () => {
    const { stderr, code } = await zcms(["pack"]);

    expect(stderr).toMatch(/Missing source directory/);
    expect(code).toBe(1);
  });

  it("refuses a --kind that is neither theme nor plugin", async () => {
    // The kind decides which manifest file is read and how the runtime treats the
    // package; a bogus kind must not silently default to one.
    const { stderr, code } = await zcms(["pack", themeDir(), "--kind", "widget"]);

    expect(stderr).toMatch(/--kind must be theme or plugin/);
    expect(code).toBe(1);
  });

  it("refuses to pack without both signing keys", async () => {
    const { stderr, code } = await zcms(["pack", themeDir(), "--kind", "theme"]);

    expect(stderr).toMatch(/--key .* and --pub .* are required/);
    expect(code).toBe(1);
  });

  it("packs a built theme directory into a signed .zcms file", async () => {
    const { priv, pub } = await keys();
    const out = path.join(tmp, "corporate.zcms");

    const { code } = await zcms([
      "pack", themeDir(), "--kind", "theme", "--key", priv, "--pub", pub, "--out", out,
    ]);

    expect(code).toBe(0);
    expect(fs.existsSync(out)).toBe(true);
    expect(fs.statSync(out).size).toBeGreaterThan(0);
  });

  it("surfaces a build failure as an error exit, not a silent success", async () => {
    // Packing a directory whose entry file was never built must fail — otherwise a
    // signed package ships that every runtime downloads and then cannot load.
    const { priv, pub } = await keys();
    const dir = path.join(tmp, "unbuilt");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "theme.json"),
      JSON.stringify({ id: "x", name: "X", version: "1.0.0", author: { name: "Z" }, engine: ">=0.1.0" }),
    );

    const { code } = await zcms([
      "pack", dir, "--kind", "theme", "--key", priv, "--pub", pub,
    ]);

    expect(code).toBe(1);
  });
});

describe("verify", () => {
  /** Packs a real .zcms and returns its path. */
  async function packed(): Promise<{ file: string; keys: { priv: string; pub: string } }> {
    const k = await keys();
    const file = path.join(tmp, "pkg.zcms");
    await zcms(["pack", themeDir(), "--kind", "theme", "--key", k.priv, "--pub", k.pub, "--out", file]);
    return { file, keys: k };
  }

  it("refuses to verify with no file argument", async () => {
    const { stderr, code } = await zcms(["verify"]);

    expect(stderr).toMatch(/Missing .zcms file/);
    expect(code).toBe(1);
  });

  it("reports a valid publisher signature on a freshly packed package", async () => {
    const { file } = await packed();

    const { stdout, code } = await zcms(["verify", file]);

    expect(stdout).toMatch(/publisher signature\s*: VALID/);
    expect(code).toBe(0);
  });

  it("does NOT claim the package is installable without a marketplace key", async () => {
    // The dangerous confusion this guards against: an author reading "valid" and
    // believing a runtime will run it. Only a marketplace signature makes it
    // installable, and without --marketplace-key that check is not even attempted.
    const { file } = await packed();

    const { stdout } = await zcms(["verify", file]);

    expect(stdout).toMatch(/marketplace signature : not checked/);
    expect(stdout).not.toMatch(/installable/);
  });

  it("reports an invalid marketplace signature and exits non-zero", async () => {
    // A publisher-signed-only package checked against a real marketplace key must
    // be reported as not installable — this is the check a runtime performs.
    const { file } = await packed();
    const otherKeys = path.join(tmp, "mk");
    await zcms(["keygen", "--out", otherKeys]);
    const marketplacePub = path.join(otherKeys, "publisher-public.pem");

    const { stdout, code } = await zcms(["verify", file, "--marketplace-key", marketplacePub]);

    expect(stdout).toMatch(/marketplace signature : INVALID/);
    expect(code).toBe(1);
  });

  it("fails rather than crashes on a file that is not a package", async () => {
    const bogus = path.join(tmp, "not-a-package.zcms");
    fs.writeFileSync(bogus, "just some bytes, definitely not a tar");

    const { code } = await zcms(["verify", bogus]);

    expect(code).toBe(1);
  });
});
