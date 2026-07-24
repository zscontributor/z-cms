import { parentPort, workerData } from "node:worker_threads";
import { pathToFileURL } from "node:url";

/**
 * Renders ONE theme, over and over, on a thread that is not the request thread.
 *
 * Why this exists, in one sentence: a theme is third-party code we `import()`, and
 * until now it ran on the event loop that serves every tenant.
 *
 * The attack it answers is embarrassingly small. `while (true) {}` in a component
 * body. No exploit, no escape, no cleverness — one line, and site-runtime stops
 * answering for every site on the instance until the healthcheck notices. There
 * was no defence, and there could not be one in-process: a synchronous loop never
 * yields, so a Promise.race resolves nothing and an AbortController aborts nothing.
 * The code that would cancel it does not get to run. Measured before this existed:
 * `worker.terminate()` cuts a `while(true){}` in 503ms while the parent stays
 * responsive throughout. That is the entire reason for the thread.
 *
 * What this is NOT — and the security model must not grow a sentence saying
 * otherwise, because that mistake has already been made once in this repo:
 *
 *   A worker_thread is not a sandbox. It is a separate V8 isolate, not a separate
 *   process: the theme still shares this process's filesystem, still reaches
 *   `node:child_process`, still opens sockets. An `isolated-vm` would stop all of
 *   that, and cannot be used here — React SSR needs Node APIs an isolate does not
 *   have. So this bounds AVAILABILITY (loop, memory bomb, crash) and nothing else.
 *   Confidentiality still rests where it did: on the signature, on site-runtime
 *   holding no credential worth stealing, and on the container.
 *
 * One confidentiality gain is real and worth naming: the parent spawns us with
 * `env: {}`, so `process.env` here is EMPTY. site-runtime's own environment holds
 * SITE_RUNTIME_INTERNAL_TOKEN — the render token. A theme rendering in-process can
 * read it today. A theme rendering here cannot: there is nothing to read.
 *
 * Lifetime: one worker per `key@version`, reused across requests. Cold start
 * measured at 118ms (112ms of it spawn + React, 6ms the theme import); a warm
 * render at 1.16ms. Paying 118ms per request would be indefensible; paying it once
 * per theme, and again only when a hostile theme forces a terminate, is free. It
 * also means one theme's loop blocks one theme's worker — the tenants on every
 * other theme never notice.
 */

interface WorkerInput {
  /** Absolute path to the theme's verified `dist/index.mjs`. */
  entryPath: string;
  /** Where the theme's own files are served from, for `ctx.asset()`. */
  assetBase: string;
}

interface RenderRequest {
  type: "render";
  id: number;
  /** Which template to use. `page` is the contractual fallback. */
  template: string;
  /** Serializable. The theme half of the context is rebuilt here from it. */
  payload: unknown;
  content: unknown;
}

const input = workerData as WorkerInput;
const port = parentPort!;

/**
 * A dynamic import TypeScript is not allowed to rewrite.
 *
 * This file compiles to CommonJS, and tsc helpfully downlevels `await import(x)`
 * into `require(x)`. A theme bundle is ESM — esbuild emits `format: "esm"` because
 * React and the SDK are ESM — so `require()` refuses it with a module-not-found that
 * names the theme rather than the cause. Wrapping the import in `new Function` puts
 * it beyond the compiler's reach, so what runs is the real dynamic import.
 *
 * Not a hack for its own sake: the alternative is emitting ESM here, which would
 * mean this package alone diverges from every other in the repo (theme-sdk and the
 * rest are CommonJS because cms-api requires them at runtime).
 */
const importEsm = new Function("url", "return import(url)") as (
  url: string,
) => Promise<unknown>;

/**
 * Loaded once, at startup, and deliberately NOT lazily per render.
 *
 * A top-level `while(true){}` in the theme's module body would hang this import.
 * That is fine and is the point: the parent's spawn deadline covers startup too,
 * so a theme that cannot even be imported is terminated exactly like one that
 * cannot be rendered, and the parent falls back to the built-in default.
 */
const ready = (async () => {
  const mod = (await importEsm(pathToFileURL(input.entryPath).href)) as Record<string, unknown>;
  const theme = (mod.default ?? mod) as ThemeModule;

  if (!theme?.templates?.page || !theme.Layout) {
    throw new Error("Theme is invalid: missing Layout or templates.page.");
  }
  return theme;
})();

interface ThemeModule {
  Layout: unknown;
  templates: Record<string, unknown>;
  blocks?: Record<string, unknown>;
  manifest: Record<string, unknown>;
  messages?: unknown;
  seo?: (ctx: unknown) => unknown;
}

port.on("message", (msg: RenderRequest) => {
  if (msg.type !== "render") return;

  void (async () => {
    try {
      const theme = await ready;
      const { renderThemeToHtml } = await import("./render");

      // Synchronous from here. A loop inside it never returns, never yields, and
      // never reaches the catch — the parent's terminate() is what ends it.
      const html = renderThemeToHtml(theme, msg.template, msg.payload, msg.content, input.assetBase);

      port.postMessage({ type: "rendered", id: msg.id, html });
    } catch (err) {
      // A theme that THROWS is not a theme that hangs: report it and stay alive,
      // so one broken page does not cost every other page on this theme a 118ms
      // respawn. Only a timeout kills the worker.
      port.postMessage({
        type: "failed",
        id: msg.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  })();
});
