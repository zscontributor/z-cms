import { describe, it, expect } from "vitest";
import { runPlugin, type Invocation, type RunRequest } from "../runner";

/**
 * These tests run UNTRUSTED plugin source through the REAL `isolated-vm` isolate,
 * the same path a stranger's marketplace plugin takes. Nothing here is mocked:
 * a sandbox that holds against a fake isolate has proven nothing.
 *
 * They complement verify-sandbox.ts (which attacks the built binary end to end)
 * by exercising runner.ts + worker.js per-module, and by asserting the two things
 * the attack suite cannot easily assert: that the HOST stays alive and responsive
 * after each attack, and that the host API exposed to a plugin is EXACTLY the
 * allow-list — no more.
 *
 * The stakes: every escape asserted below, if it regressed, hands an anonymous
 * publisher arbitrary code execution in the runtime process.
 */

const SITE = { id: "test", name: "Test", locale: "vi" };

/** Runs one plugin invocation with the fields a real request would carry. */
function run(code: string, invocation: Invocation, overrides: Partial<RunRequest> = {}) {
  return runPlugin({
    pluginKey: "test-plugin",
    code,
    invocation,
    settings: {},
    site: SITE,
    // A token these plugins must never get far enough to spend.
    pluginToken: "invalid-token",
    ...overrides,
  });
}

/**
 * A filter whose handler probes for an escape and RETURNS what it reached.
 * A filter (unlike an action) passes its handler's return value back to the host,
 * so the result object is our window into what the plugin could touch. `attempt`
 * records "blocked" on throw and "LEAKED:<value>" on any non-empty read — the same
 * discipline verify-sandbox uses, including treating the STRING "undefined" (what
 * `typeof x` yields) as empty rather than as a leak.
 */
function probeFilter(body: string): string {
  return `
    module.exports.default = {
      filters: {
        probe: async function (value, context, ctx) {
          const results = {};
          const attempt = (name, fn) => {
            try {
              const v = fn();
              const empty = v === undefined || v === null || v === "undefined" || v === "";
              results[name] = empty ? "empty" : "LEAKED:" + String(v).slice(0, 40);
            } catch (e) {
              results[name] = "blocked";
            }
          };
          ${body}
          return results;
        }
      }
    };
  `;
}

const PROBE: Invocation = { kind: "filter", name: "probe", value: {}, context: {} };

/** True if any probe reported a leak. Any single leak fails the test. */
function leaked(result: unknown): boolean {
  return Object.values((result ?? {}) as Record<string, string>).some((v) =>
    String(v).startsWith("LEAKED:"),
  );
}

describe("runPlugin", () => {
  it("runs a benign filter and returns the value it produced", async () => {
    // The happy path: a real plugin transforms the value it is given and the host
    // gets the transformed value back.
    const code = `
      module.exports.default = {
        filters: { uppercase: (value) => String(value).toUpperCase() }
      };
    `;

    const res = await run(code, { kind: "filter", name: "uppercase", value: "hello", context: {} });

    expect(res.ok).toBe(true);
    expect(res.result).toBe("HELLO");
  });

  it("surfaces a plugin's logs to the host", async () => {
    // ctx.log is part of the contract; the host collects the lines for the audit
    // trail. If logging broke, an operator would lose their only view into a plugin.
    const code = `
      module.exports.default = {
        filters: { note: (value, context, ctx) => { ctx.log.info("hi from plugin"); return value; } }
      };
    `;

    const res = await run(code, { kind: "filter", name: "note", value: 1, context: {} });

    expect(res.ok).toBe(true);
    expect(res.logs).toContainEqual({ level: "info", message: "hi from plugin" });
  });

  it("passes a filter's value through untouched when the plugin has no such handler", async () => {
    // A plugin installing must never blank out a page's metadata just by not
    // handling a filter. The value has to survive.
    const code = `module.exports.default = { filters: {} };`;

    const res = await run(code, { kind: "filter", name: "missing", value: "keep-me", context: {} });

    expect(res.ok).toBe(true);
    expect(res.result).toBe("keep-me");
  });

  it("kills a plugin that loops forever instead of hanging the host", async () => {
    // If this regressed, one hostile plugin would wedge the runtime's event loop
    // and take down every site it serves. A filter's 800ms budget keeps it quick.
    const code = `module.exports.default = { filters: { probe: () => { while (true) {} } } };`;

    const res = await run(code, PROBE);

    expect(res.ok).toBe(false);
  });

  it("stays responsive after a plugin tried to loop forever", async () => {
    // The point of killing the loop is that the NEXT plugin still runs. Prove the
    // host survived by running a benign plugin right after and getting its answer.
    await run(
      `module.exports.default = { filters: { probe: () => { while (true) {} } } };`,
      PROBE,
    );

    const res = await run(
      `module.exports.default = { filters: { echo: (v) => v } };`,
      { kind: "filter", name: "echo", value: "still-alive", context: {} },
    );

    expect(res.ok).toBe(true);
    expect(res.result).toBe("still-alive");
  });

  it("kills a plugin that allocates memory without bound instead of taking the host with it", async () => {
    // A memory bomb must hit the isolate's own cap and die there. Without the cap,
    // the plugin would OOM the runtime process and every tenant on it.
    const code = `
      module.exports.default = {
        filters: { probe: () => {
          const hog = [];
          while (true) { hog.push(new Array(1e6).fill("x")); }
        } }
      };
    `;

    const res = await run(code, PROBE);

    expect(res.ok).toBe(false);
  });

  it("stays responsive after a plugin tried to exhaust memory", async () => {
    // Same contract as the loop: the isolate dies, the host lives, the next plugin runs.
    await run(
      `module.exports.default = { filters: { probe: () => { const h=[]; while(true){h.push(new Array(1e6).fill("x"));} } } };`,
      PROBE,
    );

    const res = await run(
      `module.exports.default = { filters: { echo: (v) => v } };`,
      { kind: "filter", name: "echo", value: "survived-oom", context: {} },
    );

    expect(res.ok).toBe(true);
    expect(res.result).toBe("survived-oom");
  });

  it("returns a clean error when a plugin throws rather than crashing the host", async () => {
    // A throwing plugin is a routine event, not an incident. The host must get a
    // reported failure and keep running.
    const code = `
      module.exports.default = {
        filters: { probe: () => { throw new Error("boom from plugin"); } }
      };
    `;

    const res = await run(code, PROBE);

    expect(res.ok).toBe(false);
    expect(res.error).toContain("boom from plugin");
  });

  it("refuses the classic node:vm escape this.constructor.constructor('return process')()", async () => {
    // THE escape that broke the original node:vm implementation: reach the Function
    // constructor and compile code in the host realm. In a real isolate there is no
    // host realm to reach — the compiled code sees the isolate's own globals only.
    const code = probeFilter(`
      const F = (function(){}).constructor;
      attempt("escape.process", () => F("return typeof process")());
      attempt("escape.ctor.process", () => this.constructor.constructor("return typeof process")());
      attempt("escape.passwd", () => F("return process.mainModule.require('fs').readFileSync('/etc/passwd','utf8')")());
    `);

    const res = await run(code, PROBE);

    expect(res.ok).toBe(true);
    expect(leaked(res.result)).toBe(false);
  });

  it("gives a plugin no reference to process, global, or globalThis.process", async () => {
    // If any of these resolved, the plugin would read DATABASE_URL / storage keys
    // straight out of the host's environment.
    const code = probeFilter(`
      attempt("process", () => process.pid);
      attempt("process.env", () => process.env.DATABASE_URL);
      attempt("global", () => global.process.env);
      attempt("globalThis.process", () => globalThis.process.pid);
    `);

    const res = await run(code, PROBE);

    expect(res.ok).toBe(true);
    expect(leaked(res.result)).toBe(false);
  });

  it("gives a plugin no require, so it cannot pull in fs, child_process, or net", async () => {
    // require exists in the sandbox but resolves exactly one specifier. Everything
    // else — the filesystem, a shell, a raw socket — must be refused.
    const code = probeFilter(`
      attempt("fs", () => require("fs").readFileSync("/etc/passwd", "utf8"));
      attempt("child_process", () => require("child_process").execSync("id").toString());
      attempt("net", () => require("net"));
    `);

    const res = await run(code, PROBE);

    expect(res.ok).toBe(true);
    expect(leaked(res.result)).toBe(false);
  });

  it("gives a plugin no dynamic import() to smuggle a module in", async () => {
    // import() is the other module loader; if it resolved a Node builtin the require
    // block would be moot. The isolate has no dynamic-import callback, so import()
    // is refused outright ("Not supported") and the run fails cleanly — the plugin
    // never gets the module, and the host gets a string error, not a crash.
    const code = `
      module.exports.default = { filters: { probe: () => import("fs") } };
    `;

    const res = await run(code, PROBE);

    expect(res.ok).toBe(false);
    expect(typeof res.error).toBe("string");
    // And the refusal did not take the host down: the next plugin still runs.
    const after = await run(
      `module.exports.default = { filters: { echo: (v) => v } };`,
      { kind: "filter", name: "echo", value: "alive", context: {} },
    );
    expect(after.result).toBe("alive");
  });

  it("confines eval to the isolate: eval'd code cannot see host globals either", async () => {
    // eval runs inside the isolate. That is fine as long as what it evaluates is
    // ALSO trapped — an attacker must not be able to launder an escape through eval.
    const code = probeFilter(`
      attempt("eval.process", () => eval("typeof process"));
      attempt("eval.ctor", () => eval("(function(){}).constructor('return typeof process')()"));
    `);

    const res = await run(code, PROBE);

    expect(res.ok).toBe(true);
    expect(leaked(res.result)).toBe(false);
  });

  it("gives a plugin no way to open a network socket", async () => {
    // No fetch, no XHR, no WebSocket, no net — a plugin that could reach the network
    // could hit the cloud metadata endpoint or exfiltrate whatever it read.
    const code = probeFilter(`
      attempt("fetch", () => fetch("http://169.254.169.254/"));
      attempt("XMLHttpRequest", () => new XMLHttpRequest());
      attempt("WebSocket", () => new WebSocket("ws://example.com"));
    `);

    const res = await run(code, PROBE);

    expect(res.ok).toBe(true);
    expect(leaked(res.result)).toBe(false);
  });

  it("gives a plugin no Buffer, so it cannot reach Node's realm through it", async () => {
    // Buffer is a Node global, not a JS one; its presence would mean the isolate
    // leaked a host constructor.
    const code = probeFilter(`
      attempt("Buffer", () => Buffer.from("x"));
    `);

    const res = await run(code, PROBE);

    expect(res.ok).toBe(true);
    expect(leaked(res.result)).toBe(false);
  });

  it("does not let one plugin see state a previous plugin left on the global object", async () => {
    // Two plugins, back to back. The first writes a marker onto its globalThis; the
    // second reads it. If the second saw it, plugins would share a realm and could
    // read each other's secrets. Each run must get a fresh, isolated global.
    await run(
      `module.exports.default = { filters: { probe: () => { globalThis.__leak = "secret-from-A"; return 1; } } };`,
      PROBE,
    );

    const res = await run(
      probeFilter(`attempt("cross", () => globalThis.__leak);`),
      PROBE,
    );

    expect(res.ok).toBe(true);
    expect(leaked(res.result)).toBe(false);
  });

  it("exposes to the plugin exactly the ctx allow-list and nothing more", async () => {
    // The host API is a promise: THESE capabilities, no others. If a future change
    // widened ctx (say it started handing the plugin a raw fetch or a db handle),
    // this test fails and forces that decision to be deliberate.
    const code = `
      module.exports.default = {
        filters: { probe: (value, context, ctx) => ({
          ctx: Object.keys(ctx).sort(),
          storage: Object.keys(ctx.storage).sort(),
          content: Object.keys(ctx.content).sort(),
          jobs: Object.keys(ctx.jobs).sort(),
          log: Object.keys(ctx.log).sort(),
          mail: Object.keys(ctx.mail).sort(),
          http: Object.keys(ctx.http).sort(),
        }) }
      };
    `;

    const res = await run(code, PROBE);

    expect(res.ok).toBe(true);
    expect(res.result).toEqual({
      // `secrets` is booleans, never values: "is the OpenAI key configured?" is
      // answerable in here, "what is it?" is not. See the settings test below.
      ctx: ["content", "http", "jobs", "log", "mail", "secrets", "settings", "site", "storage"],
      storage: ["delete", "get", "list", "set"],
      content: ["get", "list"],
      jobs: ["enqueue"],
      log: ["error", "info", "warn"],
      // ctx.mail lets a plugin send mail through the host — gated by the
      // mail:send permission, and routed over RPC like every other host call.
      mail: ["send"],
      // ctx.http is NOT a fetch. It is one more RPC: the plugin describes a
      // request and the host makes it, gated by network:fetch and bounded by the
      // hosts the manifest declared. The test below proves there is no socket
      // under it — the same test that proves there is none under ctx.storage.
      http: ["fetch"],
    });
  });

  it("routes a plugin's ctx.storage call out through the host, not through the plugin", async () => {
    // The plugin has no socket: ctx.storage.get becomes an RPC that the HOST turns
    // into a gateway call with the scoped token. Here cms-api is unreachable, so the
    // call fails — but it fails on the HOST's side of the boundary, and the plugin
    // only ever sees a rejected promise. This exercises the runner's rpc path end to
    // end (worker -> runner.callGateway -> rpc-result -> worker) with no mock.
    process.env.CMS_API_URL = "http://127.0.0.1:1"; // nothing listens here
    const code = `
      module.exports.default = {
        filters: { probe: async (value, context, ctx) => {
          try { await ctx.storage.get("k"); return "unexpected-success"; }
          catch (e) { return "rpc-refused"; }
        } }
      };
    `;

    const res = await run(code, PROBE);

    expect(res.ok).toBe(true);
    expect(res.result).toBe("rpc-refused");
  });

  it("gives ctx.http no socket of its own: it is an RPC like every other host call", async () => {
    // The one that matters for network:fetch. `ctx.http.fetch` looks like a network
    // client, so it is worth proving it is not one: the isolate cannot dial, and
    // this call does not become a connection to api.deepl.com — it becomes an RPC to
    // cms-api, which is the process that checks the manifest's host list and then
    // opens a socket of its own. Point the gateway at a dead port and the plugin's
    // fetch fails on the HOST's side of the boundary, exactly like ctx.storage does.
    //
    // If someone ever "optimises" this by handing the isolate a real fetch, this
    // test goes green on the wrong reason — so it asserts the plugin got a REJECTION,
    // not a response.
    process.env.CMS_API_URL = "http://127.0.0.1:1"; // nothing listens here
    const code = `
      module.exports.default = {
        filters: { probe: async (value, context, ctx) => {
          try {
            await ctx.http.fetch({ url: "https://api.deepl.com/v2/translate" });
            return "unexpected-success";
          } catch (e) { return "rpc-refused"; }
        } }
      };
    `;

    const res = await run(code, PROBE);

    expect(res.ok).toBe(true);
    expect(res.result).toBe("rpc-refused");
  });

  it("hands the plugin its settings and site as data, not as a shared host object", async () => {
    // The plugin gets a JSON copy of settings/site. It must see the values, and
    // (implied by them crossing as strings) cannot hold a reference that mutates
    // the host's copy.
    const code = `
      module.exports.default = {
        filters: { probe: (value, context, ctx) => ({ locale: ctx.site.locale, tone: ctx.settings.tone }) }
      };
    `;

    const res = await run(code, PROBE, { settings: { tone: "formal" } });

    expect(res.ok).toBe(true);
    expect(res.result).toEqual({ locale: "vi", tone: "formal" });
  });
});
