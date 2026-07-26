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
import { normalizeChangelog } from "@zcmsorg/package";
import {
  pluginTablePrefix,
  validatePluginTableSchemas,
  type PluginTableSchema,
} from "@zcmsorg/plugin-sdk";
import {
  PERMISSIONS,
  validateProvidedPermissions,
  type Permission,
  type ProvidedPermission,
} from "@zcmsorg/schemas";
import { invalidHostDeclarations } from "./plugin-egress";
import { Actor, RequirePermissions } from "../auth/decorators";
import { t } from "../common/i18n";
import type { RequestActor } from "../common/request-context";
import { AuditService } from "../audit/audit.module";
import { ApiAuthed, ApiNotFound, ApiZodBody, ApiZodResponse } from "../openapi/decorators";
import { CacheService } from "../redis/cache.service";
import { PluginsService } from "./plugins.service";
import {
  type CatalogPlugin,
  type SettingsSchema,
  coerceSettings,
  derivePluginTier,
} from "./plugins.controller";

/**
 * The ORGANIZATION plugin tier — WordPress's "network-activated" plugins.
 *
 * A plugin whose catalogue `scope` is ORG is installed ONCE for the whole tenant
 * here, not per site, and once active it runs on every site the tenant owns (the
 * resolver in PluginsService unions these rows with each site's own). The lifecycle
 * mirrors the per-site controller — install-with-consent, activate, configure — but
 * there is no X-Site-Id: every method works off `actor.tenantId`, and RLS confines
 * every `db()` query to that tenant.
 *
 * Authority: the same `plugin:install` / `plugin:activate` / `plugin:configure`
 * permissions guard these routes, and those belong to ADMIN and OWNER only — so an
 * org-wide change (which touches all sites) already requires a tenant administrator.
 *
 * Tier is not a choice made here: a plugin is ORG or SITE by its signed manifest,
 * and this controller refuses anything that is not ORG, exactly as the per-site
 * controller refuses an ORG plugin. One plugin, one tier, one install row.
 */
@ApiTags("Org Plugins")
@Controller("org/plugins")
export class OrgPluginsController {
  constructor(
    private readonly cache: CacheService,
    private readonly audit: AuditService,
    private readonly plugins: PluginsService,
  ) {}

  @Get()
  @ApiOperation({
    summary: "The organization-wide plugin catalog, annotated with what the tenant installed",
    description:
      "Only ORG-scoped plugins appear here; per-site plugins are managed on the " +
      "site plugin screen. Install state is the tenant's org-level install, not " +
      "any one site's.",
  })
  @ApiAuthed("plugin:read")
  @ApiZodResponse("CatalogPlugin", { isArray: true })
  @RequirePermissions("plugin:read")
  async catalog(): Promise<CatalogPlugin[]> {
    const catalog = await getSystemDb().plugin.findMany({
      where: { scope: "ORG" },
      include: { versions: { orderBy: { createdAt: "desc" }, take: 1 } },
      orderBy: { name: "asc" },
    });

    const installed = await db().orgPlugin.findMany();
    const byPluginId = new Map(installed.map((i) => [i.pluginId, i]));

    return catalog.map((plugin) => {
      const latest = plugin.versions[0];
      const manifest = (latest?.manifest ?? {}) as {
        capabilities?: string[];
        settingsSchema?: unknown;
        network?: { hosts?: string[] };
        changelog?: unknown;
      };
      const install = byPluginId.get(plugin.id);

      return {
        key: plugin.key,
        name: plugin.name,
        description: plugin.description,
        publisher: plugin.publisher,
        isCore: plugin.isCore,
        scope: plugin.scope,
        tier: derivePluginTier(plugin.isCore, plugin.scope),
        orgActive: install?.status === "ACTIVE",
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
        changelog: normalizeChangelog(manifest.changelog),
      };
    });
  }

  @Post(":key/install")
  @HttpCode(201)
  @ApiOperation({
    summary: "Install an organization-wide plugin, granting it permissions",
    description:
      "The org-tier consent step. As on a site, `grantedPermissions` may narrow " +
      "what the plugin asked for but never widen it. Only ORG-scoped plugins are " +
      "installable here.",
  })
  @ApiParam({ name: "key", description: "Plugin key." })
  @ApiAuthed("plugin:install")
  @ApiZodBody("InstallPluginInput")
  @ApiZodResponse("PluginInstalled", { status: 201, description: "Installed, INACTIVE until activated." })
  @ApiZodResponse("Error", {
    status: 400,
    description: "Unknown or un-requested permission, a per-site plugin, or an illegal declaration.",
  })
  @ApiNotFound("No such plugin, or it has no published version.")
  @RequirePermissions("plugin:install")
  async install(
    @Actor() actor: RequestActor,
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

    // The mirror of the per-site tier guard: a per-site plugin cannot be turned on
    // for a whole organization.
    if (plugin.scope !== "ORG") {
      throw new BadRequestException(t()("errors.plugins.wrongTierOrg", { key }));
    }

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
        t()("errors.plugins.permissionNotRequested", { permissions: overreach.join(", ") }),
      );
    }

    const manifest = (latest.manifest ?? {}) as {
      database?: { tables?: PluginTableSchema[] };
      network?: { hosts?: string[] };
      permissionsProvided?: ProvidedPermission[];
    };
    if (manifest.database?.tables?.length && !plugin.isCore) {
      throw new BadRequestException(t()("errors.plugins.tablesFirstPartyOnly"));
    }
    const violations = validatePluginTableSchemas(plugin.key, manifest.database?.tables);
    if (violations.length) {
      throw new BadRequestException(
        t()("errors.plugins.invalidTables", {
          tables: violations.map((v) => v.table).join(", "),
          prefix: pluginTablePrefix(plugin.key),
        }),
      );
    }

    const badPermissions = validateProvidedPermissions(
      plugin.key,
      plugin.isCore,
      manifest.permissionsProvided,
    );
    if (badPermissions.length) {
      throw new BadRequestException(
        t()("errors.plugins.invalidProvidedPermissions", {
          permissions: badPermissions.map((v) => v.key).join(", "),
        }),
      );
    }

    const badHosts = invalidHostDeclarations(manifest.network?.hosts ?? []);
    if (badHosts.length) {
      throw new BadRequestException(
        t()("errors.plugins.invalidHosts", { hosts: badHosts.join(", ") }),
      );
    }

    const existing = await db().orgPlugin.findFirst({ where: { pluginId: plugin.id } });

    if (existing) {
      await db().orgPlugin.update({
        where: { id: existing.id },
        data: { grantedPermissions: granted, versionId: latest.id },
      });
    } else {
      await db().orgPlugin.create({
        data: {
          tenantId: actor.tenantId,
          pluginId: plugin.id,
          versionId: latest.id,
          status: "INACTIVE",
          grantedPermissions: granted,
          settings: {},
        },
      });
    }

    await this.audit.record(actor, "org-plugin.installed", "plugin", key, {
      requested,
      granted,
    });

    return { ok: true, granted };
  }

  @Post(":key/activate")
  @HttpCode(200)
  @ApiOperation({
    summary: "Activate an organization-wide plugin",
    description:
      "Flips the org install to ACTIVE, after which the plugin runs on every site " +
      "the tenant owns. There is no per-site `setup()` at this tier — an org plugin " +
      "has no single site to set up against, so it initializes lazily in its hooks, " +
      "each of which runs in the context of the site being served.",
  })
  @ApiParam({ name: "key", description: "Plugin key." })
  @ApiAuthed("plugin:activate")
  @ApiZodResponse("PluginActivation", { description: "Active org-wide." })
  @ApiNotFound("The plugin is not installed for this organization.")
  @RequirePermissions("plugin:activate")
  async activate(
    @Actor() actor: RequestActor,
    @Param("key") key: string,
  ): Promise<{ ok: boolean; error?: string }> {
    const row = await this.installRow(key);

    await db().orgPlugin.update({
      where: { id: row.id },
      data: { status: "ACTIVE", lastError: null },
    });

    // Capabilities changed for every site the tenant owns; themes feature-detect
    // on them on every page, so every site's cache must roll over.
    await this.invalidateTenantSites();
    this.plugins.bustProvidedPermissions(actor.tenantId);

    await this.audit.record(actor, "org-plugin.activated", "plugin", key, {
      version: row.version.version,
      grantedPermissions: row.grantedPermissions,
    });

    return { ok: true };
  }

  @Post(":key/deactivate")
  @HttpCode(200)
  @ApiOperation({
    summary: "Deactivate an organization-wide plugin",
    description:
      "Its hooks stop running on every site and its capabilities leave every " +
      "render payload. The install, its granted permissions and its data all stay.",
  })
  @ApiParam({ name: "key", description: "Plugin key." })
  @ApiAuthed("plugin:activate")
  @ApiZodResponse("Ok", { description: "Now INACTIVE." })
  @ApiNotFound("The plugin is not installed for this organization.")
  @RequirePermissions("plugin:activate")
  async deactivate(
    @Actor() actor: RequestActor,
    @Param("key") key: string,
  ): Promise<{ ok: true }> {
    const row = await this.installRow(key);
    await db().orgPlugin.update({ where: { id: row.id }, data: { status: "INACTIVE" } });
    await this.invalidateTenantSites();
    this.plugins.bustProvidedPermissions(actor.tenantId);

    await this.audit.record(actor, "org-plugin.deactivated", "plugin", key, {});

    return { ok: true };
  }

  @Patch(":key/settings")
  @ApiOperation({
    summary: "Configure an organization-wide plugin",
    description:
      "The body is the settings object itself. Keys the plugin's manifest does not " +
      "declare are dropped and declared keys are coerced to their declared type.",
  })
  @ApiParam({ name: "key", description: "Plugin key." })
  @ApiAuthed("plugin:configure")
  @ApiZodBody("SettingsInput")
  @ApiZodResponse("Ok", { description: "Saved." })
  @ApiNotFound("The plugin is not installed for this organization.")
  @RequirePermissions("plugin:configure")
  async settings(
    @Actor() actor: RequestActor,
    @Param("key") key: string,
    @Body() settings: Record<string, unknown>,
  ): Promise<{ ok: true }> {
    const row = await this.installRow(key);

    const version = await getSystemDb().pluginVersion.findUnique({
      where: { id: row.versionId },
      select: { manifest: true },
    });
    const schema = (version?.manifest as { settingsSchema?: SettingsSchema } | null)
      ?.settingsSchema;

    await db().orgPlugin.update({
      where: { id: row.id },
      data: { settings: coerceSettings(schema, settings) as never },
    });
    await this.invalidateTenantSites();

    await this.audit.record(actor, "org-plugin.settings.updated", "plugin", key, {
      keys: Object.keys(settings),
    });

    return { ok: true };
  }

  private async installRow(key: string) {
    const plugin = await getSystemDb().plugin.findUnique({ where: { key } });
    if (!plugin) throw new NotFoundException(t()("errors.plugins.notFound", { key }));

    const row = await db().orgPlugin.findFirst({
      where: { pluginId: plugin.id },
      include: { version: { select: { version: true, bundleUrl: true } } },
    });
    if (!row) throw new NotFoundException(t()("errors.plugins.notInstalledOrg"));

    return row;
  }

  /**
   * An org-tier change affects every site the tenant owns, so every site's render
   * cache has to be rolled. RLS confines the site query to this tenant.
   */
  private async invalidateTenantSites(): Promise<void> {
    const sites = await db().site.findMany({ select: { id: true } });
    await Promise.all(sites.map((s) => this.cache.invalidateSite(s.id)));
  }
}
