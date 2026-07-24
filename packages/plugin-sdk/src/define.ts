import type { PluginContext } from "./context";
import type {
  ActionName,
  FilterName,
  PluginActions,
  PluginFilters,
} from "./events";
import type { PluginManifest, PluginSettingsSchema } from "./manifest";

export type ActionHandler<K extends ActionName, S> = (
  event: PluginActions[K],
  ctx: PluginContext<S>,
) => Promise<void> | void;

export type FilterHandler<K extends FilterName, S> = (
  value: PluginFilters[K]["value"],
  context: PluginFilters[K]["context"],
  ctx: PluginContext<S>,
) => Promise<PluginFilters[K]["value"]> | PluginFilters[K]["value"];

export interface Plugin<S = Record<string, unknown>> {
  manifest: PluginManifest;

  /** Fire-and-forget handlers. The CMS does not wait for these. */
  actions?: {
    [K in ActionName]?: ActionHandler<K, S>;
  };

  /**
   * Value transformers. These run in the request path, so the runtime caps them
   * with a hard timeout; a filter that overruns is dropped and the original
   * value is used. Returning a bad value must never take a page down.
   */
  filters?: {
    [K in FilterName]?: FilterHandler<K, S>;
  };

  /**
   * Deferred jobs. A handler here runs when the plugin called
   * `ctx.jobs.enqueue(name, payload)` and the queue later processes it — in the
   * same sandbox, under the same scopes, just off the request path and with
   * BullMQ's durability and retries behind it.
   *
   * This is the ONLY way a plugin gets to do work "later". It cannot set a timer
   * or hold a connection open; it asks the platform to call this handler again.
   */
  jobs?: Record<
    string,
    (payload: Record<string, unknown>, ctx: PluginContext<S>) => Promise<void> | void
  >;

  /**
   * Request/response handlers. The CMS calls one and **waits for what it returns**.
   *
   * The other three shapes cannot express this. An action returns nothing; a filter
   * returns a value but runs in the page-render path and is capped at 800ms; a job
   * runs later, on the queue, and answers nobody. What was missing is the shape a
   * plugin needs to *be* a service: a caller asks, the plugin does something slow
   * (an `ctx.http.fetch` to an AI provider takes seconds, not milliseconds), and the
   * caller gets an answer back.
   *
   * A call gets the job budget — 30s — because that is what an outbound request to
   * a third party actually costs. Nothing renders a page while it waits, which is
   * exactly why it may be that slow and a filter may not.
   *
   * Callers reach these by CAPABILITY, not by plugin key: cms-api asks whichever
   * plugin provides `ai.assistant` to answer `chat`. That is what makes a plugin
   * swappable — the same reason themes probe `ctx.hasCapability` instead of naming
   * a plugin.
   */
  calls?: Record<
    string,
    (payload: Record<string, unknown>, ctx: PluginContext<S>) => Promise<unknown> | unknown
  >;

  /** Runs once when the plugin is activated on a site (migrations, defaults). */
  setup?: (ctx: PluginContext<S>) => Promise<void> | void;
}

export function definePlugin<S = Record<string, unknown>>(plugin: Plugin<S>): Plugin<S> {
  return plugin;
}

/** Merges stored settings with the manifest's schema defaults, at read time. */
export function resolvePluginSettings<S = Record<string, unknown>>(
  schema: PluginSettingsSchema | undefined,
  stored: Record<string, unknown> | null | undefined,
): S {
  const resolved: Record<string, unknown> = {};
  for (const [key, def] of Object.entries(schema?.properties ?? {})) {
    const value = stored?.[key];
    resolved[key] = value === undefined || value === null ? def.default : value;
  }
  return resolved as S;
}
