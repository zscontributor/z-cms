import { Worker } from "node:worker_threads";
import path from "node:path";
import fs from "node:fs";

/**
 * Owns the theme workers, and kills them when they will not stop.
 *
 * One worker per `key@version`, kept warm and reused. That shape falls out of the
 * measurements rather than taste: a cold worker costs 118ms (spawn + React, mostly)
 * and a warm render costs 1.16ms. Per-render workers would put 118ms on every page
 * on the site to defend against a theme that is almost never hostile. One warm
 * worker serves ~860 renders/second — more than a single site-runtime replica will
 * ever ask of one theme — so requests for a theme queue on that theme's worker and
 * the queue is not the bottleneck.
 *
 * Queueing per theme is also the isolation story, not a side effect. A theme that
 * loops blocks the worker holding it, and nothing else: every other theme has its
 * own worker on its own thread, and their tenants render normally throughout. The
 * old failure mode — one theme, every tenant down — is not reachable from here.
 *
 * What the caller must still do: treat `ok: false` as "render the built-in default",
 * never as "show an error page". A theme failing is not the visitor's problem.
 */

const DEFAULT_RENDER_TIMEOUT_MS = 2_000;

/**
 * The deadline covers the queue, not just the render.
 *
 * It has to. Requests for one theme are serialised on one worker, so a request that
 * arrives while a previous one is looping would otherwise wait out the killer's
 * timer AND then start its own — two deadlines deep for one hostile theme. Timing
 * from enqueue means every request gets the same promise: an answer within the
 * budget, whatever the theme is doing.
 */
export interface RenderRequest {
  key: string;
  version: string;
  entryPath: string;
  assetBase: string;
  template: string;
  payload: unknown;
  content: unknown;
  timeoutMs?: number;
}

export type RenderResult =
  | { ok: true; html: string; durationMs: number }
  | { ok: false; error: string; durationMs: number; killed: boolean };

interface Pending {
  resolve: (r: RenderResult) => void;
  startedAt: number;
  timer: NodeJS.Timeout;
}

interface ThemeWorker {
  worker: Worker;
  pending: Map<number, Pending>;
  nextId: number;
}

const workers = new Map<string, ThemeWorker>();

/**
 * Finds the BUILT worker, from wherever this module is running.
 *
 * A Worker is spawned by path, so it needs JavaScript on disk — `src/worker.ts` is
 * not something Node can run. Two callers, two answers: shipped, this module is
 * `dist/runner.js` and the worker is its neighbour; under vitest it is `src/runner.ts`
 * and the worker is at `../dist/worker.js`, which means the suite tests the same
 * built artefact production loads rather than a parallel one.
 *
 * A miss must be a loud crash, never a silent fallback. plugin-runtime learned this
 * the expensive way: under tsx `__dirname` was src/, every spawn failed, and every
 * "this attack must fail" check passed for the wrong reason — a suite reporting a
 * sealed sandbox while testing nothing at all. Here the same slip would be quieter
 * still: every render would "fail" and degrade to the built-in default, so the site
 * would look fine while no theme rendered ever again.
 */
function workerPath(): string {
  const candidates = [
    path.join(__dirname, "worker.js"),
    path.join(__dirname, "..", "dist", "worker.js"),
  ];
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) {
    throw new Error(
      `Theme worker not found (looked in ${candidates.join(", ")}). ` +
        `@zcmsorg/theme-runner must be built (pnpm --filter @zcmsorg/theme-runner build) ` +
        `before a theme can render; running from TypeScript sources alone will not work.`,
    );
  }
  return found;
}

function spawn(cacheKey: string, req: RenderRequest): ThemeWorker {
  const worker = new Worker(workerPath(), {
    workerData: { entryPath: req.entryPath, assetBase: req.assetBase },

    // EMPTY, and load-bearing. site-runtime's own process.env holds
    // SITE_RUNTIME_INTERNAL_TOKEN, the render token cms-api accepts. A theme
    // rendering in-process can read it out of process.env today; a theme rendering
    // here finds nothing to read. This is the one confidentiality win the thread
    // buys, and it is free.
    env: {},
    execArgv: [],

    resourceLimits: {
      // Bounds the memory bomb: the isolate dies, `worker.on("error")` reports it,
      // and site-runtime keeps serving. Without it the allocation walks the parent
      // into the container's OOM killer and takes every tenant down with it.
      maxOldGenerationSizeMb: 192,
      maxYoungGenerationSizeMb: 32,
    },
  });

  const tw: ThemeWorker = { worker, pending: new Map(), nextId: 1 };

  worker.on("message", (msg: { type: string; id: number; html?: string; error?: string }) => {
    const p = tw.pending.get(msg.id);
    if (!p) return;
    tw.pending.delete(msg.id);
    clearTimeout(p.timer);

    p.resolve(
      msg.type === "rendered"
        ? { ok: true, html: msg.html ?? "", durationMs: Date.now() - p.startedAt }
        : {
            ok: false,
            error: msg.error ?? "Theme render failed.",
            durationMs: Date.now() - p.startedAt,
            killed: false,
          },
    );
  });

  // Covers the memory limit being hit, and a throw in the theme's module body.
  worker.on("error", (err) => failAll(cacheKey, tw, err.message, false));
  worker.on("exit", () => failAll(cacheKey, tw, "Theme worker exited.", false));

  workers.set(cacheKey, tw);
  return tw;
}

function failAll(cacheKey: string, tw: ThemeWorker, error: string, killed: boolean) {
  if (workers.get(cacheKey) === tw) workers.delete(cacheKey);
  for (const [, p] of tw.pending) {
    clearTimeout(p.timer);
    p.resolve({ ok: false, error, durationMs: Date.now() - p.startedAt, killed });
  }
  tw.pending.clear();
}

/**
 * Renders `template` with this theme, or gives up inside the budget.
 *
 * There is no retry. A theme that blew its deadline once will blow it again, and a
 * retry would only spend a second budget before showing the visitor the same
 * fallback — twice the latency for the same page.
 */
export async function renderTheme(req: RenderRequest): Promise<RenderResult> {
  const cacheKey = `${req.key}@${req.version}`;
  const timeoutMs = req.timeoutMs ?? DEFAULT_RENDER_TIMEOUT_MS;
  const startedAt = Date.now();

  let tw = workers.get(cacheKey);
  if (!tw) tw = spawn(cacheKey, req);

  const id = tw.nextId++;
  const active = tw;

  return new Promise<RenderResult>((resolve) => {
    const timer = setTimeout(() => {
      // The worker is not asked to stop, because it cannot hear the question: a
      // synchronous loop never returns to the event loop that would deliver the
      // message. terminate() does not ask.
      //
      // Everything queued behind it dies with it. That is correct — those requests
      // are waiting on a thread that is not coming back — and they resolve as
      // failures rather than hanging, so each one falls back to the default theme.
      // The next request spawns a fresh worker and pays 118ms once.
      active.pending.delete(id);
      void active.worker.terminate();
      failAll(cacheKey, active, `Theme "${req.key}" exceeded ${timeoutMs}ms and was killed.`, true);

      resolve({
        ok: false,
        error: `Theme "${req.key}" exceeded ${timeoutMs}ms and was killed.`,
        durationMs: Date.now() - startedAt,
        killed: true,
      });
    }, timeoutMs);

    active.pending.set(id, { resolve, startedAt, timer });
    active.worker.postMessage({
      type: "render",
      id,
      template: req.template,
      payload: req.payload,
      content: req.content,
    });
  });
}

/**
 * Drops the worker holding `key@version`, for real.
 *
 * This is what makes the kill switch honest. site-runtime's `forgetTheme` deletes a
 * Map entry and admits in its own comment that Node's ESM loader has no unload — the
 * revoked module stays resident in the process that imported it, and only a redeploy
 * truly removes it. Terminating the thread that holds it IS the unload. A revoked
 * theme stops executing when the revocation arrives, which is what "purges the
 * runtime caches" was always supposed to mean.
 */
export async function forgetThemeWorker(key: string, version: string): Promise<void> {
  const cacheKey = `${key}@${version}`;
  const tw = workers.get(cacheKey);
  if (!tw) return;
  workers.delete(cacheKey);
  failAll(cacheKey, tw, "Theme was revoked.", true);
  await tw.worker.terminate();
}

/** Test seam: how many workers are resident. */
export function residentWorkerCount(): number {
  return workers.size;
}
