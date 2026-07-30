import { BadGatewayException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { getSystemDb } from "@zcmsorg/database";
import {
  buildPluginDelete,
  generatePluginTableDdl,
  generatePluginTableDropDdl,
  resolveLocalized,
  resolvePluginAdminResource,
  validatePluginTableSchemas,
  type PluginAdminContribution,
  type PluginTableSchema,
  type ResolvedPluginAdminResource,
} from "@zcmsorg/plugin-sdk";
import type { FormDefinition, ProvidedPermission, Permission, PublicFormDef, RenderIntegration } from "@zcmsorg/schemas";
import { toPublicForm } from "@zcmsorg/schemas";
import { currentLocale, t } from "../common/i18n";
import { canOwnPluginTables } from "./plugin-data-trust";
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

async function runtimeHttpError(res: Response): Promise<Error> {
  let detail = "";

  try {
    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      const body = (await res.json()) as { message?: unknown; error?: unknown };
      const message = body.message ?? body.error;
      if (typeof message === "string") detail = message;
    } else {
      detail = await res.text();
    }
  } catch {
    detail = "";
  }

  const suffix = detail.trim() ? `: ${detail.trim()}` : "";
  return new Error(`plugin-runtime HTTP ${res.status}${suffix}`);
}

/**
 * How plugin-runtime should load a plugin: which pinned key verifies it, or that it
 * is read from PLUGIN_DIR. Mirrors the version's `origin`, mapped to the runtime's
 * vocabulary — the routing decision travels as this explicit value, never inferred
 * on the far side from whether a bundle happens to exist.
 */
/** How long a site's active provided-permissions stay cached on the auth path. */
const PROVIDED_PERMISSIONS_TTL_MS = 30_000;

export type PluginTrust = "builtin" | "marketplace" | "operator";

/**
 * A core-runtime plugin (see manifest `runtime: "core"`) ships no bundle — its
 * behaviour is a core module, not sandbox code. The sandbox dispatch must skip it
 * (there is nothing to execute), while the manifest-reading paths — capabilities,
 * provided permissions, admin, projectors — still count it, because those are
 * what a core-runtime plugin contributes through.
 */
function isCoreRuntimePlugin(manifest: unknown): boolean {
  return (manifest as { runtime?: string } | null)?.runtime === "core";
}

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
  /** Public forms this plugin declared, read from its installed manifest. */
  forms: FormDefinition[];
}

export interface PluginRenderContributions {
  capabilities: string[];
  integrations: Record<string, RenderIntegration>;
}

/** What a projector may read to build the browser-safe data for its capability. */
export interface CapabilityProjectorContext {
  tenantId: string;
  siteId: string;
  /** The providing plugin's settings; `{}` for a core-provided capability. */
  settings: Record<string, unknown>;
  /** Capabilities the active theme declared it can render (`optionalCapabilities`). */
  themeCapabilities: readonly string[];
}

/**
 * Turns a capability into the browser-safe data a runtime-owned widget renders
 * against — the AI assistant's name, the storefront's currency. This is THE
 * public projection boundary: a sandboxed plugin never nominates what reaches a
 * page, core does, here, so credentials and internal state stay server-side.
 *
 * A projector's `provider` says where the capability comes from, and it is the
 * single line Phase 4 changes to move commerce out of core: a `"core"` capability
 * is eligible on every site (gated only by its own `resolve` returning non-null),
 * while a `"plugin"` one is eligible only where an ACTIVE plugin of `pluginKey`
 * provides it. The runtime side neither knows nor cares which it was — it mounts
 * the component for the capability and reads the data — so nothing downstream has
 * to change when a capability's provider does.
 */
export interface CapabilityProjector {
  provider: { kind: "core"; version: string } | { kind: "plugin"; pluginKey: string };
  resolve(ctx: CapabilityProjectorContext): Promise<unknown | null> | unknown | null;
}

function isZaiProviderConfigured(settings: Record<string, unknown>): boolean {
  return (
    (settings.openaiEnabled === true && Boolean(settings.openaiApiKey)) ||
    (settings.claudeEnabled === true && Boolean(settings.claudeApiKey)) ||
    (settings.geminiEnabled === true && Boolean(settings.geminiApiKey))
  );
}

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

  /** (tenantId:siteId) -> the provided-permissions active there, cached briefly. */
  private readonly providedCache = new Map<
    string,
    { at: number; perms: ProvidedPermission[] }
  >();

  /** capability -> how to project its browser-safe data. See CapabilityProjector. */
  private readonly projectors = new Map<string, CapabilityProjector>();

  constructor(
    private readonly config: ConfigService,
    private readonly tokens: PluginTokenService,
  ) {
    // The one built-in projector. Others (commerce today, whatever tomorrow)
    // register themselves from their own module, so this service does not have to
    // know what capabilities exist — only how to run whatever is registered.
    this.registerCapabilityProjector("ai.assistant", {
      provider: { kind: "plugin", pluginKey: "vn.zsoft.plugin.zai" },
      resolve: ({ settings }) => {
        if (!isZaiProviderConfigured(settings)) return null;
        return {
          name:
            typeof settings.assistantName === "string" && settings.assistantName
              ? settings.assistantName
              : "zAI Assistant",
          welcomeMessage:
            typeof settings.welcomeMessage === "string" && settings.welcomeMessage
              ? settings.welcomeMessage
              : "Xin chào! Tôi có thể giúp gì cho bạn?",
        };
      },
    });
  }

  /**
   * Registers how a capability's browser-safe data is built. Called once per
   * capability, at startup, from the module that owns it — the extension point
   * that lets a first-party feature (or, in time, a first-party plugin) contribute
   * runtime UI without this service knowing anything about it.
   */
  registerCapabilityProjector(capability: string, projector: CapabilityProjector): void {
    this.projectors.set(capability, projector);
  }

  /**
   * The provided-permissions a site's ACTIVE plugins introduce — the keys a
   * commerce plugin brings to guard its own Orders screen (see
   * `manifest.permissionsProvided`). Read on the auth hot path to union plugin
   * grants onto a user's role, so it is cached: activation is rare, requests are
   * not, and a permission appearing 30s after a plugin is switched on is fine.
   *
   * `siteId` omitted resolves only the tenant-wide (org) tier — the baseline the
   * session builds before a site is chosen. With a site, both tiers apply.
   */
  async activeProvidedPermissions(
    tenantId: string,
    siteId: string | undefined,
  ): Promise<ProvidedPermission[]> {
    const cacheKey = `${tenantId}:${siteId ?? "-"}`;
    const hit = this.providedCache.get(cacheKey);
    const now = Date.now();
    if (hit && now - hit.at < PROVIDED_PERMISSIONS_TTL_MS) return hit.perms;

    const db = getSystemDb();
    const [siteRows, orgRows] = await Promise.all([
      siteId
        ? db.sitePlugin.findMany({
            where: { tenantId, siteId, status: "ACTIVE" },
            include: { version: { select: { manifest: true } } },
          })
        : Promise.resolve([]),
      db.orgPlugin.findMany({
        where: { tenantId, status: "ACTIVE" },
        include: { version: { select: { manifest: true } } },
      }),
    ]);

    // Keyed by permission key so a plugin active at both tiers is counted once.
    // Collision across plugins cannot happen: `validateProvidedPermissions`
    // namespaces every community key and reserves the core ones at install.
    const byKey = new Map<string, ProvidedPermission>();
    for (const row of [...siteRows, ...orgRows]) {
      const manifest = row.version.manifest as {
        permissionsProvided?: ProvidedPermission[];
      } | null;
      for (const perm of manifest?.permissionsProvided ?? []) {
        if (!byKey.has(perm.key)) byKey.set(perm.key, perm);
      }
    }

    const perms = [...byKey.values()];
    this.providedCache.set(cacheKey, { at: now, perms });
    return perms;
  }

  /**
   * Drop cached provided-permissions for a tenant. Called whenever a plugin's
   * active state changes (activate/deactivate/uninstall): the cache is a latency
   * optimisation, not a source of truth, so the safe move on any change is to
   * clear every one of the tenant's site keys and let them refill on demand.
   */
  bustProvidedPermissions(tenantId: string): void {
    for (const key of this.providedCache.keys()) {
      if (key.startsWith(`${tenantId}:`)) this.providedCache.delete(key);
    }
  }

  /**
   * The admin screens a user may see on this site — the sidebar entries whose
   * permission they hold, and the descriptors for the resources those entries
   * open. Read from the ACTIVE plugins' manifests, filtered by the caller's own
   * permission set, so a user is never handed a nav entry to a screen the guard
   * would then refuse them.
   */
  async adminContributionsFor(
    tenantId: string,
    siteId: string,
    permissions: readonly string[],
    locale: string = currentLocale(),
  ): Promise<{
    nav: Array<{ pluginKey: string; label: string; icon?: string; resource: string; permission: string }>;
    resources: Array<{ pluginKey: string; resource: ResolvedPluginAdminResource }>;
  }> {
    const held = new Set(permissions);
    const db = getSystemDb();
    const include = {
      plugin: { select: { key: true } },
      version: { select: { manifest: true } },
    } as const;
    const [siteRows, orgRows] = await Promise.all([
      db.sitePlugin.findMany({ where: { tenantId, siteId, status: "ACTIVE" }, include }),
      db.orgPlugin.findMany({ where: { tenantId, status: "ACTIVE" }, include }),
    ]);

    const nav: Array<{ pluginKey: string; label: string; icon?: string; resource: string; permission: string }> = [];
    const resources: Array<{ pluginKey: string; resource: ResolvedPluginAdminResource }> = [];

    for (const row of [...siteRows, ...orgRows]) {
      const admin = (row.version.manifest as { admin?: PluginAdminContribution } | null)?.admin;
      if (!admin) continue;
      const pluginKey = row.plugin.key;

      for (const item of admin.nav ?? []) {
        // The gate that answers the original question — a plugin's menu appears
        // only for a user whose role the plugin's permission reaches.
        if (held.has(item.permission)) {
          nav.push({
            pluginKey,
            label: resolveLocalized(item.label, locale),
            icon: item.icon,
            resource: item.resource,
            permission: item.permission,
          });
        }
      }
      for (const resource of admin.resources ?? []) {
        if (held.has(resource.permissions.read)) {
          resources.push({ pluginKey, resource: resolvePluginAdminResource(resource, locale) });
        }
      }
    }

    return { nav, resources };
  }

  /**
   * Resolves one admin resource to render or serve — its descriptor, its backing
   * table schema, and whether the installed package has a data-capable trust
   * origin (built-in or reviewed marketplace).
   *
   * Read from the installed manifest, never the request, exactly as the gateway's
   * `resolvePluginTable` is: the user names a plugin and a resource key, and gets
   * back what the plugin declared or nothing at all.
   */
  async adminResourceFor(
    tenantId: string,
    siteId: string,
    pluginKey: string,
    resourceKey: string,
    locale: string = currentLocale(),
  ): Promise<{ resource: ResolvedPluginAdminResource; table: PluginTableSchema } | null> {
    const db = getSystemDb();
    const include = {
      version: { select: { manifest: true, origin: true } },
    } as const;
    const install =
      (await db.sitePlugin.findFirst({
        where: { siteId, plugin: { key: pluginKey }, status: "ACTIVE" },
        include,
      })) ??
      (await db.orgPlugin.findFirst({
        where: { tenantId, plugin: { key: pluginKey }, status: "ACTIVE" },
        include,
      }));

    if (!install || !canOwnPluginTables(install.version.origin)) return null;

    const manifest = install.version.manifest as {
      admin?: PluginAdminContribution;
      database?: { tables?: PluginTableSchema[] };
    } | null;

    const resource = manifest?.admin?.resources?.find((r) => r.key === resourceKey);
    if (!resource) return null;
    const table = manifest?.database?.tables?.find((t) => t.name === resource.table);
    if (!table) return null;

    return { resource: resolvePluginAdminResource(resource, locale), table };
  }

  /** Capabilities contributed by the site's ACTIVE plugins — themes read these. */
  async capabilitiesFor(tenantId: string, siteId: string): Promise<string[]> {
    const db = getSystemDb();
    // Both tiers: the site's own ACTIVE installs plus any plugin the tenant has
    // activated org-wide. An org plugin's capabilities are visible on every site.
    const [siteRows, orgRows] = await Promise.all([
      db.sitePlugin.findMany({
        where: { tenantId, siteId, status: "ACTIVE" },
        include: { version: { select: { manifest: true } } },
      }),
      db.orgPlugin.findMany({
        where: { tenantId, status: "ACTIVE" },
        include: { version: { select: { manifest: true } } },
      }),
    ]);
    const rows = [...siteRows, ...orgRows];

    const caps = new Set<string>();
    for (const row of rows) {
      const manifest = row.version.manifest as { capabilities?: string[] } | null;
      for (const cap of manifest?.capabilities ?? []) caps.add(cap);
    }
    return [...caps];
  }

  /**
   * Capabilities the site can feature-detect, plus the browser-safe data for the
   * ones a projector turns into a runtime integration.
   *
   * Two sources, one shape out. Active plugins contribute their declared
   * capabilities (for `hasCapability`) and the settings a projector reads;
   * registered projectors — plugin-backed like the AI assistant, or core-backed
   * like commerce — turn an eligible capability into an integration. `themeCaps`
   * is the theme's `optionalCapabilities`, passed to each projector so one can
   * decline to compute a config a template has nowhere to render (commerce on a
   * blog theme), without this method knowing which projector cares.
   */
  async renderContributionsFor(
    tenantId: string,
    siteId: string,
    themeCaps: readonly string[] = [],
  ): Promise<PluginRenderContributions> {
    const db = getSystemDb();
    const include = {
      plugin: { select: { key: true } },
      version: { select: { version: true, manifest: true } },
    } as const;
    // Site-tier installs plus org-wide ones. A public integration an org plugin
    // exposes (e.g. an AI assistant activated for the whole tenant) shows up here
    // for every site the tenant owns.
    const [siteRows, orgRows] = await Promise.all([
      db.sitePlugin.findMany({ where: { tenantId, siteId, status: "ACTIVE" }, include }),
      db.orgPlugin.findMany({ where: { tenantId, status: "ACTIVE" }, include }),
    ]);

    // Every active capability, for feature detection — and, for each, the first
    // active provider's key/version/settings, which a plugin-backed projector needs.
    const capabilities = new Set<string>();
    const active = new Map<
      string,
      { pluginKey: string; version: string; settings: Record<string, unknown> }
    >();
    for (const row of [...siteRows, ...orgRows]) {
      const manifest = row.version.manifest as { capabilities?: string[] } | null;
      for (const cap of manifest?.capabilities ?? []) {
        capabilities.add(cap);
        if (!active.has(cap)) {
          active.set(cap, {
            pluginKey: row.plugin.key,
            version: row.version.version,
            settings: (row.settings ?? {}) as Record<string, unknown>,
          });
        }
      }
    }

    const integrations: Record<string, RenderIntegration> = {};
    for (const [capability, projector] of this.projectors) {
      let provider: { pluginKey: string; version: string };
      let settings: Record<string, unknown>;

      if (projector.provider.kind === "plugin") {
        // Only the plugin the projector names may supply it — a rogue plugin that
        // declares `ai.assistant` cannot borrow zAI's projection.
        const supplier = active.get(capability);
        if (!supplier || supplier.pluginKey !== projector.provider.pluginKey) continue;
        provider = { pluginKey: supplier.pluginKey, version: supplier.version };
        settings = supplier.settings;
      } else {
        provider = { pluginKey: "core", version: projector.provider.version };
        settings = {};
      }

      const data = await projector.resolve({
        tenantId,
        siteId,
        settings,
        themeCapabilities: themeCaps,
      });
      if (data == null) continue;

      integrations[capability] = { capability, provider, data };
      // A core capability that resolved is live on this site, so themes may
      // feature-detect it too.
      capabilities.add(capability);
    }

    return { capabilities: [...capabilities], integrations };
  }

  /** Public zAI chrome only. This allow-list is what keeps provider keys server-side. */
  async aiAssistantFor(
    tenantId: string,
    siteId: string,
  ): Promise<{ name: string; welcomeMessage: string } | undefined> {
    const db = getSystemDb();
    // zAI may be activated per-site or org-wide; check both tiers, preferring the
    // site's own install if one exists.
    const row =
      (await db.sitePlugin.findFirst({
        where: { tenantId, siteId, status: "ACTIVE", plugin: { key: "vn.zsoft.plugin.zai" } },
        select: { settings: true },
      })) ??
      (await db.orgPlugin.findFirst({
        where: { tenantId, status: "ACTIVE", plugin: { key: "vn.zsoft.plugin.zai" } },
        select: { settings: true },
      }));
    if (!row) return undefined;
    const settings = (row.settings ?? {}) as Record<string, unknown>;

    // The same projector `renderContributionsFor` runs, so "what the browser gets"
    // has one definition. It returns null when no provider is configured.
    const projector = this.projectors.get("ai.assistant");
    const data = await projector?.resolve({
      tenantId,
      siteId,
      settings,
      themeCapabilities: [],
    });
    return (data as { name: string; welcomeMessage: string } | null) ?? undefined;
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

    // A core-runtime plugin has no setup() to run — activation is just the state
    // change and the permission grant. Nothing to dispatch, so return clean.
    if (isCoreRuntimePlugin(row.version.manifest)) return;

    const res = await this.execute(tenantId, siteId, this.toTarget(row), { kind: "setup" });
    // A failed setup must fail activation — the caller flips to ACTIVE only on a
    // clean return, and "clean" has to include the plugin's own code. Without this
    // a setup that threw (or whose db seeding was refused) would be swallowed and
    // the plugin would come up ACTIVE having never finished setting up.
    if (!res.ok) {
      throw new Error(res.error ?? "Plugin setup failed.");
    }
  }

  /**
   * Creates (or reconciles) a verified plugin's declared tables — the DDL half
   * of activation, run before `setup()` so the plugin's own setup can already
   * write to its tables.
   *
   * Runs on `getSystemDb()`, deliberately outside any tenant transaction: the
   * table and its RLS policy are global objects created once, and the per-tenant
   * isolation is the policy itself, not the connection that installed it. The DDL
   * is idempotent (every statement is `IF NOT EXISTS` or drop-then-create), so
   * this is safe to run on every activation, the way WordPress re-runs `dbDelta`.
   *
   * A no-op for an unreviewed sideload: install already refused its `database`
   * block, so there is nothing here to create. The origin re-check is defence in
   * depth.
   */
  async ensurePluginTables(pluginKey: string): Promise<void> {
    const plugin = await getSystemDb().plugin.findUnique({
      where: { key: pluginKey },
      include: { versions: { orderBy: { createdAt: "desc" }, take: 1 } },
    });
    const version = plugin?.versions[0];
    if (!plugin || !version || !canOwnPluginTables(version.origin)) return;

    const manifest = version.manifest as {
      database?: { tables?: PluginTableSchema[] };
    } | null;
    const tables = manifest?.database?.tables ?? [];

    // Re-validate at the door, even though install already did. This is the moment
    // arbitrary DDL is about to run against the real database, so it does not get to
    // trust that some earlier gate held — a manifest that names a core table, an
    // off-prefix table, a bad column or an unknown type is refused HERE, before a
    // single statement is emitted. Activation fails cleanly; nothing partial runs.
    const violations = validatePluginTableSchemas(plugin.key, tables);
    if (violations.length) {
      throw new Error(
        `Refusing to create tables for ${plugin.key}: ` +
          violations.map((v) => `${v.table} (${v.reason})`).join(", "),
      );
    }

    for (const table of tables) {
      for (const statement of generatePluginTableDdl(plugin.key, table)) {
        await getSystemDb().$executeRawUnsafe(statement);
      }
    }
  }

  /**
   * Deletes ONE site's rows from a plugin's tables — the data half of uninstalling
   * the plugin from that site.
   *
   * A DELETE, never a DROP: the table is a global object shared by every site the
   * plugin is installed on, so dropping it here would destroy other sites' — and
   * other tenants' — data. Each delete is scoped to `(tenant_id, site_id)` from the
   * uninstalling actor and runs under that tenant's RLS, so it can only ever remove
   * the caller's own rows, and only from a table the plugin owns (the builder emits
   * the validated table name and nothing else).
   *
   * A no-op for an unreviewed sideload, which has no tables.
   */
  async purgePluginSiteData(
    tenantId: string,
    siteId: string,
    pluginKey: string,
  ): Promise<void> {
    const plugin = await getSystemDb().plugin.findUnique({
      where: { key: pluginKey },
      include: { versions: { orderBy: { createdAt: "desc" }, take: 1 } },
    });
    const version = plugin?.versions[0];
    if (!plugin || !version || !canOwnPluginTables(version.origin)) return;

    const manifest = version.manifest as {
      database?: { tables?: PluginTableSchema[] };
    } | null;
    const tables = manifest?.database?.tables ?? [];
    const violations = validatePluginTableSchemas(plugin.key, tables);
    if (violations.length) return; // A malformed manifest owns no rows worth touching.

    // On getSystemDb, not the request's tenant transaction — so the delete is
    // committed immediately and a `dropPluginTablesIfUnused` that follows sees the
    // true row count (and does not deadlock trying to DROP a table this same
    // request still holds a lock on). Safety does not rest on RLS here: the builder
    // pins `tenant_id`/`site_id` into the WHERE from the authenticated actor, so it
    // removes exactly this site's rows and only from a table the plugin owns.
    for (const table of tables) {
      const q = buildPluginDelete(table, { tenantId, siteId }, {});
      await getSystemDb().$executeRawUnsafe(q.text, ...q.values);
    }
  }

  /**
   * Drops a plugin's tables — but ONLY when no site anywhere still has the plugin
   * installed, so the global table is genuinely unused.
   *
   * This is the safe form of "drop on uninstall": a shared table is dropped when
   * the LAST install goes, not the first. The count runs on the system client, so
   * it sees installs across every tenant — dropping while another tenant still
   * holds the plugin would nuke their data, and this exists to make that
   * impossible. Guarded like the create path: verified origin, own prefix only,
   * re-validated before a single DROP is emitted.
   */
  async dropPluginTablesIfUnused(pluginKey: string): Promise<void> {
    const sys = getSystemDb();
    const plugin = await sys.plugin.findUnique({
      where: { key: pluginKey },
      include: { versions: { orderBy: { createdAt: "desc" }, take: 1 } },
    });
    const version = plugin?.versions[0];
    if (!plugin || !version || !canOwnPluginTables(version.origin)) return;

    const [siteInstalls, orgInstalls] = await Promise.all([
      sys.sitePlugin.count({ where: { pluginId: plugin.id } }),
      sys.orgPlugin.count({ where: { pluginId: plugin.id } }),
    ]);
    if (siteInstalls + orgInstalls > 0) return; // Still in use somewhere — never drop.

    const manifest = version.manifest as {
      database?: { tables?: PluginTableSchema[] };
    } | null;
    const tables = manifest?.database?.tables ?? [];
    const violations = validatePluginTableSchemas(plugin.key, tables);
    if (violations.length) {
      throw new Error(
        `Refusing to drop tables for ${plugin.key}: ` +
          violations.map((v) => `${v.table} (${v.reason})`).join(", "),
      );
    }

    for (const table of tables) {
      for (const statement of generatePluginTableDropDdl(plugin.key, table)) {
        await sys.$executeRawUnsafe(statement);
      }
    }
  }

  /**
   * Runs a plugin's `teardown()` on deactivation — the mirror of `runSetup`, and
   * like it a dispatch on a plugin that is on its way out of ACTIVE, so it takes a
   * key and resolves the row directly rather than through `activePlugins`.
   *
   * Best-effort by contract: the caller runs this, then flips the install to
   * INACTIVE regardless of the outcome. A plugin is deactivated because the admin
   * said so, not because its teardown agreed — so a throw here is returned, not
   * raised, for the caller to log.
   */
  async runTeardown(
    tenantId: string,
    siteId: string,
    pluginKey: string,
  ): Promise<{ ok: boolean; error?: string }> {
    const row = await getSystemDb().sitePlugin.findFirst({
      where: { tenantId, siteId, plugin: { key: pluginKey } },
      include: { plugin: true, version: true },
    });
    if (!row) return { ok: true };
    // No bundle, no teardown() — deactivating a core-runtime plugin is just the
    // state change and dropping its permission grant.
    if (isCoreRuntimePlugin(row.version.manifest)) return { ok: true };

    // execute() RAISES on any HTTP-level failure — plugin-runtime unreachable, a
    // non-2xx response, a network error or the teardown timeout — as opposed to a
    // handler that merely threw (which comes back as { ok: false }). Both must be
    // caught here: deactivation is best-effort by contract, and the controller
    // relies on that, flipping the plugin to INACTIVE from a returned failure. Left
    // uncaught, a runtime that is down or slow would 500 the deactivate and strand
    // the plugin ACTIVE — the admin could no longer turn it off.
    try {
      const res = await this.execute(tenantId, siteId, this.toTarget(row), {
        kind: "teardown",
      });
      return { ok: res.ok, error: res.error };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
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

  /**
   * Invokes a `call` on ONE named plugin and returns its value.
   *
   * The by-key twin of `callCapability`: used where the caller already knows which
   * plugin must answer — a form submission goes to the plugin that DECLARED that
   * form, not to "whoever provides a capability". Same sandbox path, same
   * fail-loud contract (a waiting caller hears the error).
   */
  async callPlugin(
    tenantId: string,
    siteId: string,
    pluginKey: string,
    name: string,
    payload: Record<string, unknown>,
  ): Promise<unknown> {
    const targets = await this.activePlugins(tenantId, siteId);
    const target = targets.find((t) => t.pluginKey === pluginKey);
    if (!target) {
      throw new NotFoundException(`Plugin ${pluginKey} is not active on this site.`);
    }

    const res = await this.execute(tenantId, siteId, target, { kind: "call", name, payload });
    if (!res.ok) {
      throw new BadGatewayException(
        res.error ?? `Plugin ${pluginKey} failed to answer "${name}".`,
      );
    }
    return res.result;
  }

  /**
   * Finds the active plugin that declared a public form by id, with its
   * definition — read from the installed manifest, never from the request. Returns
   * null when no active plugin on this site owns the form.
   */
  async findForm(
    tenantId: string,
    siteId: string,
    formId: string,
  ): Promise<{ pluginKey: string; form: FormDefinition } | null> {
    const targets = await this.activePlugins(tenantId, siteId);
    for (const target of targets) {
      const form = target.forms.find((f) => f.id === formId);
      if (form) return { pluginKey: target.pluginKey, form };
    }
    return null;
  }

  /**
   * Every public form active on this site, projected for the browser and keyed by
   * id — what the render payload carries so a `core/form` block can render one.
   *
   * This is the public projection boundary for forms, the twin of a capability
   * projector: the plugin declared the fields, core decides they may reach the page
   * (they are all presentational — no handler, no settings, no secrets). First
   * declarer of an id wins, so a duplicate across plugins can't shadow silently.
   *
   * `locale` is the locale being rendered, and it is what turns a plugin's
   * multilingual declaration into one language. A plugin ships one manifest to every
   * site, so its labels may be `{ en, vi, ja }`; resolving them HERE — rather than
   * shipping the map to the browser — is what keeps `FormIsland` a renderer and
   * keeps the payload one language, the same one the page around it is in.
   */
  async publicFormsFor(
    tenantId: string,
    siteId: string,
    locale = "en",
  ): Promise<Record<string, PublicFormDef>> {
    const targets = await this.activePlugins(tenantId, siteId);
    const forms: Record<string, PublicFormDef> = {};
    for (const target of targets) {
      for (const form of target.forms) {
        if (!forms[form.id]) forms[form.id] = toPublicForm(form, locale);
      }
    }
    return forms;
  }

  private async activePlugins(
    tenantId: string,
    siteId: string,
  ): Promise<DispatchTarget[]> {
    const db = getSystemDb();
    // The union of the two activation tiers. Site-scoped plugins are keyed by
    // (site, plugin); org-scoped ones by (tenant, plugin) and reach every site the
    // tenant owns. A given plugin lives in exactly one tier (its catalogue `scope`
    // is fixed and the lifecycle endpoints refuse to install it at the other), so
    // no row can appear in both lists — no de-duplication is needed. An org plugin
    // still executes against the current siteId, so its scoped token and any data
    // it writes are bound to the site being rendered, exactly like a site plugin.
    const [siteRows, orgRows] = await Promise.all([
      db.sitePlugin.findMany({
        where: { tenantId, siteId, status: "ACTIVE" },
        include: { plugin: true, version: true },
      }),
      db.orgPlugin.findMany({
        where: { tenantId, status: "ACTIVE" },
        include: { plugin: true, version: true },
      }),
    ]);

    // A core-runtime plugin has no bundle to dispatch to; it is active for the sake
    // of its capabilities and permissions, not its (non-existent) sandbox handlers.
    return [...siteRows, ...orgRows]
      .filter((row) => !isCoreRuntimePlugin(row.version.manifest))
      .map((row) => this.toTarget(row));
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
      forms?: FormDefinition[];
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
      forms: manifest?.forms ?? [],
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
    if (kind === "setup" || kind === "teardown") return 15_000;
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
        throw await runtimeHttpError(res);
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
