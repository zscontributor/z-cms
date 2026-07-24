import ivm from "isolated-vm";
import { parentPort, workerData } from "node:worker_threads";

/**
 * Runs ONE plugin handler, once, in a real V8 isolate, then dies.
 *
 * Why `isolated-vm` and not `node:vm`:
 *
 * `node:vm` is not a security boundary and never claimed to be. A plugin can
 * climb out of a vm context with `this.constructor.constructor("return process")()`
 * and land in the host realm. We built it that way first and then attacked it —
 * the escape worked, and the escaped code read /etc/passwd and ran `whoami`.
 * Empty `env` meant it found no DATABASE_URL, but arbitrary code execution in
 * the runtime process is not something to mitigate; it is something to prevent.
 *
 * `isolated-vm` gives the plugin its own V8 isolate: a separate heap with no
 * reference whatsoever to Node's realm. There is no `process` to escape *to*.
 * The same attack now returns "process is not defined", which is the answer we
 * want from a marketplace where anyone can publish.
 *
 * Three layers, in order of who catches what:
 *   1. the isolate      — no Node globals, no require, no filesystem, no sockets
 *   2. memory + timeout — a bomb or an infinite loop kills the isolate
 *   3. the worker       — the host terminates it if it ignores its own deadline
 *
 * And regardless of all three: the runtime process holds no database credentials
 * and no storage keys, and the plugin's token grants only the scopes an admin
 * approved. Depth, not a single wall.
 */

interface WorkerInput {
  code: string;
  pluginKey: string;
  invocation:
    | { kind: "action"; name: string; payload: unknown }
    | { kind: "job"; name: string; payload: unknown }
    | { kind: "call"; name: string; payload: unknown }
    | { kind: "filter"; name: string; value: unknown; context: unknown }
    | { kind: "setup" };
  settings: Record<string, unknown>;
  /** Declared secret name -> is it configured. Booleans only; never a value. */
  secrets: Record<string, boolean>;
  site: { id: string; name: string; locale: string };
  handlerTimeoutMs: number;
}

const input = workerData as WorkerInput;
const port = parentPort!;

const MEMORY_LIMIT_MB = 64;

// --- RPC back to the host -------------------------------------------------
// The plugin has no socket and no token. It calls a host function; the host
// makes the real request to cms-api with the plugin's scoped token, and cms-api
// re-checks the scope on the far side of the trust boundary.

let nextRpcId = 1;
const pending = new Map<
  number,
  { resolve: (v: unknown) => void; reject: (e: Error) => void }
>();

port.on(
  "message",
  (msg: { type: string; id: number; ok: boolean; data?: unknown; error?: string }) => {
    if (msg.type !== "rpc-result") return;
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    if (msg.ok) entry.resolve(msg.data);
    else entry.reject(new Error(msg.error ?? "Plugin API call failed."));
  },
);

function hostRpc(method: string, paramsJson: string): Promise<string> {
  const id = nextRpcId++;
  const params = JSON.parse(paramsJson || "{}") as Record<string, unknown>;

  return new Promise<string>((resolve, reject) => {
    pending.set(id, {
      // Values cross the isolate boundary as JSON. Nothing structured, and
      // certainly no function or object reference, is ever handed to plugin code.
      resolve: (data) => resolve(JSON.stringify(data ?? null)),
      reject,
    });
    port.postMessage({ type: "rpc", id, method, params });
  });
}

function hostLog(level: string, message: string): void {
  port.postMessage({ type: "log", level, message });
}

/**
 * The code that runs INSIDE the isolate. It builds the plugin context out of the
 * two host functions above, loads the plugin as a CommonJS module with a require
 * that resolves exactly one specifier, and dispatches the requested handler.
 */
const BOOTSTRAP = `
(async function () {
  const parse = (s) => JSON.parse(s);

  const rpc = async (method, params) => parse(await __rpc(method, JSON.stringify(params || {})));

  const ctx = {
    settings: parse(__settings),
    // Booleans, not values. "Is the OpenAI key configured?" is answerable in the
    // sandbox; "what is it?" is not, and never crosses this boundary.
    secrets: parse(__secrets),
    site: parse(__site),
    log: {
      info:  (m) => __log("info",  String(m)),
      warn:  (m) => __log("warn",  String(m)),
      error: (m) => __log("error", String(m)),
    },
    storage: {
      get:    (key)        => rpc("storage.get",    { key }),
      set:    (key, value) => rpc("storage.set",    { key, value }),
      delete: (key)        => rpc("storage.delete", { key }),
      list:   (prefix)     => rpc("storage.list",   { prefix }),
    },
    content: {
      get:  (contentId) => rpc("content.get",  { contentId }),
      list: (query)     => rpc("content.list", { query: query || {} }),
    },
    jobs: {
      enqueue: (name, payload) => rpc("jobs.enqueue", { name, payload }),
    },
    mail: {
      // No host, no port, no credential, and no "from" — the plugin hands over a
      // letter, and the host addresses the envelope. Resolves when the mail is
      // accepted onto the queue, not when it lands: SMTP takes seconds and this
      // handler has five.
      send: (message) => rpc("mail.send", { message }),
    },
    http: {
      // Note what this is NOT: it is not \`fetch\`, and there is no socket under it.
      // The isolate has no network stack to reach, so this is the same RPC as
      // every other line above — a request DESCRIPTION crossing to the host as
      // JSON. cms-api checks the URL's host against the manifest of the installed
      // version, resolves it, refuses private addresses, substitutes any
      // {{secret:...}} out of settings the plugin was never given, and only then
      // opens a socket of its own.
      fetch: (request) => rpc("http.fetch", { request }),
    },
  };

  // The only module a plugin may load. definePlugin is an identity function and
  // the rest of the SDK is types, so this shim IS the runtime SDK.
  const require = (specifier) => {
    if (specifier === "@zcmsorg/plugin-sdk") {
      return {
        definePlugin: (p) => p,
        resolvePluginSettings: (schema, stored) => {
          const out = {};
          for (const key of Object.keys((schema && schema.properties) || {})) {
            const v = stored ? stored[key] : undefined;
            out[key] = (v === undefined || v === null) ? schema.properties[key].default : v;
          }
          return out;
        },
      };
    }
    throw new Error('Plugin tried to require("' + specifier + '"). Only "@zcmsorg/plugin-sdk" exists in the sandbox.');
  };

  const module = { exports: {} };
  const exports = module.exports;
  const console = ctx.log;

  (function (module, exports, require, console) {
    __PLUGIN_CODE__
  })(module, exports, require, console);

  const plugin = module.exports.default || module.exports;
  const invocation = parse(__invocation);

  if (invocation.kind === "setup") {
    if (!plugin.setup) return JSON.stringify(null);
    await plugin.setup(ctx);
    return JSON.stringify(null);
  }

  if (invocation.kind === "action") {
    const handler = plugin.actions && plugin.actions[invocation.name];
    if (!handler) return JSON.stringify(null);
    await handler(invocation.payload, ctx);
    return JSON.stringify(null);
  }

  if (invocation.kind === "job") {
    const handler = plugin.jobs && plugin.jobs[invocation.name];
    if (!handler) return JSON.stringify(null);
    await handler(invocation.payload, ctx);
    return JSON.stringify(null);
  }

  if (invocation.kind === "call") {
    const handler = plugin.calls && plugin.calls[invocation.name];
    // The one invocation whose ABSENCE is an error rather than a no-op. An action
    // nobody handles is a plugin that does not care about that event; a call nobody
    // handles is a caller left waiting for an answer that is never coming, and it
    // should hear why.
    if (!handler) {
      throw new Error('This plugin has no call handler named "' + invocation.name + '".');
    }
    return JSON.stringify(await handler(invocation.payload, ctx));
  }

  const handler = plugin.filters && plugin.filters[invocation.name];
  // A filter with no handler passes the value through untouched. Installing a
  // plugin must never be able to blank out a page's metadata.
  if (!handler) return JSON.stringify(invocation.value);
  const result = await handler(invocation.value, invocation.context, ctx);
  return JSON.stringify(result === undefined ? invocation.value : result);
})()
`;

async function main(): Promise<unknown> {
  const isolate = new ivm.Isolate({ memoryLimit: MEMORY_LIMIT_MB });

  try {
    const context = await isolate.createContext();
    const jail = context.global;

    // Inputs cross as strings. A plugin cannot mutate the host's objects because
    // it never receives one.
    await jail.set("__settings", JSON.stringify(input.settings));
    await jail.set("__secrets", JSON.stringify(input.secrets ?? {}));
    await jail.set("__site", JSON.stringify(input.site));
    await jail.set("__invocation", JSON.stringify(input.invocation));

    await jail.set(
      "__rpc",
      new ivm.Reference(hostRpc),
      // Not exposed raw: wrapped below so the isolate sees a plain async function
      // rather than a Reference it could poke at.
    );
    await jail.set("__log", new ivm.Reference(hostLog));

    await context.eval(`
      const __rpcRef = __rpc, __logRef = __log;
      globalThis.__rpc = (method, params) =>
        __rpcRef.apply(undefined, [method, params], { result: { promise: true, copy: true } });
      globalThis.__log = (level, message) =>
        __logRef.applyIgnored(undefined, [level, message]);
    `);

    // Plugin source is injected as source text, not evaluated in the host.
    const script = BOOTSTRAP.replace("__PLUGIN_CODE__", input.code);

    const json = (await context.eval(script, {
      // Bounds synchronous execution inside the isolate. Async work is bounded
      // by the deadline below and, in the last resort, by the host killing us.
      timeout: input.handlerTimeoutMs,
      promise: true,
      copy: true,
    })) as string;

    return JSON.parse(json ?? "null");
  } finally {
    // Frees the isolate's heap immediately rather than waiting on GC. A plugin
    // that allocated 60MB does not keep holding it after its hook returned.
    isolate.dispose();
  }
}

const deadline = new Promise<never>((_, reject) =>
  setTimeout(
    () => reject(new Error(`Plugin handler exceeded ${input.handlerTimeoutMs}ms.`)),
    input.handlerTimeoutMs,
  ).unref(),
);

Promise.race([main(), deadline])
  .then((result) => port.postMessage({ type: "done", result }))
  .catch((err: Error) =>
    port.postMessage({ type: "failed", error: err.message, stack: err.stack }),
  );
