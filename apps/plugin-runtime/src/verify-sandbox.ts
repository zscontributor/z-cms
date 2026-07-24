import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runPlugin } from "./sandbox/runner";

/**
 * Attacks the sandbox and asserts it holds.
 *
 * This exists because the first implementation used `node:vm`, looked correct,
 * and was not: a plugin escaped it with `this.constructor.constructor(...)`,
 * read /etc/passwd and ran a shell. Nothing in the code review caught that —
 * only running the attack did.
 *
 * So the attacks live in the repo now, and they run in CI. A sandbox nobody
 * attacks is a sandbox nobody has tested.
 */

interface Case {
  name: string;
  code: string;
  /** The run must fail, or the result must not contain a leak marker. */
  expect: (res: Awaited<ReturnType<typeof runPlugin>>) => boolean;
  detail: (res: Awaited<ReturnType<typeof runPlugin>>) => string;
}

/** A hostile handler whose return value tells us what it managed to reach. */
function hostile(body: string): string {
  return `
    module.exports.default = {
      actions: {
        probe: async function (event, ctx) {
          const results = {};
          const attempt = (name, fn) => {
            try {
              const v = fn();
              // A probe that returns nothing found nothing. Note the string
              // "undefined" too: \`typeof process\` returns a STRING, and reading
              // it as a leak is how this suite once failed itself.
              const empty = v === undefined || v === null || v === "undefined" || v === "";
              results[name] = empty ? "empty" : "LEAKED:" + String(v).slice(0, 40);
            } catch (e) {
              results[name] = "blocked";
            }
          };
          ${body}
          ctx.log.error(JSON.stringify(results));
        }
      }
    };
  `;
}

const leaked = (res: { logs: { message: string }[] }) =>
  res.logs.some((l) => l.message.includes("LEAKED:"));

const CASES: Case[] = [
  {
    name: "node builtins (fs, child_process, net)",
    code: hostile(`
      attempt("fs", () => require("fs").readFileSync("/etc/passwd", "utf8"));
      attempt("child_process", () => require("child_process").execSync("id"));
      attempt("net", () => require("net"));
    `),
    expect: (res) => !leaked(res),
    detail: (res) => res.logs.map((l) => l.message).join(" ").slice(0, 90),
  },
  {
    name: "process, env and globals",
    code: hostile(`
      attempt("process", () => process.pid);
      attempt("env", () => process.env.DATABASE_URL);
      attempt("fetch", () => fetch("http://169.254.169.254/"));
    `),
    expect: (res) => !leaked(res),
    detail: (res) => res.logs.map((l) => l.message).join(" ").slice(0, 90),
  },
  {
    name: "constructor escape (the one node:vm loses to)",
    code: hostile(`
      const F = this.constructor.constructor;
      attempt("escape.process", () => F("return typeof process")());
      attempt("escape.passwd", () => F("return process.mainModule.require('fs').readFileSync('/etc/passwd','utf8')")());
      attempt("escape.shell", () => F("return process.mainModule.require('child_process').execSync('whoami').toString()")());
    `),
    expect: (res) => !leaked(res),
    detail: (res) => res.logs.map((l) => l.message).join(" ").slice(0, 90),
  },
  {
    name: "infinite loop is killed, not tolerated",
    code: `module.exports.default = { actions: { probe: function () { while (true) {} } } };`,
    // Must fail. If this ever "succeeds", the runtime hung and something else is wrong.
    expect: (res) => !res.ok,
    detail: (res) => `${res.ok ? "SURVIVED — runtime hung" : res.error} (${res.durationMs}ms)`,
  },
  {
    name: "memory bomb hits the isolate limit",
    code: `module.exports.default = { actions: { probe: function () {
      const hog = [];
      while (true) { hog.push(new Array(1e6).fill("x")); }
    } } };`,
    expect: (res) => !res.ok,
    detail: (res) => (res.ok ? "SURVIVED — no memory cap" : String(res.error).slice(0, 60)),
  },
  {
    name: "plugin cannot reach the host's own globals",
    code: hostile(`
      attempt("global", () => global.process.env);
      attempt("globalThis.process", () => globalThis.process.pid);
      attempt("Buffer", () => Buffer.from("x"));
    `),
    expect: (res) => !leaked(res),
    detail: (res) => res.logs.map((l) => l.message).join(" ").slice(0, 90),
  },
];

async function main() {
  // The bundles have to exist on disk: the runtime never executes code handed to
  // it over the wire, so the test plants them the way an installer would.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zcms-sandbox-"));
  let failures = 0;

  console.log("\nSandbox verification — attacking the plugin runtime\n");

  for (const [i, testCase] of CASES.entries()) {
    const res = await runPlugin({
      pluginKey: `test-${i}`,
      code: testCase.code,
      invocation: { kind: "action", name: "probe", payload: {} },
      settings: {},
      site: { id: "test", name: "Test", locale: "vi" },
      // A token that would be rejected anyway: these plugins must never get far
      // enough to make a gateway call.
      pluginToken: "invalid",
    });

    const passed = testCase.expect(res);
    if (!passed) failures++;
    console.log(`  ${passed ? "PASS" : "FAIL"}  ${testCase.name}`);
    console.log(`        ${testCase.detail(res)}`);
  }

  fs.rmSync(dir, { recursive: true, force: true });

  console.log(
    failures === 0
      ? "\nAll sandbox checks passed — plugin code is contained.\n"
      : `\n${failures} SANDBOX CHECK(S) FAILED — untrusted plugins are NOT safe to run.\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

void main();
