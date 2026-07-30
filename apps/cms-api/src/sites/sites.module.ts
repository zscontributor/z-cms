import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  Module,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { ApiOperation, ApiQuery, ApiTags } from "@nestjs/swagger";
import { db, getSystemDb, installCorePlugins, type Prisma } from "@zcmsorg/database";
import {
  hostnameVariants,
  normalizeHostname,
  parseSiteBrand,
  type SiteBrand,
  type SiteBrandingDto,
  type SiteDto,
} from "@zcmsorg/schemas";
import type { z } from "zod";
import { Actor, Public, RequirePermissions } from "../auth/decorators";
import { AuditService } from "../audit/audit.module";
import { t } from "../common/i18n";
import { toSiteDto } from "../common/mappers";
import { RateLimit } from "../common/rate-limit.decorator";
import { RateLimitGuard } from "../common/rate-limit.guard";
import type { RequestActor } from "../common/request-context";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import {
  ApiAuthed,
  ApiNotFound,
  ApiRateLimited,
  ApiZodBody,
  ApiZodResponse,
} from "../openapi/decorators";
import { CreateSiteSchema, UpdateSiteSchema } from "../openapi/registry";
import { QueueService } from "../queue/queue.module";
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
      // Materialized routing path; the homepage lives at the locale root.
      path: "/",
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

/**
 * The membership filter for the list, as a `where` fragment.
 *
 * Empty for a tenant-wide member — RLS has already narrowed the query to their
 * tenant and there is nothing further to say. For a member of specific sites it
 * is an `id IN (...)`.
 */
function siteWhere(actor: RequestActor): { id?: { in: string[] } } {
  return actor.siteIds ? { id: { in: actor.siteIds } } : {};
}

/**
 * Whether this actor may see one site at all — the single-row form of the above.
 *
 * Routes call it before the lookup and answer a "no" with the same 404 a missing
 * row gets: "not one of yours" and "does not exist" are deliberately the same
 * answer, so ids cannot be probed for existence.
 */
function mayUseSite(actor: RequestActor, id: string): boolean {
  return !actor.siteIds || actor.siteIds.includes(id);
}

@ApiTags("Sites")
@Controller("sites")
export class SitesController {
  constructor(
    private readonly cache: CacheService,
    private readonly queue: QueueService,
    private readonly audit: AuditService,
  ) {}

  /**
   * No tenant filter in the where clause, and none is needed: this query runs
   * inside withTenant(), so RLS restricts it to the caller's own sites.
   *
   * RLS is the tenant boundary, not the membership one. A user granted a role on
   * ONE site is still in the tenant, so without `siteWhere` every other site in
   * it comes back here — and the admin's site switcher, which is built from this
   * list, hands them a menu of sites they cannot open. Per-site members see
   * their own sites; a tenant-wide member (`siteIds` undefined) sees all.
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
  async list(@Actor() actor: RequestActor): Promise<SiteDto[]> {
    const sites = await db().site.findMany({
      where: siteWhere(actor),
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
  async findOne(@Actor() actor: RequestActor, @Param("id") id: string): Promise<SiteDto> {
    const site = mayUseSite(actor, id)
      ? await db().site.findUnique({ where: { id }, include: SITE_INCLUDE })
      : null;
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

      // The first hostname is the primary — the one every other spelling redirects
      // to — and the rest are aliases that resolve to the same site. Each is its own
      // row because `Domain.hostname` is globally unique and resolution is a lookup
      // on that column; a P2002 on any of them is caught below and, because the whole
      // request is one transaction, takes the site row down with it.
      const [primaryHost, ...aliasHosts] = body.hostnames;
      await db().domain.create({
        data: {
          tenantId: actor.tenantId,
          siteId: created.id,
          hostname: primaryHost,
          isPrimary: true,
        },
      });
      for (const hostname of aliasHosts) {
        await db().domain.create({
          data: { tenantId: actor.tenantId, siteId: created.id, hostname, isPrimary: false },
        });
      }

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

      // A creator whose own access is per-site would otherwise lose the site the
      // moment they made it: they hold no tenant-wide membership, the new id is
      // not in the list their token resolves to, and the very next request — the
      // redirect to the new site — 404s. A tenant-wide creator needs nothing;
      // their membership already covers every site including this one.
      if (actor.siteIds) {
        await db().membership.create({
          data: {
            tenantId: actor.tenantId,
            userId: actor.userId,
            siteId: created.id,
            role: actor.role,
          },
        });
      }

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
    @Actor() actor: RequestActor,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(UpdateSiteSchema)) body: z.infer<typeof UpdateSiteSchema>,
  ): Promise<SiteDto> {
    // Membership-scoped, exactly like the reads above: an ADMIN of one site holds
    // `site:update` and could otherwise rename, unpublish or re-domain any other
    // site in the tenant by id — the permission says what they may do, not where.
    const existing = mayUseSite(actor, id)
      ? await db().site.findUnique({ where: { id }, include: SITE_INCLUDE })
      : null;
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

      if (body.hostnames !== undefined) {
        // The list REPLACES the site's domains. Reconcile rather than delete-all-and-
        // recreate: a hostname already on this site keeps its row (and its `verified`
        // flag), one no longer in the list is removed, and a new one is inserted —
        // where a P2002 means it belongs to another site and, because the request is
        // one transaction, rolls back the whole PATCH. The first entry is the primary.
        const desired = body.hostnames;
        const desiredSet = new Set(desired);
        const existingHosts = new Set(existing.domains.map((domain) => domain.hostname));

        const toRemove = existing.domains.filter((domain) => !desiredSet.has(domain.hostname));
        if (toRemove.length > 0) {
          await db().domain.deleteMany({ where: { id: { in: toRemove.map((d) => d.id) } } });
        }
        for (const hostname of desired) {
          if (!existingHosts.has(hostname)) {
            await db().domain.create({
              data: { tenantId: existing.tenantId, siteId: id, hostname, isPrimary: false },
            });
          }
        }
        // Exactly one primary, and it is the first in the list. Clear every flag on
        // this site, then set the one — two statements so a former primary that is
        // still present does not keep the flag.
        await db().domain.updateMany({ where: { siteId: id }, data: { isPrimary: false } });
        await db().domain.updateMany({
          where: { siteId: id, hostname: desired[0] },
          data: { isPrimary: true },
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

  /**
   * Rebuilds this site's sitemap.xml, on demand.
   *
   * A publish already rebuilds it — see ContentsService.rebuildSitemap — so this
   * exists for the cases that path never covers: content that predates the sitemap
   * feature, a rebuild event that was lost, or an owner who simply wants to be sure
   * before submitting the URL to a search console. It is the same job, enqueued the
   * same way; the worker writes `sites/{id}/sitemap.xml` and site-runtime serves it.
   *
   * No `jobId` on purpose. The publish path dedupes on `sitemap-{id}` to collapse a
   * burst of edits into one rebuild, but completed jobs are RETAINED for an hour
   * (removeOnComplete age), so reusing that id here would make a second click within
   * the hour a silent no-op — the opposite of what a manual "rebuild now" button is
   * for. A unique id per click guarantees the job actually runs; the button is
   * disabled while pending, so a human cannot queue a meaningful pile of them.
   *
   * 202, not 200: the sitemap is not written by the time this returns. The worker
   * builds it moments later, and `/sitemap.xml` reflects it on its next fetch.
   */
  @Post(":id/sitemap/rebuild")
  @HttpCode(202)
  @ApiOperation({
    summary: "Rebuild a site's sitemap.xml",
    description:
      "Queues a background rebuild of this site's sitemap from its published, " +
      "routable content. Runs asynchronously; the public /sitemap.xml updates once " +
      "the worker finishes.",
  })
  @ApiAuthed("site:update")
  @ApiNotFound("No such site — or not one of yours.")
  @RequirePermissions("site:update")
  async rebuildSitemap(
    @Actor() actor: RequestActor,
    @Param("id") id: string,
  ): Promise<{ status: "queued" }> {
    // RLS scopes this to the caller's tenant and `mayUseSite` to the sites they
    // hold a role on, so a missing row means "not yours" just as much as "does
    // not exist" — the same answer, on purpose.
    const site = mayUseSite(actor, id)
      ? await db().site.findUnique({ where: { id }, select: { id: true } })
      : null;
    if (!site) throw new NotFoundException(t()("errors.sites.notFound"));

    // Awaited, unlike the fire-and-forget publish path: a manual action should tell
    // the caller if the queue is unreachable, not swallow it.
    await this.queue.enqueue("site.sitemap", { tenantId: actor.tenantId, siteId: id });
    await this.audit.record(actor, "site.sitemap.rebuilt", "site", id);

    return { status: "queued" };
  }
}

/**
 * The one thing a stranger may ask about a hostname: whose site is this?
 *
 * It exists for the sign-in screen. The admin is served at `/admin` on every tenant
 * hostname, so a person signing in at `z-soft.com.vn/admin` is unmistakably signing
 * in to Z-SOFT's site — and until this endpoint, the screen greeted them with the
 * product's own logo, identical on all of them, because the only way to learn a
 * site's name was to already hold a session on it.
 *
 * Unauthenticated by necessity and safe by narrowness: the caller must already know
 * a hostname to ask, and every field of the answer is printed on that hostname's own
 * home page. Nothing invisible from the outside — status, tenant, theme, locales —
 * is in the DTO, so a wrong answer here cannot become a leak. Rate limited by IP
 * regardless, since an open endpoint backed by a database query is worth capping.
 *
 * Cross-tenant by definition — we do not know whose site a hostname is until we have
 * looked it up — so it uses the system client, exactly like `RenderService.resolveHost`,
 * and caches for the same ten minutes under a key `forgetHosts` already purges.
 */
@ApiTags("Sites")
@Controller("public/sites")
@UseGuards(RateLimitGuard)
export class PublicSiteController {
  constructor(private readonly cache: CacheService) {}

  @Public()
  @Get("branding")
  @ApiOperation({
    summary: "Whose site answers at this hostname",
    description:
      "The site's name, brand and canonical hostname, for a surface that has no " +
      "session yet — the admin sign-in screen, which is served at /admin on every " +
      "tenant hostname and otherwise has no way to know which site it belongs to.\n\n" +
      "Public on purpose, and narrow on purpose: the caller has to know a hostname " +
      "to ask, and everything in the answer is already on that hostname's home " +
      "page. Answers for a site in ANY status — a draft site's owner still has to " +
      "sign in. 404 when no site is registered under the hostname.",
  })
  @ApiQuery({
    name: "hostname",
    required: true,
    description: 'The host being served, e.g. "www.example.com". Port and scheme are ignored.',
  })
  @ApiZodResponse("SiteBrandingDto")
  @ApiZodResponse("Error", { status: 400, description: "`hostname` is required." })
  @ApiNotFound("No site is registered under that hostname.")
  @ApiRateLimited("Too many lookups from this IP.")
  @RateLimit({ by: "ip", points: 120, windowSec: 60 })
  async branding(@Query("hostname") hostname?: string): Promise<SiteBrandingDto> {
    // A Host header carries a port ("localhost:3001"); a registered domain never
    // does. `normalizeHostname` strips scheme and path, this strips the port.
    const requested = (normalizeHostname(hostname ?? "").split(":")[0] ?? "").trim();
    if (!requested) throw new BadRequestException(t()("errors.render.missingHostname"));

    const key = CacheService.brandKey(requested);
    const cached = await this.cache.get<SiteBrandingDto>(key);
    if (cached) return cached;

    // Both spellings, for the same reason `resolveHost` looks at both: "www.x.com"
    // is not a different site from "x.com". An exact row still wins — the fallback
    // only fires when nothing matched.
    const rows = await getSystemDb().domain.findMany({
      where: { hostname: { in: hostnameVariants(requested) } },
      select: {
        hostname: true,
        siteId: true,
        site: { select: { name: true, settings: true } },
      },
    });
    const domain = rows.find((row) => row.hostname === requested) ?? rows[0];
    if (!domain) {
      throw new NotFoundException(t()("errors.render.hostNotFound", { hostname: requested }));
    }

    const branding: SiteBrandingDto = {
      siteId: domain.siteId,
      name: domain.site.name,
      brand: parseSiteBrand(domain.site.settings),
      host: domain.hostname,
    };

    await this.cache.set(key, branding, 600);
    return branding;
  }
}

@Module({ controllers: [SitesController, PublicSiteController] })
export class SitesModule {}
