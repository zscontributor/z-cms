import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Module,
  NotFoundException,
  Param,
  Patch,
  Post,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { ApiOperation, ApiParam, ApiTags } from "@nestjs/swagger";
import { db, getSystemDb } from "@zcmsorg/database";
import { BlockDocumentSchema } from "@zcmsorg/schemas";
import { Actor, RequirePermissions, SiteId, SiteScoped } from "../auth/decorators";
import { t } from "../common/i18n";
import { sanitizeBlocks } from "../common/sanitize-blocks";
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

/**
 * Ceilings on what one theme's demo data may write into a customer's site.
 *
 * A theme is a package from a marketplace: code and JSON written by a stranger, and
 * `theme.json` is untrusted input no matter how well the theme renders. Demo data
 * exists to show a buyer what the theme looks like with a site in it — a landing
 * page, a few posts, a nav bar. Nothing legitimate needs more than this, so a
 * manifest asking for more is either broken or hostile, and either way the answer is
 * the same: refuse the whole seed, loudly, before the first row is written.
 *
 * Without these, `demo.contents` is an unbounded array that this endpoint would
 * happily turn into 50,000 INSERTs against the customer's database.
 */
const MAX_DEMO_CONTENTS = 200;
const MAX_DEMO_CONTENT_TYPES = 20;
const MAX_DEMO_MENUS = 20;

// Exported so the OpenAPI schemas can be type-checked against them: a field
// added here without one added there is a build error, not a stale document.
export interface CatalogTheme {
  key: string;
  name: string;
  description: string | null;
  author: string;
  isCore: boolean;
  versions: { version: string; origin: string; reviewStatus: string }[];
}

export interface InstalledTheme {
  key: string;
  name: string;
  version: string;
  status: string;
  /** Where this version came from — BUILTIN/MARKETPLACE = verified, SIDELOAD = not. */
  origin: string;
  /** APPROVED versions render; a sideload is QUARANTINED until the operator approves. */
  reviewStatus: string;
  settings: Record<string, unknown>;
  settingsSchema: unknown;
  demoAvailable: boolean;
  demoSeeded: boolean;
}

interface ThemeDemoMenuItem {
  label: string;
  url: string;
  target?: string;
  children?: ThemeDemoMenuItem[];
}

interface ThemeDemoData {
  settings?: Record<string, unknown>;
  contentTypes?: {
    key: string;
    name: string;
    pluralName: string;
    description?: string;
    isSingleton?: boolean;
    isRoutable?: boolean;
    routePrefix?: string;
    hasBlocks?: boolean;
    icon?: string;
    fields?: unknown[];
  }[];
  contents?: {
    contentType: string;
    locale: string;
    slug: string;
    title: string;
    translationGroup?: string;
    excerpt?: string;
    data?: Record<string, unknown>;
    blocks?: unknown[];
    seo?: Record<string, unknown>;
    status?: string;
    publishedAt?: string;
  }[];
  menus?: {
    key: string;
    name: string;
    items: ThemeDemoMenuItem[];
  }[];
}

@ApiTags("Themes")
@Controller("themes")
// Exported so the demo-seed gates (block validation, sanitising, the size caps)
// can be tested directly — they are the security boundary in front of untrusted
// marketplace manifests, and an untested boundary is a decorative one.
export class ThemesController {
  constructor(
    private readonly cache: CacheService,
    private readonly audit: AuditService,
  ) {}

  /**
   * The marketplace catalog. Platform-level data shared by every tenant, so it
   * is read through the system client — there is no tenant to scope it to.
   */
  @Get()
  @ApiOperation({
    summary: "The theme catalog",
    description: "Every theme on the platform, newest version first. Not site-scoped.",
  })
  @ApiAuthed("theme:read")
  @ApiZodResponse("CatalogTheme", { isArray: true })
  @RequirePermissions("theme:read")
  async catalog(): Promise<CatalogTheme[]> {
    const themes = await getSystemDb().theme.findMany({
      include: {
        versions: {
          select: { version: true, origin: true, reviewStatus: true },
          orderBy: { createdAt: "desc" },
        },
      },
      orderBy: { name: "asc" },
    });

    return themes.map((t) => ({
      key: t.key,
      name: t.name,
      description: t.description,
      author: t.author,
      isCore: t.isCore,
      versions: t.versions,
    }));
  }

  @Get("installed")
  @SiteScoped()
  @ApiOperation({
    summary: "Themes installed on this site",
    description:
      "Includes each theme's `settingsSchema`, which the admin renders the " +
      "settings form from — a theme can add an option without a change to admin-web.",
  })
  @ApiSiteScoped()
  @ApiAuthed("theme:read")
  @ApiZodResponse("InstalledTheme", { isArray: true })
  @RequirePermissions("theme:read")
  async installed(@SiteId() siteId: string): Promise<InstalledTheme[]> {
    const rows = await db().siteTheme.findMany({
      where: { siteId },
      include: { theme: true, version: true },
      orderBy: { createdAt: "asc" },
    });

    const seededKeys = new Set(
      (
        await db().content.findMany({
          where: {
            siteId,
            demoThemeKey: { in: rows.map((row) => row.theme.key) },
          },
          distinct: ["demoThemeKey"],
          select: { demoThemeKey: true },
        })
      )
        .map((row) => row.demoThemeKey)
        .filter((key): key is string => Boolean(key)),
    );

    return rows.map((row) => {
      const manifest = row.version.manifest as Record<string, unknown> | null;
      return {
        key: row.theme.key,
        name: row.theme.name,
        version: row.version.version,
        status: row.status,
        origin: row.version.origin,
        reviewStatus: row.version.reviewStatus,
        settings: (row.settings ?? {}) as Record<string, unknown>,
        // The admin renders the settings form straight from this schema, so a
        // theme can add an option without any change to admin-web.
        settingsSchema: manifest?.settingsSchema ?? null,
        demoAvailable: Boolean(manifest?.demo),
        demoSeeded: seededKeys.has(row.theme.key),
      };
    });
  }

  @Post(":key/activate")
  @SiteScoped()
  @HttpCode(200)
  @ApiOperation({
    summary: "Activate a theme on this site",
    description:
      "Installs it on first use, so activation is one click. Exactly one theme " +
      "is active per site: this runs in the request transaction, so a failure " +
      "cannot leave a site with two active themes — or none.",
  })
  @ApiParam({ name: "key", description: 'Theme key, e.g. "zsoft-blog".' })
  @ApiSiteScoped()
  @ApiAuthed("theme:activate")
  @ApiZodResponse("Ok", { description: "Active. Cached pages for this site are invalidated." })
  @ApiNotFound("No such theme, or it has no published version.")
  @RequirePermissions("theme:activate")
  async activate(
    @Actor() actor: RequestActor,
    @SiteId() siteId: string,
    @Param("key") key: string,
  ): Promise<{ ok: true }> {
    const theme = await getSystemDb().theme.findUnique({
      where: { key },
      include: { versions: { orderBy: { createdAt: "desc" }, take: 1 } },
    });
    if (!theme) throw new NotFoundException(t()("errors.themes.notFound", { key }));

    const latest = theme.versions[0];
    if (!latest) throw new NotFoundException(t()("errors.themes.noVersion", { key }));

    // Installing on first activation keeps the admin flow to a single click,
    // while still recording an explicit SiteTheme row (which is what carries the
    // per-site settings and, later, the plugin-style install status).
    const existing = await db().siteTheme.findFirst({ where: { siteId, themeId: theme.id } });

    // Exactly one active theme per site. Runs inside the request transaction, so
    // a failure here cannot leave a site with two active themes — or none.
    await db().siteTheme.updateMany({
      where: { siteId, status: "ACTIVE" },
      data: { status: "INACTIVE" },
    });

    if (existing) {
      await db().siteTheme.update({
        where: { id: existing.id },
        data: { status: "ACTIVE", versionId: latest.id },
      });
    } else {
      await db().siteTheme.create({
        data: {
          tenantId: actor.tenantId,
          siteId,
          themeId: theme.id,
          versionId: latest.id,
          status: "ACTIVE",
          settings: {},
        },
      });
    }

    await this.cache.invalidateSite(siteId);

    // A theme change repaints every page of the site. It is exactly the kind of
    // "why does the site look different?" question an audit log exists for.
    await this.audit.record(actor, "theme.activated", "theme", key, {
      version: latest.version,
    });

    return { ok: true };
  }

  @Patch(":key/settings")
  @SiteScoped()
  @ApiOperation({
    summary: "Configure a theme",
    description:
      "The body is the settings object itself, not a wrapper. Keys the theme's " +
      "`settingsSchema` does not declare are dropped rather than stored — an " +
      "admin writing a blob that theme code later reads is not a place to be " +
      "permissive.",
  })
  @ApiParam({ name: "key", description: 'Theme key, e.g. "zsoft-blog".' })
  @ApiSiteScoped()
  @ApiAuthed("theme:configure")
  @ApiZodBody("SettingsInput")
  @ApiZodResponse("Ok", { description: "Saved. Cached pages for this site are invalidated." })
  @ApiNotFound("No such theme, or it is not installed on this site.")
  @RequirePermissions("theme:configure")
  async updateSettings(
    @Actor() actor: RequestActor,
    @SiteId() siteId: string,
    @Param("key") key: string,
    @Body() settings: Record<string, unknown>,
  ): Promise<{ ok: true }> {
    const theme = await getSystemDb().theme.findUnique({ where: { key } });
    if (!theme) throw new NotFoundException(t()("errors.themes.notFound", { key }));

    const row = await db().siteTheme.findFirst({ where: { siteId, themeId: theme.id } });
    if (!row) throw new NotFoundException(t()("errors.themes.notInstalled"));

    await db().siteTheme.update({
      where: { id: row.id },
      data: { settings: settings as never },
    });

    // Theme settings affect every page (header, colours, footer), so the whole
    // site's render cache is stale, not just one path.
    await this.cache.invalidateSite(siteId);

    await this.audit.record(actor, "theme.settings.updated", "theme", key, {
      keys: Object.keys(settings),
    });

    return { ok: true };
  }

  @Post("active/demo-seed")
  @SiteScoped()
  @HttpCode(200)
  @ApiOperation({
    summary: "Seed demo data for the active theme",
    description:
      "Replaces only rows owned by the active theme's demo data. Normal content " +
      "and demo rows owned by other themes are left untouched.",
  })
  @ApiSiteScoped()
  @ApiAuthed("theme:configure")
  @ApiZodResponse("Ok", { description: "Demo data created and cache invalidated." })
  @RequirePermissions("theme:configure")
  async seedActiveDemo(
    @Actor() actor: RequestActor,
    @SiteId() siteId: string,
  ): Promise<{ ok: true; themeKey: string; content: number; menus: number }> {
    const active = await db().siteTheme.findFirst({
      where: { siteId, status: "ACTIVE" },
      include: { theme: true, version: true },
    });
    if (!active) throw new NotFoundException(t()("errors.render.noActiveTheme"));

    const themeKey = active.theme.key;
    const manifest = active.version.manifest as { demo?: ThemeDemoData } | null;
    const demo = manifest?.demo;
    if (!demo) {
      throw new BadRequestException(`Theme "${themeKey}" does not provide demo data.`);
    }

    const contentTypes = demo.contentTypes ?? [];
    const contents = demo.contents ?? [];
    const menus = demo.menus ?? [];
    const now = new Date();

    // Size gate, BEFORE the deleteMany below. Rejecting an oversized manifest must
    // not first destroy the demo rows the site already had.
    if (contents.length > MAX_DEMO_CONTENTS) {
      throw new BadRequestException(
        `Theme "${themeKey}" demo declares ${contents.length} contents; the limit is ${MAX_DEMO_CONTENTS}.`,
      );
    }
    if (contentTypes.length > MAX_DEMO_CONTENT_TYPES) {
      throw new BadRequestException(
        `Theme "${themeKey}" demo declares ${contentTypes.length} content types; the limit is ${MAX_DEMO_CONTENT_TYPES}.`,
      );
    }
    if (menus.length > MAX_DEMO_MENUS) {
      throw new BadRequestException(
        `Theme "${themeKey}" demo declares ${menus.length} menus; the limit is ${MAX_DEMO_MENUS}.`,
      );
    }

    /**
     * The demo's block trees, validated and sanitised UP FRONT — all of them, before
     * a single row is written.
     *
     * `BlockDocumentSchema` is the same gate the content API puts in front of an
     * editor's blocks, including its depth limit, and this path used to skip it
     * entirely: a marketplace theme's `theme.json` was written to the database raw.
     * Validating here rather than inside the write loop means a malformed tree on the
     * 150th item fails the request cleanly instead of leaving 149 rows behind it.
     */
    const blocksByIndex = contents.map((item, i) => {
      const parsed = BlockDocumentSchema.safeParse(item.blocks ?? []);
      if (!parsed.success) {
        throw new BadRequestException(
          `Theme "${themeKey}" demo content #${i + 1} ("${item.slug}") has invalid blocks: ${parsed.error.issues[0]?.message ?? "unknown error"}`,
        );
      }
      // Same sanitiser the editor's writes go through — a theme does not get a
      // private door into `dangerouslySetInnerHTML`.
      return sanitizeBlocks(parsed.data);
    });

    await db().menu.deleteMany({ where: { siteId, demoThemeKey: themeKey } });
    await db().content.deleteMany({ where: { siteId, demoThemeKey: themeKey } });

    const typeByKey = new Map<string, string>();
    for (const item of contentTypes) {
      if (!item.key || !item.name || !item.pluralName) {
        throw new BadRequestException("Theme demo contentTypes require key, name and pluralName.");
      }

      const row = await db().contentType.upsert({
        where: { siteId_key: { siteId, key: item.key } },
        // Demo seeding must not reshape an existing site's content model.
        // Existing content types are reused as-is; missing ones are created.
        update: {},
        create: {
          tenantId: actor.tenantId,
          siteId,
          key: item.key,
          name: item.name,
          pluralName: item.pluralName,
          description: item.description ?? null,
          isSingleton: item.isSingleton ?? false,
          isRoutable: item.isRoutable ?? true,
          routePrefix: item.routePrefix ?? "",
          hasBlocks: item.hasBlocks ?? true,
          icon: item.icon ?? null,
          fields: (item.fields ?? []) as never,
        },
      });
      typeByKey.set(item.key, row.id);
    }

    const groups = new Map<string, string>();
    for (const [index, item] of contents.entries()) {
      const contentTypeId = typeByKey.get(item.contentType);
      if (!contentTypeId) {
        throw new BadRequestException(
          `Theme demo content references unknown content type "${item.contentType}".`,
        );
      }

      const groupKey = item.translationGroup ?? `${item.contentType}:${item.slug}:${item.locale}`;
      const translationGroupId = groups.get(groupKey) ?? randomUUID();
      groups.set(groupKey, translationGroupId);

      await db().content.create({
        data: {
          tenantId: actor.tenantId,
          siteId,
          contentTypeId,
          locale: item.locale,
          translationGroupId,
          slug: item.slug,
          title: item.title,
          excerpt: item.excerpt ?? null,
          data: (item.data ?? {}) as never,
          // Validated by BlockDocumentSchema and sanitised above, not trusted here.
          blocks: blocksByIndex[index] as never,
          seo: (item.seo ?? {}) as never,
          status: (item.status ?? "PUBLISHED") as never,
          publishedAt: item.publishedAt ? new Date(item.publishedAt) : now,
          authorId: actor.userId,
          demoThemeKey: themeKey,
        },
      });
    }

    for (const menu of menus) {
      const row = await db().menu.create({
        data: {
          tenantId: actor.tenantId,
          siteId,
          key: menu.key,
          name: menu.name,
          demoThemeKey: themeKey,
        },
      });
      await this.createDemoMenuItems(actor.tenantId, row.id, menu.items ?? []);
    }

    if (demo.settings) {
      await db().siteTheme.update({
        where: { id: active.id },
        data: {
          settings: {
            ...((active.settings ?? {}) as Record<string, unknown>),
            ...demo.settings,
          } as never,
        },
      });
    }

    await this.cache.invalidateSite(siteId);
    await this.audit.record(actor, "theme.demo.seeded", "theme", themeKey, {
      content: contents.length,
      menus: menus.length,
    });

    return { ok: true, themeKey, content: contents.length, menus: menus.length };
  }

  private async createDemoMenuItems(
    tenantId: string,
    menuId: string,
    items: ThemeDemoMenuItem[],
    parentId: string | null = null,
  ): Promise<void> {
    for (const [index, item] of items.entries()) {
      const row = await db().menuItem.create({
        data: {
          tenantId,
          menuId,
          parentId,
          label: item.label,
          url: item.url,
          target: item.target ?? "_self",
          order: index,
        },
      });

      if (item.children?.length) {
        await this.createDemoMenuItems(tenantId, menuId, item.children, row.id);
      }
    }
  }
}

@Module({ controllers: [ThemesController] })
export class ThemesModule {}
