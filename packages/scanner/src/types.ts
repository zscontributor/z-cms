/**
 * What a scan finds, and what the marketplace does about it.
 *
 * Severity maps directly to an outcome, so there is no separate policy layer to
 * disagree with the findings:
 *
 *   block  → the package is REJECTED. Never signed, never stored.
 *   warn   → the package is QUARANTINED: signed and stored, but not runnable
 *            until a human reviews it. Suspicious, not proven hostile.
 *   info   → recorded on the report, no effect on the outcome.
 *
 * Be honest about what this is. Static analysis of JavaScript is heuristic: it
 * is trivially defeated by enough indirection, and it is not the thing that
 * keeps a hostile plugin contained — the isolated-vm sandbox is. The scanner
 * exists to catch the obvious, to make obfuscation itself a red flag, and to
 * cut down what a human reviewer has to read. It is a filter, not a guarantee.
 *
 * It matters MORE for themes than for plugins, and that is worth stating plainly:
 * a plugin runs in a V8 isolate with no `require` and no `process`, but a theme
 * is imported straight into the site-runtime Node process. A malicious theme is
 * far less contained than a malicious plugin, so the scan is the main line of
 * defence there, not a secondary one.
 */

export type Severity = "block" | "warn" | "info";

export interface Finding {
  severity: Severity;
  /** Stable identifier for the rule, e.g. "node-builtin:child_process". */
  rule: string;
  message: string;
  /** File inside the package, relative to its root. */
  file: string;
  line?: number;
  /** The offending snippet, trimmed. */
  excerpt?: string;
}

export type Verdict = "pass" | "flag" | "reject";

export interface ScanReport {
  verdict: Verdict;
  findings: Finding[];
  /** Files the scanner actually inspected. */
  scannedFiles: string[];
  summary: {
    block: number;
    warn: number;
    info: number;
  };
}
