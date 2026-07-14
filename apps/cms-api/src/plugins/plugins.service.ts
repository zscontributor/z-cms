import { BadGatewayException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { getSystemDb } from "@zcmsorg/database";
import type { Permission, RenderIntegration } from "@zcmsorg/schemas";
import { t } from "../common/i18n";
import { PluginTokenService } from "./plugin-token.service";

type SettingsSchema = {
  properties?: Record<string, { default?: unknown; format?: string }>;
};

/**
 * The settings the sandbox is given: the stored ones, over the manifest's
 * defaults, MINUS every secret.
 *
 * A setting declared `format: "password"` never crosses into the isolate. It is
 * the admin's credential, not the plugin's — the plugin asked for a field to put
 * it in, which is not the same as asking to read it. A plugin spends such a
 * setting by naming it in `network.secrets` and writing `{{secret:name}}` into a
 * request, and the gateway substitutes it on the far side of the boundary.
 *
 * Without this, `network.secrets` would be theatre: a plugin could simply read
 * `ctx.settings.apiKey` and put the key wherever it liked. With it, the strongest
 * thing a compromised plugin can do with a key it never sees is spend it at the
 * host its own manifest declared and an admin approved.
 */
function resolveSandboxSettings(
  schema: SettingsSchema | undefined,
  stored: Record<string, unknown>,
): Record<string, unknown> {
  const properties = schema?.properties ?? {};
  const merged: Record<string, unknown> = { ...stored };

  for (const [key, def] of Object.entries(properties)) {
    if (merged[key] === undefined || merged[key] === null) merged[key] = def.default;
  }
  for (const [key, def] of Object.entries(properties)) {
    if (def.format === "password") delete merged[key];
  }

  return merged;
}

/**
 * How plugin-runtime should load a plugin: which pinned key verifies it, or that it
 * is read from PLUGIN_DIR. Mirrors the version's `origin`, mapped to the runtime's
 * vocabulary — the routing decision travels as this explicit value, never inferred
 * on the far side from whether a bundle happens to exist.
 */
export type PluginTrust = "builtin" | "marketplace" | "operator";

/** Maps a version's stored origin to the runtime's load route. */
export function originToTrust(origin: string): PluginTrust {
  switch (origin) {
    case "BUILTIN":
      return "builtin";
    case "SIDELOAD":
      return "operator";
    default:
      return "marketplace";
  }
}

export interface DispatchTarget {
  pluginKey: string;
  pluginId: string;
  version: string;
  /** Which trust route loads this plugin — see PluginTrust. */
  trust: PluginTrust;
  /** What it provides, e.g. "ai.assistant". How `callCapability` finds it. */
  capabilities: string[];
  /** Platform-controlled catalogue data, not manifest data. A package cannot claim it. */
  isCore: boolean;
  settings: Record<string, unknown>;
  /** Declared secret name -> is it configured. Booleans; the values never leave here. */
  secrets: Record<string, boolean>;
  scopes: Permission[];
}

export interface PluginRenderContributions {
  capabilities: string[];
  integrations: Record<string, RenderIntegration>;
}

interface PublicIntegrationProjector {
  pluginKey: string;
  project: (settings: Record<string, unknown>) => unknown;
}

/**
 * The public projection boundary. A plugin cannot nominate arbitrary settings
 * for the browser: core owns this allow-list, so credentials remain server-side.
 */
const PUBLIC_INTEGRATION_PROJECTORS: Record<string, PublicIntegrationProjector> = {
  "ai.assistant": {
    pluginKey: "vn.zsoft.plugin.zai",
    project: (settings) => ({
      name: typeof settings.assistantName === "string" && settings.assistantName
        ? settings.assistantName : "zAI Assistant",
      welcomeMessage: typeof settings.welcomeMessage === "string" && settings.welcomeMessage
        ? settings.welcomeMessage : "Xin chào! Tôi có thể giúp gì cho bạn?",
    }),
  },
};

/**
 * Talks to plugin-runtime. Nothing in cms-api ever loads or executes plugin code.
 *
 * Every query here goes through the SYSTEM client with an explicit
 * `tenantId`/`siteId` filter, and that is a correctness requirement, not a
 * shortcut:
 *
 * Actions are dispatched fire-and-forget, so they run AFTER the request's
 * transaction has committed. The tenant-scoped `db()` handle is bound to that
 * transaction — using it here would mean querying a closed transaction, which
 * fails intermittently and only under load. The tenant id comes from the
 * verified actor and is passed down explicitly instead.
 *
 * Plugin calls back INTO the CMS still go through `withTenant()` in the gateway,
 * where they belong: those are real requests with a fresh transaction.
 */
@Injectable()
export class PluginsService {
  private readonly logger = new Logger(PluginsService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly tokens: PluginTokenService,
  ) {}

  /** Capabilities contributed by the site's ACTIVE plugins — themes read these. */
  async capabilitiesFor(tenantId: string, siteId: string): Promise<string[]> {
    const rows = await getSystemDb().sitePlugin.findMany({
      where: { tenantId, siteId, status: "ACTIVE" },
      include: { version: { select: { manifest: true } } },
    });

    const caps = new Set<string>();
    for (const row of rows) {
      const manifest = row.version.manifest as { capabilities?: string[] } | null;
      for (const cap of manifest?.capabilities ?? []) caps.add(cap);
    }
    return [...caps];
  }

  /** Capabilities plus their safe public data, resolved in one catalogue query. */
  async renderContributionsFor(
    tenantId: string,
    siteId: string,
  ): Promise<PluginRenderContributions> {
    const rows = await getSystemDb().sitePlugin.findMany({
      where: { tenantId, siteId, status: "ACTIVE" },
      include: {
        plugin: { select: { key: true } },
        version: { select: { version: true, manifest: true } },
      },
    });

    const capabilities = new Set<string>();
    const integrations: Record<string, RenderIntegration> = {};

    for (const row of rows) {
      const manifest = row.version.manifest as { capabilities?: string[] } | null;
      for (const capability of manifest?.capabilities ?? []) {
        capabilities.add(capability);

        const projector = PUBLIC_INTEGRATION_PROJECTORS[capability];
        if (!projector || projector.pluginKey !== row.plugin.key || integrations[capability]) {
          continue;
        }

        integrations[capability] = {
          capability,
          provider: { pluginKey: row.plugin.key, version: row.version.version },
          data: projector.project((row.settings ?? {}) as Record<string, unknown>),
        };
      }
    }

    return { capabilities: [...capabilities], integrations };
  }

  /** Public zAI chrome only. This allow-list is what keeps provider keys server-side. */
  async aiAssistantFor(
    tenantId: string,
    siteId: string,
  ): Promise<{ name: string; welcomeMessage: string } | undefined> {
    const row = await getSystemDb().sitePlugin.findFirst({
      where: { tenantId, siteId, status: "ACTIVE", plugin: { key: "vn.zsoft.plugin.zai" } },
      select: { settings: true },
    });
    if (!row) return undefined;
    return PUBLIC_INTEGRATION_PROJECTORS["ai.assistant"].project(
      (row.settings ?? {}) as Record<string, unknown>,
    ) as { name: string; welcomeMessage: string };
  }

  /**
   * Fires an action on every active plugin of a site.
   *
   * Deliberately fire-and-forget: `void` on the caller's side, errors swallowed
   * into the log. Publishing a page must not fail, or even slow down, because a
   * third-party plugin is broken or slow. The plugin's job is to react, not to
   * hold up the CMS.
   */
  async dispatchAction(
    tenantId: string,
    siteId: string,
    action: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const targets = await this.activePlugins(tenantId, siteId);
    if (targets.length === 0) return;

    await Promise.all(
      targets.map(async (target) => {
        try {
          await this.execute(tenantId, siteId, target, {
            kind: "action",
            name: action,
            payload,
          });
        } catch (err) {
          this.logger.warn(
            `Plugin ${target.pluginKey} failed on ${action}: ${(err as Error).message}`,
          );
        }
      }),
    );
  }

  /**
   * Runs a filter through the active plugins, in sequence, threading the value.
   *
   * This one DOES block the caller, so it is used only where a stale value is
   * unacceptable (page metadata) and it is bounded twice: the runtime caps each
   * handler at 800ms, and a plugin that fails or times out is simply skipped —
   * the previous value passes through unchanged. A broken SEO plugin degrades
   * the SEO of a page; it never takes the page down.
   */
  async applyFilter<T>(
    tenantId: string,
    siteId: string,
    filter: string,
    value: T,
    context: Record<string, unknown>,
  ): Promise<T> {
    const targets = await this.activePlugins(tenantId, siteId);
    if (targets.length === 0) return value;

    let current = value;
    for (const target of targets) {
      try {
        const res = await this.execute(tenantId, siteId, target, {
          kind: "filter",
          name: filter,
          value: current,
          context,
        });
        if (res.ok && res.result !== undefined && res.result !== null) {
          current = res.result as T;
        }
      } catch (err) {
        this.logger.warn(
          `Filter ${filter} skipped for ${target.pluginKey}: ${(err as Error).message}`,
        );
      }
    }
    return current;
  }

  /**
   * Runs a plugin's `setup()` — the one dispatch that happens while it is still
   * INACTIVE, so it cannot go through `activePlugins`.
   *
   * It takes a KEY, not a hand-built target. It used to take the target, and the
   * caller assembled one field by field: every new thing a target carries (its
   * capabilities, whether it is core, which of its secrets are set) was a field that
   * silently went missing on this path. One mapper, one shape.
   */
  async runSetup(tenantId: string, siteId: string, pluginKey: string): Promise<void> {
    const row = await getSystemDb().sitePlugin.findFirst({
      where: { tenantId, siteId, plugin: { key: pluginKey } },
      include: { plugin: true, version: true },
    });
    if (!row) throw new NotFoundException(t()("errors.plugins.notInstalled"));

    await this.execute(tenantId, siteId, this.toTarget(row), { kind: "setup" });
  }

  /**
   * Runs one deferred job for one plugin, in the sandbox.
   *
   * Reached from the worker via the internal run-job endpoint. It resolves the
   * plugin's current install (for its granted scopes and settings) and dispatches
   * a `job` invocation — the plugin's own `jobs[name]` handler, under the same
   * scoped token as any hook. A job the plugin is no longer installed for, or was
   * uninstalled from, simply does nothing.
   */
  async runJob(
    tenantId: string,
    siteId: string,
    pluginKey: string,
    name: string,
    payload: Record<string, unknown>,
  ): Promise<{ ok: boolean; error?: string }> {
    const targets = await this.activePlugins(tenantId, siteId);
    const target = targets.find((t) => t.pluginKey === pluginKey);
    if (!target) {
      return { ok: false, error: `Plugin ${pluginKey} is not active on this site.` };
    }

    const res = await this.execute(tenantId, siteId, target, {
      kind: "job",
      name,
      payload,
    });
    return { ok: res.ok, error: res.error };
  }

  /**
   * Asks whichever plugin provides `capability` to answer `name`, and waits.
   *
   * This is the call that lets core stop knowing which plugin is which. cms-api
   * does not want "the zAI plugin"; it wants "whatever answers ai.assistant on this
   * site". Naming the capability rather than the key is what makes an AI plugin
   * swappable for a different one without a line of core changing — the same
   * reason a theme probes `ctx.hasCapability` instead of hard-coding a plugin id.
   *
   * `requireCore` is for the callers that genuinely cannot be capability-agnostic:
   * the admin content operator drives content CRUD off the model's output, and
   * handing that to any marketplace plugin that declared `ai.assistant` would be a
   * privilege escalation dressed up as an integration. Publisher and `isCore` are
   * platform-controlled catalogue columns, not manifest data, so a package cannot
   * claim them.
   */
  async callCapability(
    tenantId: string,
    siteId: string,
    capability: string,
    name: string,
    payload: Record<string, unknown>,
    options: { requireCore?: boolean } = {},
  ): Promise<unknown> {
    const targets = await this.activePlugins(tenantId, siteId);
    const target = targets.find(
      (t) =>
        t.capabilities.includes(capability) && (!options.requireCore || t.isCore),
    );

    if (!target) {
      throw new NotFoundException(
        t()("errors.plugins.noCapabilityProvider", { capability }),
      );
    }

    const res = await this.execute(tenantId, siteId, target, {
      kind: "call",
      name,
      payload,
    });

    if (!res.ok) {
      // A call is the one invocation whose failure the caller must hear about. An
      // action's error is a log line because nobody was waiting; here somebody is.
      throw new BadGatewayException(
        res.error ?? `Plugin ${target.pluginKey} failed to answer "${name}".`,
      );
    }
    return res.result;
  }

  private async activePlugins(
    tenantId: string,
    siteId: string,
  ): Promise<DispatchTarget[]> {
    const rows = await getSystemDb().sitePlugin.findMany({
      where: { tenantId, siteId, status: "ACTIVE" },
      include: { plugin: true, version: true },
    });

    return rows.map((row) => this.toTarget(row));
  }

  /**
   * The one place a database row becomes a thing the sandbox may be handed.
   *
   * Everything the plugin is about to see, and everything it is deliberately not
   * about to see, is decided here — which is why there is exactly one of these.
   */
  private toTarget(row: {
    plugin: { key: string; id: string; isCore: boolean };
    version: { version: string; manifest: unknown; origin: string };
    settings: unknown;
    grantedPermissions: string[] | null;
  }): DispatchTarget {
    const manifest = row.version.manifest as {
      settingsSchema?: SettingsSchema;
      capabilities?: string[];
      network?: { secrets?: Record<string, string> };
    } | null;

    const stored = (row.settings ?? {}) as Record<string, unknown>;

    // "Which of your declared secrets did the admin fill in?" — a boolean per name,
    // computed here so that the values stay here. A plugin needs the answer to pick
    // a provider; it must not need the key in order to find out that it has one.
    const secrets: Record<string, boolean> = {};
    for (const [name, settingKey] of Object.entries(manifest?.network?.secrets ?? {})) {
      secrets[name] = Boolean(stored[settingKey]);
    }

    return {
      pluginKey: row.plugin.key,
      pluginId: row.plugin.id,
      version: row.version.version,
      capabilities: manifest?.capabilities ?? [],
      isCore: row.plugin.isCore,
      // Which trust route plugin-runtime uses to load this — read from `origin`, the
      // column of record, not inferred from whether a bundleUrl happens to be set.
      trust: originToTrust(row.version.origin),
      // Stored settings merged over the manifest's defaults, at read time, with
      // every password-format setting withheld. A freshly installed plugin has `{}`
      // in the database, so without the merge every default its author declared
      // would silently be undefined — and the plugin would misbehave in exactly the
      // case it is most likely to be in: just installed, never configured. Without
      // the withholding, an API key would ride into the sandbox in plain text.
      settings: resolveSandboxSettings(manifest?.settingsSchema, stored),
      secrets,
      // The GRANTED scopes, not the requested ones. An admin who approved only some
      // of what a plugin asked for gets exactly that.
      scopes: (row.grantedPermissions ?? []) as Permission[],
    };
  }

  /**
   * How long cms-api waits on plugin-runtime, per invocation kind.
   *
   * Mirrors the runtime's own TIMEOUT_MS with headroom for the round trip and for
   * the runtime's kill grace. The runtime is what enforces the handler's deadline;
   * this only has to be generous enough not to pre-empt it, and tight enough to
   * notice a runtime that has stopped answering at all.
   */
  private networkBudgetMs(kind: string): number {
    if (kind === "job" || kind === "call") return 35_000;
    if (kind === "setup") return 15_000;
    if (kind === "filter") return 3_000;
    return 12_000; // action
  }

  private async execute(
    tenantId: string,
    siteId: string,
    target: DispatchTarget,
    invocation: Record<string, unknown>,
  ): Promise<{ ok: boolean; result?: unknown; error?: string }> {
    const site = await getSystemDb().site.findFirst({
      where: { id: siteId, tenantId },
    });
    if (!site) throw new NotFoundException(t()("errors.sites.notFound"));

    const { token: pluginToken, jti } = await this.tokens.mint({
      plg: target.pluginKey,
      pid: target.pluginId,
      tid: tenantId,
      sid: siteId,
      scopes: target.scopes,
    });

    const url = this.config.get<string>("PLUGIN_RUNTIME_URL") ?? "http://localhost:4200";

    try {
      const res = await fetch(`${url}/execute`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-internal-token": this.config.getOrThrow<string>("CMS_INTERNAL_TOKEN"),
        },
        body: JSON.stringify({
          pluginKey: target.pluginKey,
          version: target.version,
          trust: target.trust,
          invocation,
          settings: target.settings,
          secrets: target.secrets,
          site: { id: site.id, name: site.name, locale: site.defaultLocale },
          pluginToken,
        }),
        // The runtime enforces its own per-handler deadline; this is the network
        // backstop for a runtime that has stopped answering entirely, so it must sit
        // ABOVE that deadline rather than under it.
        //
        // It used to be a flat 12s, which quietly capped a `job` at 12s of its 30s
        // budget — a plugin killed by the caller's impatience rather than by its own
        // limit, and a bug that only showed up as "the job sometimes doesn't finish".
        // A `call` (an AI provider round trip) would have hit it every time.
        signal: AbortSignal.timeout(this.networkBudgetMs(invocation.kind as string)),
      });

      if (!res.ok) {
        throw new Error(`plugin-runtime HTTP ${res.status}`);
      }

      return (await res.json()) as { ok: boolean; result?: unknown; error?: string };
    } finally {
      // The handler has run and made every gateway call it was going to. Retire
      // the token now: a copy captured from plugin-runtime is dead the instant the
      // invocation returns, instead of living out the rest of its 60s TTL.
      await this.tokens.retire(jti);
    }
  }
}
