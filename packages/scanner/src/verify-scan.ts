import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildPackage, generateKeyPair, openPackage, wrap } from "@zcmsorg/package";
import { scanPackage } from "./scan";
import type { Verdict } from "./types";

/**
 * Attacks the scanner.
 *
 * The hostile cases are the point: a scanner nobody feeds malware to is a
 * scanner nobody has tested. Each builds a real signed package whose payload
 * contains the pattern, scans it, and asserts the verdict. The benign cases
 * matter just as much — a scanner that rejects the real SEO plugin is a scanner
 * that will be turned off.
 */

let failures = 0;

function check(name: string, passed: boolean, detail: string) {
  console.log(`  ${passed ? "PASS" : "FAIL"}  ${name}\n        ${detail}`);
  if (!passed) failures++;
}

const publisher = generateKeyPair();

/** Builds a signed package from an in-memory theme/plugin whose entry is `code`. */
async function packageWith(
  kind: "theme" | "plugin",
  code: string,
  extraManifest: Record<string, unknown> = {},
): Promise<Buffer> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zcms-scancase-"));
  fs.mkdirSync(path.join(dir, "dist"), { recursive: true });

  const manifestFile = kind === "theme" ? "theme.json" : "plugin.json";
  fs.writeFileSync(
    path.join(dir, manifestFile),
    JSON.stringify({
      id: `vn.test.${kind}.case`,
      name: "Case",
      version: "1.0.0",
      author: { name: "T" },
      engine: ">=0.1.0",
      entry: "dist/index.js",
      ...extraManifest,
    }),
  );
  fs.writeFileSync(path.join(dir, "dist", "index.js"), code);

  // A hostile entry cannot be built through the CLI — buildPackage refuses an
  // entry that does not exist, which is a defence in its own right. A real
  // attacker would hand-craft the archive, so the test does too: build a valid
  // package, then rewrite the envelope's manifest entry to the hostile value.
  const bad = String(extraManifest.entry ?? "");
  if (bad.includes("..") || path.isAbsolute(bad)) {
    const clean = fs.mkdtempSync(path.join(os.tmpdir(), "zcms-scancase-"));
    fs.mkdirSync(path.join(clean, "dist"), { recursive: true });
    fs.writeFileSync(
      path.join(clean, manifestFile),
      JSON.stringify({
        id: `vn.test.${kind}.case`,
        name: "Case",
        version: "1.0.0",
        author: { name: "T" },
        engine: ">=0.1.0",
        entry: "dist/index.js",
      }),
    );
    fs.writeFileSync(path.join(clean, "dist", "index.js"), code);
    const built = await buildPackage(clean, kind, publisher.privateKey, publisher.publicKey);
    fs.rmSync(clean, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });

    const opened = await openPackage(built.file);
    opened.envelope.manifest.entry = bad;
    return wrap(opened.envelope, opened.payload);
  }

  const { file } = await buildPackage(dir, kind, publisher.privateKey, publisher.publicKey);
  fs.rmSync(dir, { recursive: true, force: true });
  return file;
}

interface Case {
  name: string;
  kind: "theme" | "plugin";
  code: string;
  manifest?: Record<string, unknown>;
  expect: Verdict;
}

const CASES: Case[] = [
  {
    name: "spawns a shell (child_process)",
    kind: "plugin",
    code: `const cp = require("child_process"); cp.execSync("id");`,
    expect: "reject",
  },
  {
    name: "reads the filesystem (fs)",
    kind: "theme",
    code: `import fs from "fs"; fs.readFileSync("/etc/passwd");`,
    expect: "reject",
  },
  {
    name: "opens a raw socket (net)",
    kind: "plugin",
    code: `const net = require("net"); net.connect(22, "10.0.0.1");`,
    expect: "reject",
  },
  {
    name: "eval of a string",
    kind: "plugin",
    code: `module.exports = { run: () => eval(globalThis.payload) };`,
    expect: "reject",
  },
  {
    name: "Function constructor (sandbox-escape shape)",
    kind: "plugin",
    code: `const f = this.constructor.constructor("return process")(); f.exit();`,
    expect: "reject",
  },
  {
    name: "manifest entry escapes the package",
    kind: "theme",
    code: `export default {};`,
    manifest: { entry: "../../../etc/cron.d/x" },
    expect: "reject",
  },
  {
    name: "plugin declares a core table",
    kind: "plugin",
    code: `module.exports = {};`,
    manifest: { database: { tables: ["contents"] } },
    expect: "reject",
  },
  {
    name: "reads process.env (suspicious, not fatal)",
    kind: "plugin",
    code: `const k = process.env.SECRET_KEY; module.exports = { k };`,
    expect: "flag",
  },
  {
    name: "makes a network request (fetch)",
    kind: "plugin",
    code: `module.exports = { ping: () => fetch("https://evil.example/beacon") };`,
    expect: "flag",
  },
  {
    name: "hides a base64 payload",
    kind: "plugin",
    code: `const p = atob("${"QUJD".repeat(200)}"); module.exports = { p };`,
    expect: "flag",
  },
  {
    name: "a clean plugin passes",
    kind: "plugin",
    code: `module.exports.default = {
      manifest: { id: "x", name: "x", version: "1.0.0", author: { name: "t" }, engine: ">=0.1.0", permissions: [] },
      filters: { "content.seo": (seo, ctx) => ({ ...seo, title: seo.title + " | X" }) },
    };`,
    expect: "pass",
  },
  {
    name: "a clean theme passes",
    kind: "theme",
    code: `export default {
      manifest: {},
      Layout: (p) => p.children,
      templates: { page: (p) => p.content.title },
      blocks: {},
    };`,
    expect: "pass",
  },
];

async function main() {
  console.log("\nScanner verification — feeding the scanner malware and clean code\n");

  for (const testCase of CASES) {
    const file = await packageWith(testCase.kind, testCase.code, testCase.manifest ?? {});
    const report = await scanPackage(file);
    const passed = report.verdict === testCase.expect;

    const top = report.findings[0];
    check(
      testCase.name,
      passed,
      `verdict=${report.verdict} (expected ${testCase.expect})` +
        (top ? ` — ${top.rule}: ${top.message}` : " — no findings"),
    );
  }

  console.log(
    failures === 0
      ? "\nAll scanner checks passed — obvious malware is rejected, clean packages pass.\n"
      : `\n${failures} SCANNER CHECK(S) FAILED.\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

void main();
