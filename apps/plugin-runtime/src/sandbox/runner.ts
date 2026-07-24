import fs from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { callGateway } from "../gateway-client";

export interface Invocation {
  kind: "action" | "job" | "call" | "filter" | "setup";
  name?: string;
  payload?: unknown;
  value?: unknown;
  context?: unknown;
}

export interface RunRequest {
  pluginKey: string;
  code: string;
  invocation: Invocation;
  settings: Record<string, unknown>;
  /** Declared secret name -> is it configured. Booleans only; never a value. */
  secrets?: Record<string, boolean>;
  site: { id: string; name: string; locale: string };
  /** Scoped, short-lived token the host uses on the plugin's behalf. */
  pluginToken: string;
}

export interface RunResult {
  ok: boolean;
  result?: unknown;
  error?: string;
  durationMs: number;
  logs: { level: string; message: string }[];
}

/**
 * Hard limits. These are the numbers that decide whether a bad plugin is an
 * incident or a log line.
 */
const MEMORY_LIMIT_MB = 64;
/**
 * Filters run in the page-render path, so they get a much tighter budget.
 *
 * `call` gets the job budget rather than the action one: a call exists so a plugin
 * can BE a service (reach an AI provider through `ctx.http` and hand back the
 * answer), and a round trip to a third party costs seconds. Nothing is rendering a
 * page while it waits — which is precisely why it may be slow and a filter may not.
 */
const TIMEOUT_MS = {
  action: 5_000,
  job: 30_000,
  call: 30_000,
  filter: 800,
  setup: 10_000,
} as const;
/** The worker is killed at this point whether or not it agrees to stop. */
const KILL_GRACE_MS = 500;

const WORKER_PATH = path.join(__dirname, "worker.js");

// A missing worker must be a loud crash, not a silent one.
//
// It was silent once: the verification suite ran under tsx (where __dirname is
// src/, so worker.js does not exist), every run failed to spawn, and every check
// that asserted "this must fail" passed for the wrong reason. The suite reported
// a fully contained sandbox while testing nothing at all. Fail fast instead.
if (!fs.existsSync(WORKER_PATH)) {
  throw new Error(
    `Sandbox worker not found at ${WORKER_PATH}. ` +
      `plugin-runtime must be built (pnpm --filter @zcmsorg/plugin-runtime build) ` +
      `before plugins can be executed — running from TypeScript sources will not work.`,
  );
}

export async function runPlugin(req: RunRequest): Promise<RunResult> {
  const started = Date.now();
  const logs: { level: string; message: string }[] = [];
  const handlerTimeoutMs = TIMEOUT_MS[req.invocation.kind];

  return new Promise<RunResult>((resolve) => {
    let settled = false;

    const worker = new Worker(WORKER_PATH, {
      workerData: {
        code: req.code,
        pluginKey: req.pluginKey,
        invocation: req.invocation,
        settings: req.settings,
        secrets: req.secrets ?? {},
        site: req.site,
        handlerTimeoutMs,
      },
      // Defence in depth. The isolate already denies the plugin any reference to
      // `process`, but if that ever failed, an empty env means there is nothing
      // in it worth stealing — and the runtime process holds no credentials
      // regardless.
      env: {},
      // No --experimental flags, no inspector, no preloaded modules.
      execArgv: [],
      resourceLimits: {
        maxOldGenerationSizeMb: MEMORY_LIMIT_MB,
        maxYoungGenerationSizeMb: 16,
        // A plugin cannot spawn its own workers to escape the limits above.
        maxWorkerCount: 0,
      } as never,
      stdout: true,
      stderr: true,
    });

    const finish = (result: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(killer);
      void worker.terminate();
      resolve({ ...result, durationMs: Date.now() - started, logs });
    };

    // The worker's own deadline should fire first. This one is the backstop for
    // a handler that manages to block the event loop so hard it never runs.
    const killer = setTimeout(() => {
      finish({
        ok: false,
        error: `Plugin "${req.pluginKey}" was killed after ${handlerTimeoutMs + KILL_GRACE_MS}ms.`,
        durationMs: 0,
        logs,
      });
    }, handlerTimeoutMs + KILL_GRACE_MS);

    worker.on("message", (msg: Record<string, unknown>) => {
      switch (msg.type) {
        case "log":
          logs.push({ level: String(msg.level), message: String(msg.message) });
          return;

        case "rpc": {
          // The plugin asked for something. The host — not the plugin — makes the
          // call, using the scoped token, and cms-api re-checks the scope.
          const id = msg.id as number;
          void callGateway(
            req.pluginToken,
            String(msg.method),
            (msg.params ?? {}) as Record<string, unknown>,
          )
            .then((data) => worker.postMessage({ type: "rpc-result", id, ok: true, data }))
            .catch((err: Error) =>
              worker.postMessage({ type: "rpc-result", id, ok: false, error: err.message }),
            );
          return;
        }

        case "done":
          finish({ ok: true, result: msg.result, durationMs: 0, logs });
          return;

        case "failed":
          finish({ ok: false, error: String(msg.error), durationMs: 0, logs });
          return;
      }
    });

    worker.on("error", (err) => {
      // Includes the memory limit being hit: V8 kills the isolate and the worker
      // surfaces it here rather than taking the process with it.
      finish({ ok: false, error: err.message, durationMs: 0, logs });
    });

    worker.on("exit", (code) => {
      if (!settled) {
        finish({ ok: false, error: `Plugin worker exited with code ${code}.`, durationMs: 0, logs });
      }
    });
  });
}
