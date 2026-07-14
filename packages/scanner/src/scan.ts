import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  classifyPayloadFile,
  openPackage,
  sniffExecutable,
  unpackTo,
  validateManifestIdentity,
  type PackageManifest,
} from "@zcmsorg/package";
import { scanAst } from "./ast";
import { SOURCE_RULES } from "./rules";
import type { Finding, ScanReport, Verdict } from "./types";

/**
 * Statically inspects a package payload and returns a verdict.
 *
 * "Statically" is the whole safety property of this function: it unpacks the
 * archive to a temp directory and READS the files. It never imports, requires,
 * evals, or otherwise runs a byte of what it is scanning. Scanning hostile code
 * must not be a way to run hostile code.
 */

const CODE_EXT = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx"]);

/** A single source line longer than this reads as minified/obfuscated. */
const LONG_LINE = 2000;
/** A source file with a run of this many base64-ish chars is hiding something. */
const BLOB_RE = /[A-Za-z0-9+/]{600,}={0,2}/;

export interface ScanOptions {
  /** Reject anything over this decompressed size (defence-in-depth over the loader). */
  maxUnpackedBytes?: number;
}

export async function scanPackage(
  file: Buffer,
  options: ScanOptions = {},
): Promise<ScanReport> {
  const pkg = await openPackage(file);
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "zcms-scan-"));

  try {
    const written = await unpackTo(pkg.payload, staging);
    const findings: Finding[] = [];
    const scannedFiles: string[] = [];

    findings.push(...checkManifest(pkg.envelope.manifest));

    const manifestFile =
      pkg.envelope.manifest.kind === "theme" ? "theme.json" : "plugin.json";

    let totalBytes = 0;
    for (const rel of written) {
      const abs = path.join(staging, rel);
      const stat = fs.statSync(abs);
      totalBytes += stat.size;

      // WHAT the package contains, before WHAT ITS CODE DOES.
      //
      // `zcms pack` refuses these files too, and that is the friendly half — the
      // author hears it from their own terminal. This is the half that counts.
      // A package arriving here was not necessarily built by our packer, and an
      // author determined to ship an executable is precisely an author who would
      // not use it. The extension is checked, and then the first bytes are, so
      // that renaming the file does not defeat the rule.
      const contents = classifyPayloadFile(rel, manifestFile) ?? sniffExecutable(abs, rel);
      if (contents) {
        findings.push({
          severity: contents.severity,
          rule: contents.rule,
          message: contents.message,
          file: rel,
        });
      }

      if (!CODE_EXT.has(path.extname(rel).toLowerCase())) continue;

      scannedFiles.push(rel);
      const source = fs.readFileSync(abs, "utf8");
      findings.push(...scanSource(rel, source));
    }

    const cap = options.maxUnpackedBytes ?? 50 * 1024 * 1024;
    if (totalBytes > cap) {
      findings.push({
        severity: "block",
        rule: "size",
        message: `Package unpacks to ${(totalBytes / 1024 / 1024).toFixed(1)}MB, over the ${cap / 1024 / 1024}MB limit.`,
        file: "(package)",
      });
    }

    if (scannedFiles.length === 0) {
      findings.push({
        severity: "warn",
        rule: "no-code",
        message: "The package contains no source files the scanner could inspect.",
        file: "(package)",
      });
    }

    return toReport(findings, scannedFiles);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

function scanSource(file: string, source: string): Finding[] {
  const findings: Finding[] = [];
  const lines = source.split("\n");

  // Pattern rules, reported with the first line each matches on.
  for (const rule of SOURCE_RULES) {
    // Fresh lastIndex each file; these are not global regexes, so a plain test is
    // fine, but we want the line number, so scan line by line.
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (rule.pattern.test(line)) {
        findings.push({
          severity: rule.severity,
          rule: rule.rule,
          message: rule.message,
          file,
          line: i + 1,
          excerpt: line.trim().slice(0, 120),
        });
        break; // one finding per rule per file is enough signal
      }
    }
  }

  // Structural heuristics that are not about a specific token.
  const longLine = lines.findIndex((l) => l.length > LONG_LINE);
  if (longLine >= 0) {
    findings.push({
      severity: "warn",
      rule: "minified",
      message: `Contains a ${lines[longLine]!.length}-character line — minified or obfuscated code a human cannot review.`,
      file,
      line: longLine + 1,
    });
  }

  if (BLOB_RE.test(source)) {
    findings.push({
      severity: "warn",
      rule: "embedded-blob",
      message: "Contains a large base64-like blob — a common place to hide a payload.",
      file,
    });
  }

  // Structural pass: catches what the text rules cannot (concatenated module
  // names, computed process access, monkey-patched globals). Additive — its rule
  // ids are distinct from the regex ones, so nothing is double-counted.
  findings.push(...scanAst(file, source));

  return findings;
}

/**
 * Manifest-level checks. These reuse the same permission vocabulary the rest of
 * the platform enforces, so the scan cannot disagree with the gateway about what
 * a permission is.
 */
function checkManifest(manifest: PackageManifest): Finding[] {
  const findings: Finding[] = [];
  const manifestFile = manifest.kind === "theme" ? "theme.json" : "plugin.json";

  // The identity fields — id, name, author, description.
  //
  // These are the strings that go straight into the database and out to every
  // page that renders this package, and until now NOTHING checked them: `accept()`
  // took String(manifest.name) from a file a stranger wrote and put it in a TEXT
  // column with no limit. `zcms pack` refuses them too, which helps the honest
  // author; this is what stops the other kind.
  for (const error of validateManifestIdentity(manifest as unknown as Record<string, unknown>)) {
    findings.push({
      severity: "block",
      rule: "manifest-identity",
      message: error,
      file: manifestFile,
    });
  }

  const entry = String(manifest.entry ?? "");
  if (entry.includes("..") || path.isAbsolute(entry)) {
    findings.push({
      severity: "block",
      rule: "manifest-entry",
      message: `Entry "${entry}" points outside the package.`,
      file: manifest.kind === "theme" ? "theme.json" : "plugin.json",
    });
  }

  // A plugin that declares tables must keep to its own prefix. The authoritative
  // check runs at install time (validatePluginTables); flagging it here means a
  // reviewer sees it before signing rather than after a failed install.
  const database = (manifest as { database?: { tables?: string[] } }).database;
  if (database?.tables?.length) {
    const prefix = `plugin_${slugForPrefix(String(manifest.id))}_`;
    for (const table of database.tables) {
      if (!table.startsWith(prefix)) {
        findings.push({
          severity: "block",
          rule: "manifest-table",
          message: `Declares table "${table}" outside its own prefix "${prefix}".`,
          file: "plugin.json",
        });
      }
    }
  }

  return findings;
}

// Mirrors pluginTablePrefix()'s slug rule without importing plugin-sdk (the
// scanner sits below it in the dependency graph).
function slugForPrefix(id: string): string {
  return id.replace(/[^a-zA-Z0-9]+/g, "_").toLowerCase().replace(/^_+|_+$/g, "");
}

function toReport(findings: Finding[], scannedFiles: string[]): ScanReport {
  const summary = { block: 0, warn: 0, info: 0 };
  for (const f of findings) summary[f.severity]++;

  const verdict: Verdict =
    summary.block > 0 ? "reject" : summary.warn > 0 ? "flag" : "pass";

  // Most severe first, so a caller logging the top line logs the worst thing.
  const order = { block: 0, warn: 1, info: 2 } as const;
  findings.sort((a, b) => order[a.severity] - order[b.severity]);

  return { verdict, findings, scannedFiles, summary };
}
