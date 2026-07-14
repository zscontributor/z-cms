import type { Severity } from "./types";

/**
 * Source-level patterns worth flagging in a package bundle.
 *
 * These describe things a theme or plugin has no legitimate reason to do. A
 * theme renders React; a plugin reacts to events through a scoped context. N
 * either needs to spawn a shell, read the filesystem, open a raw socket, or
 * reconstruct code from a string at runtime.
 *
 * A pattern match is evidence, not proof. `block` rules are for behaviour that
 * is dangerous AND has no benign explanation in this context (spawning a
 * process, reading /etc). `warn` rules are for things that are legitimate
 * sometimes but are also exactly how obfuscated malware hides — a human decides.
 *
 * The regexes run against source text, so string concatenation defeats them.
 * That is expected and is the reason obfuscation is itself a `warn` rule: if a
 * bundle has hidden its strings, the fact that it did so is the finding.
 */

export interface SourceRule {
  rule: string;
  severity: Severity;
  pattern: RegExp;
  message: string;
}

// Node built-ins a sandboxed extension should never reach for. Matched as the
// target of a require()/import so that a substring in a word ("fsync",
// "requests") does not trip the rule.
export const DANGEROUS_MODULES = [
  "child_process",
  "node:child_process",
  "worker_threads",
  "node:worker_threads",
  "vm",
  "node:vm",
  "v8",
  "node:v8",
  "inspector",
  "node:inspector",
  "cluster",
  "node:cluster",
  "net",
  "node:net",
  "dgram",
  "node:dgram",
  "tls",
  "node:tls",
  "http",
  "node:http",
  "https",
  "node:https",
  "dns",
  "node:dns",
  // `module` gives createRequire(), which reconstructs a working require() for
  // every other built-in — the cleanest way around this very list. Block it.
  "module",
  "node:module",
];

// Built-ins that are not escape vectors on their own but leak host detail or
// signal a package doing something it should not. Flagged for a human, not blocked,
// because a bundled library occasionally references one on a dead code path.
export const SUSPICIOUS_MODULES = ["os", "node:os", "process", "node:process"];

function suspiciousModuleRule(mod: string): SourceRule {
  const escaped = mod.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return {
    rule: `host-info:${mod}`,
    severity: "warn",
    pattern: new RegExp(
      `(?:require|import)\\s*\\(\\s*['"\`]${escaped}['"\`]|from\\s*['"\`]${escaped}['"\`]`,
    ),
    message: `Imports the Node built-in "${mod}" — a theme or plugin should not need it.`,
  };
}

function moduleRule(mod: string): SourceRule {
  // require("child_process") | require('node:fs') | from "net" | import("dns")
  const escaped = mod.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return {
    rule: `node-builtin:${mod}`,
    severity: "block",
    pattern: new RegExp(
      `(?:require|import)\\s*\\(\\s*['"\`]${escaped}['"\`]|from\\s*['"\`]${escaped}['"\`]`,
    ),
    message: `Imports the Node built-in "${mod}", which a theme or plugin has no legitimate use for.`,
  };
}

export const SOURCE_RULES: SourceRule[] = [
  ...DANGEROUS_MODULES.map(moduleRule),
  ...SUSPICIOUS_MODULES.map(suspiciousModuleRule),

  // Filesystem is separate: `fs` is sometimes legitimately touched by a theme's
  // build tooling that should NOT have shipped, so it is a strong warn rather
  // than an outright block — but reading it at runtime is the point of the flag.
  {
    rule: "node-builtin:fs",
    severity: "block",
    pattern: /(?:require|import)\s*\(\s*['"`]node:fs['"`]|(?:require|import)\s*\(\s*['"`]fs(?:\/promises)?['"`]|from\s*['"`](?:node:)?fs(?:\/promises)?['"`]/,
    message: 'Imports "fs". Packages must not touch the filesystem directly.',
  },
  {
    rule: "process:spawn",
    severity: "block",
    // Two groups. The first names are effectively unique to child_process, so a
    // word-boundary match is enough. The second — bare `exec`/`fork` — collide
    // with `RegExp.prototype.exec` and the like, so they are matched only when NOT
    // preceded by a `.`: `exec(cmd)` (a destructured child_process call) trips it,
    // `/(\d+)/.exec(v)` does not. A package that reaches child_process THROUGH a
    // property (`cp.exec(...)`) still has to import it, and that import is blocked
    // by the node-builtin rule above — so nothing dangerous slips past here.
    pattern:
      /\b(?:execSync|spawnSync|execFileSync|execFile|spawn)\s*\(|(?<![.\w])(?:exec|fork)\s*\(/,
    message: "Spawns a child process.",
  },
  {
    rule: "eval",
    severity: "block",
    pattern: /\beval\s*\(/,
    message: "Uses eval() to execute a string as code.",
  },
  {
    rule: "function-constructor",
    severity: "block",
    // new Function(...) / Function("return process")() — the classic sandbox escape.
    pattern: /\bnew\s+Function\s*\(|\bFunction\s*\(\s*['"`]/,
    message: "Constructs code at runtime via the Function constructor.",
  },
  {
    rule: "constructor-escape",
    severity: "block",
    // `this.constructor.constructor("...")` — the Function constructor reached by
    // another name, and the exact shape that climbs out of a vm sandbox. Blocked,
    // not merely flagged: there is no benign reason for a theme or plugin to do it.
    pattern: /constructor\s*\.\s*constructor\s*\(/,
    message: "Reconstructs the Function constructor via .constructor.constructor — a sandbox-escape shape.",
  },
  {
    rule: "process-env",
    severity: "warn",
    pattern: /\bprocess\s*\.\s*env\b/,
    message: "Reads process.env. A package must not depend on host environment variables.",
  },
  {
    rule: "process-binding",
    severity: "block",
    pattern: /\bprocess\s*\.\s*(?:binding|_linkedBinding|dlopen)\s*\(/,
    message: "Reaches into process internals (binding/dlopen).",
  },
  {
    rule: "global-process-escape",
    severity: "warn",
    pattern: /\b(?:globalThis|global)\s*\.\s*process\b/,
    message: "Reaches for the host realm's globals — a common sandbox-escape shape.",
  },
  {
    rule: "network-fetch",
    severity: "warn",
    // Deliberately does NOT match `ctx.http.fetch(...)`, which is the sanctioned
    // way out and is bounded by the manifest's declared hosts. What this catches is
    // a package reaching for a network primitive that does not exist in the isolate:
    // either an author who has not read the docs, or code that expects to find
    // itself somewhere with a socket. Both are worth a human's glance, neither is
    // worth a block — the isolate makes the call fail regardless.
    pattern: /(?<!\.http\.)\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\s*\(/,
    message:
      "Reaches for a network primitive. There is no fetch in the sandbox: a plugin " +
      "reaches the outside world through ctx.http.fetch, and only the hosts its " +
      "manifest declares under `network.hosts`.",
  },
  {
    rule: "deobfuscation",
    severity: "warn",
    pattern: /\batob\s*\(|\bBuffer\s*\.\s*from\s*\([^)]*['"`]base64['"`]|\bunescape\s*\(/,
    message: "Decodes data at runtime (base64/unescape) — a common way to hide a payload.",
  },
  {
    rule: "dynamic-require",
    severity: "warn",
    // require(someVariable) rather than a string literal.
    pattern: /\brequire\s*\(\s*(?!['"`])/,
    message: "Calls require() with a computed value, hiding what it loads.",
  },
  {
    rule: "dynamic-import",
    severity: "warn",
    // import(someVariable) / import("child" + "_process") — the ESM sibling of
    // dynamic-require, and previously unmatched: theme bundles are ESM, where a
    // computed import() reaches any built-in past the literal-string rules above.
    // A quoted literal is left to the node-builtin rules; only computed ones flag.
    pattern: /\bimport\s*\(\s*(?!['"`])/,
    message: "Calls import() with a computed value, hiding what it loads.",
  },
  {
    rule: "create-require",
    severity: "block",
    // createRequire(import.meta.url) manufactures a require() inside an ESM bundle
    // — the standard way to reach every built-in the module rules try to deny.
    pattern: /\bcreateRequire\s*\(/,
    message: "Manufactures a require() via createRequire — a way around the module rules.",
  },
];
