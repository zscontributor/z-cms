import {
  Body,
  ConflictException,
  Controller,
  Get,
  Module,
  NotFoundException,
  Param,
  Patch,
  Post,
} from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { db, installCorePlugins, type Prisma } from "@zcmsorg/database";
import { parseSiteBrand, type SiteBrand, type SiteDto } from "@zcmsorg/schemas";
import type { z } from "zod";
import { Actor, RequirePermissions } from "../auth/decorators";
import { t } from "../common/i18n";
import { toSiteDto } from "../common/mappers";
import type { RequestActor } from "../common/request-context";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import {
  ApiAuthed,
  ApiNotFound,
  ApiZodBody,
  ApiZodResponse,
} from "../openapi/decorators";
import { CreateSiteSchema, UpdateSiteSchema } from "../openapi/registry";
import { CacheService } from "../redis/cache.service";

const SITE_INCLUDE = {
  domains: { select: { id: true, hostname: true, isPrimary: true } },
  themes: {
    where: { status: "ACTIVE" as const },
    select: {
      status: true,
      theme: { select: { key: true, name: true } },
      version: { select: { version: true } },
    },
  },
} as const;

/**
 * The languages a new Z-CMS site ships in when the caller does not name its own.
 *
 * Vietnamese first — it is also the default `defaultLocale` — then English and
 * Japanese, the three the platform is translated into out of the box. A trilingual
 * site is what lets the default theme's language switcher exist from day one; on a
 * single-locale site it renders nothing, because there is nowhere to switch to.
 * `create()` still guarantees the site's own `defaultLocale` is in the list, so a
 * caller who picks a fourth language as default keeps it alongside these.
 */
const DEFAULT_SITE_LOCALES = ["vi", "en", "ja"] as const;

/**
 * A site's brand lives in `Site.settings`, under a `brand` key.
 *
 * The column already existed and nothing read it, so a site's colour and logo cost
 * no migration and no new table — and the next site-level setting can arrive the
 * same way. Everything ELSE already in `settings` is preserved: a PATCH of the
 * brand must not silently drop a key some other feature put there.
 */
function settingsWithBrand(existing: unknown, brand: SiteBrand): Record<string, unknown> {
  const base = (existing ?? {}) as Record<string, unknown>;
  return { ...base, brand };
}

/**
 * The `page` type and a homepage, so a new site can actually answer a request.
 *
 * Without this a created site is a dead end, and not obviously so: it has a domain,
 * it can be published, it can have a theme — and it still 404s on "/", because
 * site-runtime resolves the homepage to the content row whose slug is the empty
 * string, and there is no content row. Worse, the owner cannot fix it from the UI:
 * content types were only ever created by the seed, so there is no type to file a
 * page under and no way to make one on the way to making a page.
 *
 * So the type and the page come with the site. The page is PUBLISHED — a homepage
 * held back as a draft would reproduce the same empty "/" this exists to prevent.
 * That is not the same as publishing the SITE, which is still opt-in: a DRAFT site
 * serves nothing regardless of what content it holds.
 */
async function seedStarterContent(
  tenantId: string,
  siteId: string,
  authorId: string,
  locale: string,
): Promise<void> {
  const page = await db().contentType.create({
    data: {
      tenantId,
      siteId,
      key: "page",
      name: "Page",
      pluralName: "Pages",
      // Empty prefix: pages live at the root, and "/" resolves into this type.
      routePrefix: "",
      hasBlocks: true,
      icon: "file-text",
      fields: [],
    },
  });

  await db().content.create({
    data: {
      tenantId,
      siteId,
      contentTypeId: page.id,
      // The empty slug IS the homepage — see RenderService.findContent.
      slug: "",
      locale,
      title: "Hello",
      status: "PUBLISHED",
      publishedAt: new Date(),
      authorId,
      seo: {},
      blocks: [
        {
          id: "hero",
          type: "core/hero",
          props: {
            heading: "Hello, welcome to z-cms!",
            subheading:
              "Your site is live. Edit this page in the admin to make it yours.",
          },
        },
      ] as Prisma.InputJsonValue,
    },
  });
}

@ApiTags("Sites")
@Controller("sites")
export class SitesController {
  constructor(private readonly cache: CacheService) {}

  /**
   * No tenant filter in the where clause, and none is needed: this query runs
   * inside withTenant(), so RLS restricts it to the caller's own sites.
   */
  @Get()
  @ApiOperation({
    summary: "List your sites",
    description:
      "Every site in your tenant, with its domains, brand and active theme. This " +
      "is where an `X-Site-Id` for the other routes comes from. Row-level security " +
      "scopes the query, so another tenant's sites cannot appear here.",
  })
  @ApiAuthed("site:read")
  @ApiZodResponse("SiteDto", { isArray: true })
  @RequirePermissions("site:read")
  async list(): Promise<SiteDto[]> {
    const sites = await db().site.findMany({
      include: SITE_INCLUDE,
      orderBy: { createdAt: "asc" },
    });
    return sites.map(toSiteDto);
  }

  @Get(":id")
  @ApiOperation({ summary: "Read one site" })
  @ApiAuthed("site:read")
  @ApiZodResponse("SiteDto")
  @ApiNotFound("No such site — or not one of yours. The two are the same answer on purpose.")
  @RequirePermissions("site:read")
  async findOne(@Param("id") id: string): Promise<SiteDto> {
    const site = await db().site.findUnique({ where: { id }, include: SITE_INCLUDE });
    if (!site) throw new NotFoundException(t()("errors.sites.notFound"));
    return toSiteDto(site);
  }

  /**
   * Creates a site, the domain it answers on, and the page it answers WITH — atomically.
   *
   * The domain is not optional and not a second call. site-runtime resolves a site
   * from the Host header and nothing else, so a site with no domain is a row no
   * request can ever reach — a create that left it that way would hand back a
   * "site" that is not yet a site. Either both rows exist or neither does.
   *
   * The same argument runs one step further, which is why `seedStarterContent` is
   * here too: a site with a domain but no homepage resolves and then 404s, and its
   * owner cannot repair it from the admin because a site with no content type has
   * nothing to file a page under. See that function.
   *
   * There is no `$transaction` here and there must not be one: `withTenant` already
   * runs the whole request inside a transaction (that is how `app.tenant_id` stays
   * bound to the connection for RLS), and `TenantClient` therefore has no
   * `$transaction` to nest. The writes below are atomic because the REQUEST is.
   *
   * The new site is DRAFT, and DRAFT does not serve: `resolveHost` refuses anything
   * that is not PUBLISHED. That is deliberate. A site goes public when someone
   * decides it is ready, not as a side effect of being created — which is what gives
   * the owner a window to pick a theme and put a page at "/" before the first
   * visitor arrives.
   */
  @Post()
  @ApiOperation({
    summary: "Create a site",
    description:
      "Creates the site, its primary domain, a `page` content type and a published " +
      "homepage, together. The site itself starts as DRAFT and serves nothing until " +
      "it is published with PATCH /sites/{id}.",
  })
  @ApiAuthed("site:create")
  @ApiZodBody("CreateSiteInput")
  @ApiZodResponse("SiteDto", {
    description: "The site as created: DRAFT, with its primary domain.",
  })
  @RequirePermissions("site:create")
  async create(
    @Actor() actor: RequestActor,
    @Body(new ZodValidationPipe(CreateSiteSchema)) body: z.infer<typeof CreateSiteSchema>,
  ): Promise<SiteDto> {
    const locales = body.locales ?? [...DEFAULT_SITE_LOCALES];

    // The default locale has to be one the site actually publishes in, or every URL
    // on the site resolves to a language it does not have.
    if (!locales.includes(body.defaultLocale)) locales.unshift(body.defaultLocale);

    const brand = body.brand ?? parseSiteBrand(null);

    try {
      const created = await db().site.create({
        data: {
          tenantId: actor.tenantId,
          slug: body.slug,
          name: body.name,
          status: body.publish ? "PUBLISHED" : "DRAFT",
          defaultLocale: body.defaultLocale,
          locales,
          settings: settingsWithBrand(null, brand) as Prisma.InputJsonValue,
        },
      });

      await db().domain.create({
        data: {
          tenantId: actor.tenantId,
          siteId: created.id,
          hostname: body.hostname,
          isPrimary: true,
        },
      });

      await seedStarterContent(
        actor.tenantId,
        created.id,
        actor.userId,
        body.defaultLocale,
      );

      // The built-in plugins arrive installed and switched OFF, with nothing granted.
      // A new site should not have to go hunting for zAI in a catalogue; it should
      // also not come up quietly running a plugin that holds `network:fetch` and can
      // spend an API key, without anyone having been asked. Flipping the switch is
      // where the consent screen appears, and that is the point at which the admin
      // sees the three hosts it reaches.
      await installCorePlugins(db(), actor.tenantId, created.id);

      const site = await db().site.findUniqueOrThrow({
        where: { id: created.id },
        include: SITE_INCLUDE,
      });

      return toSiteDto(site);
    } catch (err) {
      // Both uniqueness rules are the DATABASE's, not this code's: (tenantId, slug)
      // and a GLOBAL unique on hostname. Checking them with a SELECT first would be
      // a race — two creates could both pass the check and one would still fail on
      // insert. So the insert is allowed to fail, and P2002 is translated into an
      // answer a human can act on.
      if ((err as { code?: string }).code === "P2002") {
        const target = (err as { meta?: { target?: string[] | string } }).meta?.target;
        const fields = Array.isArray(target) ? target.join(",") : String(target ?? "");

        // A hostname is unique across the whole PLATFORM, so the clash may be with
        // a site in a tenant the caller cannot see. The message says the name is
        // taken; it does not say by whom.
        if (fields.includes("hostname")) {
          throw new ConflictException(t()("errors.sites.hostnameTaken"));
        }
        throw new ConflictException(t()("errors.sites.slugTaken"));
      }
      throw err;
    }
  }

  /**
   * Updates a site: its name, its locales, its brand, and whether it is published.
   *
   * Every field is optional and only the ones sent are touched.
   */
  @Patch(":id")
  @ApiOperation({
    summary: "Update a site",
    description:
      "Name, status, locales and brand — colour and logo. Publishing (status: " +
      "PUBLISHED) is what makes a site serve; a DRAFT site answers nothing.",
  })
  @ApiAuthed("site:update")
  @ApiZodBody("UpdateSiteInput")
  @ApiZodResponse("SiteDto")
  @ApiNotFound("No such site — or not one of yours.")
  @RequirePermissions("site:update")
  async update(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(UpdateSiteSchema)) body: z.infer<typeof UpdateSiteSchema>,
  ): Promise<SiteDto> {
    const existing = await db().site.findUnique({ where: { id }, include: SITE_INCLUDE });
    if (!existing) throw new NotFoundException(t()("errors.sites.notFound"));

    // Checked against the RESULT of the patch, not against what was sent: dropping
    // a locale and leaving the default pointing at it is the same broken site
    // whether the default was changed in this request or three requests ago.
    const locales = body.locales ?? existing.locales;
    const defaultLocale = body.defaultLocale ?? existing.defaultLocale;
    if (!locales.includes(defaultLocale)) {
      throw new ConflictException(t()("errors.sites.defaultLocaleNotPublished"));
    }

    let site: Parameters<typeof toSiteDto>[0];
    try {
      site = await db().site.update({
        where: { id },
        data: {
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.slug !== undefined ? { slug: body.slug } : {}),
          ...(body.status !== undefined ? { status: body.status } : {}),
          ...(body.defaultLocale !== undefined ? { defaultLocale } : {}),
          ...(body.locales !== undefined ? { locales } : {}),
          ...(body.brand !== undefined
            ? {
                settings: settingsWithBrand(
                  existing.settings,
                  body.brand,
                ) as Prisma.InputJsonValue,
              }
            : {}),
        },
        include: SITE_INCLUDE,
      });

      if (body.hostname !== undefined) {
        const primary = existing.domains.find((domain) => domain.isPrimary) ?? existing.domains[0];
        if (!primary) throw new ConflictException("This site has no hostname to update.");
        await db().domain.update({
          where: { id: primary.id },
          data: { hostname: body.hostname },
        });
        site = await db().site.findUniqueOrThrow({ where: { id }, include: SITE_INCLUDE });
      }
    } catch (err) {
      if ((err as { code?: string }).code === "P2002") {
        const target = (err as { meta?: { target?: string[] | string } }).meta?.target;
        const fields = Array.isArray(target) ? target.join(",") : String(target ?? "");
        if (fields.includes("hostname")) {
          throw new ConflictException(t()("errors.sites.hostnameTaken"));
        }
        throw new ConflictException(t()("errors.sites.slugTaken"));
      }
      throw err;
    }

    // TWO caches, and forgetting either is a bug the operator can see and cannot
    // explain:
    //
    //   - the render cache, which this bumps a version on, holds every page;
    //   - the hostname->site lookup, which holds the site's name and brand for ten
    //     minutes and is NOT keyed by that version. Without dropping it, an owner
    //     changes their logo, reloads, and sees the old one for ten minutes with no
    //     way to hurry it along.
    await this.cache.forgetHosts([
      ...new Set([...existing.domains, ...site.domains].map((d) => d.hostname)),
    ]);
    await this.cache.invalidateSite(id);

    return toSiteDto(site);
  }
}

@Module({ controllers: [SitesController] })
export class SitesModule {}
