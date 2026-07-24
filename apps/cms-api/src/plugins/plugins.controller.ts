import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Patch,
  Post,
} from "@nestjs/common";
import { ApiOperation, ApiParam, ApiTags } from "@nestjs/swagger";
import { db, getSystemDb } from "@zcmsorg/database";
import { pluginTablePrefix, validatePluginTables } from "@zcmsorg/plugin-sdk";
import { invalidHostDeclarations } from "./plugin-egress";
import { PERMISSIONS, type Permission } from "@zcmsorg/schemas";
import { Actor, RequirePermissions, SiteId, SiteScoped } from "../auth/decorators";
import { t } from "../common/i18n";
import type { RequestActor } from "../common/request-context";
import { AuditService } from "../audit/audit.module";
import {
  ApiAuthed,
  ApiNotFound,
  ApiSiteScoped,
  ApiZodBody,
  ApiZodResponse,
} from "../openapi/decorators";
import { CacheService } from "../redis/cache.service";
import { PluginsService } from "./plugins.service";

// Exported so its OpenAPI schema can be type-checked against it. See openapi/registry.ts.
export interface CatalogPlugin {
  key: string;
  name: string;
  description: string | null;
  publisher: string;
  isCore: boolean;
  latestVersion: string | null;
  /** Where the latest version came from — BUILTIN/MARKETPLACE = verified, SIDELOAD = not. */
  origin: string | null;
  /** APPROVED plugins can run; a sideload is QUARANTINED until the operator approves. */
  reviewStatus: string | null;
  /** What the plugin will ask the admin to approve. */
  permissions: Permission[];
  capabilities: string[];
  /**
   * The hosts the plugin declared, straight from its manifest.
   *
   * Sent whether or not it asked for `network:fetch`, because the consent screen
   * has to render the scope and its blast radius together. "This plugin may use
   * the network" is not a thing an admin can approve; "this plugin may reach
   * api.deepl.com" is.
   */
  networkHosts: string[];
  settingsSchema: unknown;
  installed: boolean;
  status: string | null;
  /**
   * Present only when installed. Both are load-bearing for the admin UI:
   *
   * `settings` because the settings form prefills from it — without it the form
   * renders schema defaults, and an admin who opens the page and hits Save wipes
   * the plugin's real configuration. Silent data loss dressed up as a no-op.
   *
   * `grantedPermissions` because the consent screen must show what was actually
   * approved, not what the plugin asked for.
   */
  grantedPermissions: Permission[] | null;
  settings: Record<string, unknown> | null;
  lastError: string | null;
}

interface SettingsSchema {
  properties?: Record<
    string,
    { type?: "string" | "number" | "boolean"; enum?: string[] }
  >;
}

/**
 * Filters a settings payload down to what the plugin's schema actually declares.
 *
 * The settings blob is JSONB written by an admin and read by plugin code, so it
 * is an injection point into the sandbox: without this, any client could store
 * arbitrary keys and shapes, and a plugin reading `settings.foo.bar` would get
 * whatever an attacker put there.
 *
 * Unknown keys are DROPPED, not rejected: a plugin that removes a setting in a
 * new version must not make every existing site's saved settings un-saveable.
 * Wrong types are coerced where that is unambiguous, and skipped where it is not.
 */
function coerceSettings(
  schema: SettingsSchema | undefined,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const properties = schema?.properties;
  // A plugin with no schema declares no settings, so it gets none.
  if (!properties) return {};

  const out: Record<string, unknown> = {};

  for (const [key, def] of Object.entries(properties)) {
    if (!(key in input)) continue;
    const value = input[key];
    if (value === null || value === undefined) continue;

    switch (def.type) {
      case "boolean":
        out[key] = value === true || value === "true";
        break;
      case "number": {
        const n = Number(value);
        if (!Number.isNaN(n)) out[key] = n;
        break;
      }
      default: {
        const s = String(value);
        // An enum is a closed set; a value outside it is not a setting.
        if (def.enum?.length && !def.enum.includes(s)) break;
        out[key] = s;
      }
    }
  }

  return out;
}

@ApiTags("Plugins")
@Controller("plugins")
export class PluginsController {
  constructor(
    private readonly plugins: PluginsService,
    private readonly cache: CacheService,
    private readonly audit: AuditService,
  ) {}

  /**
   * The marketplace, annotated with what this site has already installed.
   *
   * The catalog is platform data (system client); the install state is tenant
   * data (RLS-scoped). Both in one response so the admin does not have to
   * correlate two lists.
   */
  @Get()
  @SiteScoped()
  @ApiOperation({
    summary: "The plugin catalog, annotated with what this site has installed",
    description:
      "Catalog data is platform-wide; install state is this site's. Both come " +
      "back in one response so the admin does not have to correlate two lists. " +
      "`permissions` is what the plugin *asks* for; `grantedPermissions` is what " +
      "was actually approved — the consent screen must show the difference.",
  })
  @ApiSiteScoped()
  @ApiAuthed("plugin:read")
  @ApiZodResponse("CatalogPlugin", { isArray: true })
  @RequirePermissions("plugin:read")
  async catalog(@SiteId() siteId: string): Promise<CatalogPlugin[]> {
    const catalog = await getSystemDb().plugin.findMany({
      include: { versions: { orderBy: { createdAt: "desc" }, take: 1 } },
      orderBy: { name: "asc" },
    });

    const installed = await db().sitePlugin.findMany({ where: { siteId } });
    const byPluginId = new Map(installed.map((i) => [i.pluginId, i]));

    return catalog.map((plugin) => {
      const latest = plugin.versions[0];
      const manifest = (latest?.manifest ?? {}) as {
        capabilities?: string[];
        settingsSchema?: unknown;
        network?: { hosts?: string[] };
      };
      const install = byPluginId.get(plugin.id);

      return {
        key: plugin.key,
        name: plugin.name,
        description: plugin.description,
        publisher: plugin.publisher,
        isCore: plugin.isCore,
        latestVersion: latest?.version ?? null,
        origin: latest?.origin ?? null,
        reviewStatus: latest?.reviewStatus ?? null,
        permissions: (latest?.permissions ?? []) as Permission[],
        capabilities: manifest.capabilities ?? [],
        networkHosts: manifest.network?.hosts ?? [],
        settingsSchema: manifest.settingsSchema ?? null,
        installed: Boolean(install),
        status: install?.status ?? null,
        grantedPermissions: install
          ? ((install.grantedPermissions ?? []) as Permission[])
          : null,
        settings: install
          ? ((install.settings ?? {}) as Record<string, unknown>)
          : null,
        lastError: install?.lastError ?? null,
      };
    });
  }

  /**
   * Installs a plugin, with explicit consent.
   *
   * The admin must send back the permissions they are granting. This is not
   * ceremony: `grantedPermissions` is what ends up in the plugin's token, and
   * an admin may grant a SUBSET of what the plugin asked for. A plugin that
   * requested `content:update` but was granted only `content:read` will be
   * rejected by the gateway the first time it tries to write.
   *
   * Granting something the plugin never asked for is refused too — a plugin's
   * privileges must not be able to grow behind its manifest's back.
   */
  @Post(":key/install")
  @SiteScoped()
  @HttpCode(201)
  @ApiOperation({
    summary: "Install a plugin, granting it permissions",
    description:
      "This is the consent step. `grantedPermissions` may narrow what the plugin " +
      "asked for, never widen it: naming a permission the plugin did not request " +
      "is rejected, so a compromised admin UI cannot quietly hand a plugin more " +
      "than the user saw. Omit the field to grant exactly what was requested.",
  })
  @ApiParam({ name: "key", description: 'Plugin key, e.g. "zsoft-seo".' })
  @ApiSiteScoped()
  @ApiAuthed("plugin:install")
  @ApiZodBody("InstallPluginInput")
  @ApiZodResponse("PluginInstalled", { status: 201, description: "Installed, INACTIVE until activated." })
  @ApiZodResponse("Error", {
    status: 400,
    description: "Unknown permission, one the plugin never requested, or an illegal table declaration.",
  })
  @ApiNotFound("No such plugin, or it has no published version.")
  @RequirePermissions("plugin:install")
  async install(
    @Actor() actor: RequestActor,
    @SiteId() siteId: string,
    @Param("key") key: string,
    @Body() body: { grantedPermissions?: string[] },
  ): Promise<{ ok: true; granted: Permission[] }> {
    const plugin = await getSystemDb().plugin.findUnique({
      where: { key },
      include: { versions: { orderBy: { createdAt: "desc" }, take: 1 } },
    });
    if (!plugin) throw new NotFoundException(t()("errors.plugins.notFound", { key }));

    const latest = plugin.versions[0];
    if (!latest) throw new NotFoundException(t()("errors.plugins.noVersion", { key }));

    const requested = (latest.permissions ?? []) as Permission[];
    const granted = (body.grantedPermissions ?? []) as Permission[];

    const unknown = granted.filter((p) => !PERMISSIONS.includes(p));
    if (unknown.length) {
      throw new BadRequestException(
        t()("errors.plugins.unknownPermissions", { permissions: unknown.join(", ") }),
      );
    }

    const overreach = granted.filter((p) => !requested.includes(p));
    if (overreach.length) {
      throw new BadRequestException(
        t()("errors.plugins.permissionNotRequested", {
          permissions: overreach.join(", "),
        }),
      );
    }

    // A plugin may own tables, but only ones named after itself. Checked here,
    // before the plugin exists on this site and before a line of its code has
    // run — a plugin that declares `content` or `users` never gets installed, so
    // it never gets the chance to migrate them.
    const manifest = (latest.manifest ?? {}) as {
      database?: { tables?: string[] };
      network?: { hosts?: string[] };
    };
    const violations = validatePluginTables(plugin.key, manifest.database?.tables);
    if (violations.length) {
      throw new BadRequestException(
        t()("errors.plugins.invalidTables", {
          tables: violations.map((v) => v.table).join(", "),
          prefix: pluginTablePrefix(plugin.key),
        }),
      );
    }

    // Same idea, for the hosts it may reach: a declaration that cannot be read is
    // a declaration that cannot be consented to. `*`, an IP literal, a scheme or a
    // port are all refused here rather than at the moment the plugin first dials —
    // the admin is looking at the consent screen now, and they will not be then.
    const badHosts = invalidHostDeclarations(manifest.network?.hosts ?? []);
    if (badHosts.length) {
      throw new BadRequestException(
        t()("errors.plugins.invalidHosts", { hosts: badHosts.join(", ") }),
      );
    }

    const existing = await db().sitePlugin.findFirst({
      where: { siteId, pluginId: plugin.id },
    });

    if (existing) {
      await db().sitePlugin.update({
        where: { id: existing.id },
        data: { grantedPermissions: granted, versionId: latest.id },
      });
    } else {
      await db().sitePlugin.create({
        data: {
          tenantId: actor.tenantId,
          siteId,
          pluginId: plugin.id,
          versionId: latest.id,
          status: "INACTIVE",
          grantedPermissions: granted,
          settings: {},
        },
      });
    }

    await db().auditLog.create({
      data: {
        tenantId: actor.tenantId,
        siteId,
        actorId: actor.userId,
        action: "plugin.installed",
        resourceType: "plugin",
        resourceId: key,
        metadata: { requested, granted } as never,
      },
    });

    return { ok: true, granted };
  }

  @Post(":key/activate")
  @SiteScoped()
  @HttpCode(200)
  @ApiOperation({
    summary: "Activate an installed plugin",
    description:
      "Runs the plugin's `setup()` in the sandbox first, and only a clean run " +
      "flips the status to ACTIVE — the reverse order would leave a plugin " +
      "advertising capabilities its setup was about to fail. A plugin that " +
      "throws answers 200 with `ok: false`: the request was fine, the plugin " +
      "was not.",
  })
  @ApiParam({ name: "key", description: 'Plugin key, e.g. "zsoft-seo".' })
  @ApiSiteScoped()
  @ApiAuthed("plugin:activate")
  @ApiZodResponse("PluginActivation", { description: "Active, or ERROR with the plugin's own message." })
  @ApiNotFound("The plugin is not installed on this site.")
  @RequirePermissions("plugin:activate")
  async activate(
    @Actor() actor: RequestActor,
    @SiteId() siteId: string,
    @Param("key") key: string,
  ): Promise<{ ok: boolean; error?: string }> {
    const row = await this.installRow(siteId, key);

    // setup() runs FIRST, and only a successful run flips the status.
    //
    // The obvious order — mark ACTIVE, then run setup — leaves a window where a
    // plugin whose setup is about to throw is already advertising itself as
    // running: its capabilities go into render payloads and its hooks start
    // firing. A plugin is active because it started, not before it tried.
    try {
      await this.plugins.runSetup(actor.tenantId, siteId, key);
    } catch (err) {
      const message = (err as Error).message;
      await db().sitePlugin.update({
        where: { id: row.id },
        data: { status: "FAILED", lastError: message },
      });
      return { ok: false, error: message };
    }

    await db().sitePlugin.update({
      where: { id: row.id },
      data: { status: "ACTIVE", lastError: null },
    });

    // Capabilities changed, and themes feature-detect on them on every page.
    await this.cache.invalidateSite(siteId);

    await this.audit.record(actor, "plugin.activated", "plugin", key, {
      version: row.version.version,
      grantedPermissions: row.grantedPermissions,
    });

    return { ok: true };
  }

  @Post(":key/deactivate")
  @SiteScoped()
  @HttpCode(200)
  @ApiOperation({
    summary: "Deactivate a plugin",
    description:
      "Its hooks stop running and its capabilities leave the render payload. " +
      "The install, its granted permissions and its data all stay — this is a " +
      "switch, not an uninstall.",
  })
  @ApiParam({ name: "key", description: 'Plugin key, e.g. "zsoft-seo".' })
  @ApiSiteScoped()
  @ApiAuthed("plugin:activate")
  @ApiZodResponse("Ok", { description: "Now INACTIVE." })
  @ApiNotFound("The plugin is not installed on this site.")
  @RequirePermissions("plugin:activate")
  async deactivate(
    @Actor() actor: RequestActor,
    @SiteId() siteId: string,
    @Param("key") key: string,
  ): Promise<{ ok: true }> {
    const row = await this.installRow(siteId, key);
    await db().sitePlugin.update({
      where: { id: row.id },
      data: { status: "INACTIVE" },
    });
    await this.cache.invalidateSite(siteId);

    await this.audit.record(actor, "plugin.deactivated", "plugin", key, {});

    return { ok: true };
  }

  @Patch(":key/settings")
  @SiteScoped()
  @ApiOperation({
    summary: "Configure a plugin",
    description:
      "The body is the settings object itself. Keys the plugin's manifest does " +
      "not declare are dropped, and declared keys are coerced to their declared " +
      "type — this blob is written by an admin and read by plugin code, which is " +
      "not a boundary to be permissive at.",
  })
  @ApiParam({ name: "key", description: 'Plugin key, e.g. "zsoft-seo".' })
  @ApiSiteScoped()
  @ApiAuthed("plugin:configure")
  @ApiZodBody("SettingsInput")
  @ApiZodResponse("Ok", { description: "Saved." })
  @ApiNotFound("The plugin is not installed on this site.")
  @RequirePermissions("plugin:configure")
  async settings(
    @Actor() actor: RequestActor,
    @SiteId() siteId: string,
    @Param("key") key: string,
    @Body() settings: Record<string, unknown>,
  ): Promise<{ ok: true }> {
    const row = await this.installRow(siteId, key);

    const version = await getSystemDb().pluginVersion.findUnique({
      where: { id: row.versionId },
      select: { manifest: true },
    });
    const schema = (version?.manifest as { settingsSchema?: SettingsSchema } | null)
      ?.settingsSchema;

    await db().sitePlugin.update({
      where: { id: row.id },
      data: { settings: coerceSettings(schema, settings) as never },
    });
    await this.cache.invalidateSite(siteId);

    await this.audit.record(actor, "plugin.settings.updated", "plugin", key, {
      keys: Object.keys(settings),
    });

    return { ok: true };
  }

  private async installRow(siteId: string, key: string) {
    const plugin = await getSystemDb().plugin.findUnique({ where: { key } });
    if (!plugin) throw new NotFoundException(t()("errors.plugins.notFound", { key }));

    const row = await db().sitePlugin.findFirst({
      where: { siteId, pluginId: plugin.id },
      include: { version: { select: { version: true, bundleUrl: true } } },
    });
    if (!row) throw new NotFoundException(t()("errors.plugins.notInstalled"));

    return row;
  }
}
