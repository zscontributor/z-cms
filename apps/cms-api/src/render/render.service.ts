import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { db, getSystemDb, withTenant } from "@zcmsorg/database";
import { flagUrl } from "@zcmsorg/i18n";
import {
  CONTENT_LIST_BLOCK,
  clampCollectionLimit,
  hostnameVariants,
  normaliseCollectionSort,
  parseSiteBrand,
} from "@zcmsorg/schemas";
import type {
  Block,
  CollectionQuery,
  CollectionSort,
  ContentDto,
  LocaleAlternate,
  MenuDto,
  RenderPayload,
  SiteBrand,
} from "@zcmsorg/schemas";
import { t } from "../common/i18n";
import { contentPath, toContentDto, toMenuDto } from "../common/mappers";
import { PluginsService } from "../plugins/plugins.service";
import { CacheService } from "../redis/cache.service";

const ARCHIVE_PAGE_SIZE = 10;

/**
 * How many lists ONE page render may run, per source.
 *
 * A theme's manifest and a page's block tree are both authored elsewhere — a theme
 * comes from a marketplace, a block tree can be written through the content API — so
 * neither is allowed to decide how much work a page render costs. A manifest with 500
 * collections, or a page carrying 500 `core/content-list` blocks, would otherwise turn
 * a single request for the front page into 500 queries. The excess is dropped (and
 * logged); what is dropped resolves to an empty list, never to an error.
 *
 * Eight is far above anything a real front page needs and far below anything that
 * hurts. Queries within the cap are deduplicated and run concurrently.
 */
const MAX_THEME_COLLECTIONS = 8;
const MAX_CONTENT_LIST_BLOCKS = 8;

/** `sort` -> the only orderings a caller may ask for. Nothing else is expressible. */
const COLLECTION_ORDER_BY: Record<CollectionSort, Record<string, "asc" | "desc">> = {
  newest: { publishedAt: "desc" },
  oldest: { publishedAt: "asc" },
  title: { title: "asc" },
};

const CONTENT_INCLUDE = {
  contentType: { select: { id: true, key: true, name: true, routePrefix: true } },
  author: { select: { id: true, name: true } },
} as const;

interface ResolvedSite {
  id: string;
  tenantId: string;
  name: string;
  /**
   * The site's primary hostname — the one it was created with.
   *
   * A site answers to more than one host ("z-cms.org" and "www.z-cms.org" are the
   * same site to everyone except a string comparison), but a page must still have
   * ONE address: two hosts serving identical HTML is duplicate content, and search
   * engines split the ranking between them. So site-runtime redirects any other
   * spelling to this one, and this is how it knows which that is.
   */
  canonicalHost: string;
  defaultLocale: string;
  locales: string[];
  /**
   * Resolved once, here, rather than in `build` — `build` runs per uncached page,
   * `resolveHost` runs once per hostname per ten minutes. The brand is the same
   * either way, and parsing a JSON column on every render of every page is work
   * that buys nothing.
   */
  brand: SiteBrand;
}

/** Every item in a menu, parents and children alike, as one flat list. */
function flattenMenu(items: MenuDto["items"]): MenuDto["items"] {
  return items.flatMap((item) => [item, ...flattenMenu(item.children)]);
}

/**
 * Turns "hostname + path" into everything a theme needs to render, in one call.
 *
 * The public site is the hot path of the whole platform, so the shape of this
 * service is deliberate:
 *
 *   - one cache lookup before any database work,
 *   - one tenant transaction, not one per entity,
 *   - only PUBLISHED content ever leaves this service.
 *
 * The last point is a hard rule. site-runtime is not trusted to filter drafts;
 * if a draft is never in the payload, a bug in a theme cannot leak one.
 */
@Injectable()
export class RenderService {
  private readonly logger = new Logger(RenderService.name);

  constructor(
    private readonly cache: CacheService,
    private readonly plugins: PluginsService,
  ) {}

  async resolve(hostname: string, path: string, page = 1): Promise<RenderPayload> {
    const normalizedPath = this.normalizePath(path);
    const site = await this.resolveHost(hostname);

    // The site's cache version is part of the key. A theme or menu change bumps
    // it, which orphans the whole previous generation of this site's renders
    // without deleting or scanning anything.
    const version = await this.cache.siteVersion(site.id);
    const cacheKey = CacheService.renderKey(site.id, version, normalizedPath, page);
    const cached = await this.cache.get<RenderPayload>(cacheKey);
    // A hit is only a hit if it carries `canonicalHost`. Neither cache key is
    // versioned by the shape of what it stores, so an entry written by a build
    // that predates the field outlives the deploy that added it — and site-runtime
    // reads the missing field as `undefined` and redirects the site to
    // "https://undefined/". Rebuilding costs one render; the alternative is a
    // permanent redirect that visitors' browsers then cache.
    if (cached?.site.canonicalHost) return cached;

    const payload = await withTenant(site.tenantId, () =>
      this.build(site, normalizedPath, page),
    );

    await this.cache.set(cacheKey, payload);
    return payload;
  }

  /**
   * Hostname -> site. Cross-tenant by definition (we do not know whose site
   * this is until we have looked it up), so it uses the system client and is
   * cached hard: it changes only when a domain is added or removed.
   */
  private async resolveHost(hostname: string): Promise<ResolvedSite> {
    const key = CacheService.hostKey(hostname);
    const cached = await this.cache.get<ResolvedSite>(key);
    // Same reason as in `resolve`: an entry without `canonicalHost` is stale by
    // shape, not by age, and re-resolving is cheaper than serving it.
    if (cached?.canonicalHost) return cached;

    // Both spellings of the host, because "www.z-cms.org" is not a different site
    // from "z-cms.org" — it is the same site, reached by the other name for it.
    // An exact row still wins: the fallback only fires when nothing matched, so a
    // deployment that really did register both names separately is unaffected.
    const rows = await getSystemDb().domain.findMany({
      where: { hostname: { in: hostnameVariants(hostname) } },
      include: { site: { include: { domains: { select: { hostname: true, isPrimary: true } } } } },
    });
    const domain = rows.find((row) => row.hostname === hostname) ?? rows[0];

    if (!domain || domain.site.status !== "PUBLISHED") {
      throw new NotFoundException(t()("errors.render.hostNotFound", { hostname }));
    }

    const site: ResolvedSite = {
      id: domain.site.id,
      tenantId: domain.site.tenantId,
      name: domain.site.name,
      // The primary domain, falling back to the row we matched — a site always has
      // one, but a row with no primary flag must still resolve rather than crash.
      canonicalHost:
        domain.site.domains.find((d) => d.isPrimary)?.hostname ?? domain.hostname,
      defaultLocale: domain.site.defaultLocale,
      locales: domain.site.locales,
      brand: parseSiteBrand(domain.site.settings),
    };

    // Ten minutes, and NOT keyed by the site's cache version — so a brand change
    // would otherwise sit behind this TTL. `PATCH /sites/{id}` drops this key
    // explicitly (CacheService.forgetHosts); if you add another writer of the
    // site's name or brand, it has to do the same.
    await this.cache.set(key, site, 600);
    return site;
  }

  private async build(
    site: ResolvedSite,
    requestPath: string,
    page: number,
  ): Promise<RenderPayload> {
    // "/vi/blog/hello" is the Vietnamese "/blog/hello". Everything below this
    // line works in the site's own path space, with the locale carried
    // separately — so a content type's route prefix never has to know about
    // languages, and a theme's links never have to strip one.
    const { locale, path } = this.splitLocale(site, requestPath);

    const themeRow = await db().siteTheme.findFirst({
      where: { siteId: site.id, status: "ACTIVE" },
      include: { theme: true, version: true },
    });

    if (!themeRow) {
      throw new NotFoundException(t()("errors.render.noActiveTheme"));
    }

    const activeThemeKey = themeRow.theme.key;
    const menuRows = await db().menu.findMany({
      where: {
        siteId: site.id,
        OR: [{ demoThemeKey: null }, { demoThemeKey: activeThemeKey }],
      },
      include: { items: true },
      orderBy: { createdAt: "asc" },
    });

    const menus: Record<string, MenuDto> = {};
    for (const menu of this.preferThemeDemo(menuRows, activeThemeKey)) {
      // A demo menu for the active theme shadows the normal menu with the same
      // location. Demo menus for other themes were filtered out above.
      menus[menu.key] = toMenuDto(menu);
    }

    await this.localiseMenus(site, menus, locale, activeThemeKey);

    const pluginContributions = await this.plugins.renderContributionsFor(
      site.tenantId,
      site.id,
    );
    const legacyAiAssistant = pluginContributions.integrations["ai.assistant"]?.data as
      | { name: string; welcomeMessage: string }
      | undefined;

    const base = {
      site: {
        id: site.id,
        name: site.name,
        canonicalHost: site.canonicalHost,
        locale,
        defaultLocale: site.defaultLocale,
        locales: site.locales,
        // Reaches every theme as `ctx.site.brand`. The theme decides where — or
        // whether — to draw it; core only guarantees it is there and complete.
        brand: site.brand,
      },
      theme: {
        key: themeRow.theme.key,
        version: themeRow.version.version,
        // Which trust route site-runtime verifies this theme against. Carried
        // explicitly so the runtime never has to guess it from the key — a built-in
        // is checked against the first-party key, a marketplace theme against the
        // marketplace key, a sideload against the operator key.
        origin: themeRow.version.origin,
        settings: (themeRow.settings ?? {}) as Record<string, unknown>,
      },
      menus,
      // Contributed by the site's ACTIVE plugins. A theme calls
      // ctx.hasCapability("seo.metadata") and degrades gracefully when the
      // plugin providing it is not installed — which is what lets a site swap
      // one plugin for another without touching the theme.
      capabilities: pluginContributions.capabilities,
      integrations: pluginContributions.integrations,
      // Kept for one compatibility window; new runtimes read integrations.
      ...(legacyAiAssistant ? { aiAssistant: legacyAiAssistant } : {}),
    };

    // What the ACTIVE theme asked for in its manifest, as queries. Every page of
    // the site gets them — the front page's "latest posts" is drawn by the theme's
    // template, not by anything in the matched content, so they are resolved on an
    // archive and on a 404 too (where a theme's notFound template may well want to
    // offer the reader some recent posts rather than a dead end).
    const themeQueries = this.declaredCollections(
      (themeRow.version as { manifest?: unknown } | null)?.manifest,
      activeThemeKey,
    );

    const archive = await this.tryArchive(site.id, path, page, locale, activeThemeKey);
    if (archive) {
      // An archive exists in every locale the site publishes in — it is a route,
      // not a row, so there is no translation to be missing.
      return {
        ...base,
        collections: await this.namedCollections(site.id, locale, activeThemeKey, themeQueries),
        content: null,
        archive,
        alternates: site.locales.map((code) => ({
          locale: code,
          path: this.localePath(site, code, archive.basePath),
          current: code === locale,
          flagUrl: flagUrl(code),
        })),
      };
    }

    const content = await this.findContent(site.id, locale, path, activeThemeKey);
    if (!content) {
      // Nothing here. No alternates: hreflang on a 404 would advertise pages that
      // do not exist, and a switcher would offer to move the reader sideways into
      // another missing page.
      return {
        ...base,
        collections: await this.namedCollections(site.id, locale, activeThemeKey, themeQueries),
        content: null,
        archive: null,
        alternates: [],
      };
    }

    const alternates = await this.alternatesFor(
      site,
      content.translationGroupId,
      locale,
      content.demoThemeKey,
    );
    const dto = toContentDto(content);

    // The theme's lists and this page's `core/content-list` blocks are the same kind
    // of question, so they are asked together: one deduplicated, concurrent batch, so
    // a page whose block repeats the list the theme already declared costs one query,
    // not two.
    const blocks = dto.blocks as Block[];
    const listQueries = this.listQueriesIn(blocks);
    const results = await this.runQueries(site.id, locale, activeThemeKey, [
      ...themeQueries.values(),
      ...listQueries,
    ]);

    const collections: Record<string, ContentDto[]> = {};
    for (const [name, query] of themeQueries) {
      // Present even when empty: a theme is documented as being able to map over a
      // declared name without a guard, on a site where nobody has written anything.
      collections[name] = results.get(this.queryKey(query)) ?? [];
    }

    dto.blocks = this.resolveListBlocks(blocks, results) as ContentDto["blocks"];

    // The one filter that runs in the render path. It is bounded on both sides:
    // the runtime kills a filter handler at 800ms, and a plugin that fails is
    // skipped with the original value passing through untouched. Bad SEO from a
    // broken plugin is acceptable; a blank page is not.
    //
    // The result is cached with the rest of the payload, so this costs one
    // sandbox round trip per page per TTL — not one per visitor.
    dto.seo = await this.plugins.applyFilter(
      site.tenantId,
      site.id,
      "content.seo",
      dto.seo,
      {
        siteId: site.id,
        contentId: dto.id,
        path: dto.path,
        title: dto.title,
      },
    );

    return { ...base, collections, content: dto, archive: null, alternates };
  }

  // -------------------------------------------------------------------------
  // Collections
  //
  // Two things ask for a list of content, and they ask the same question:
  //
  //   - a THEME, in `manifest.collections` — "give me the six newest posts", so its
  //     front page can be drawn out of the site's own writing;
  //   - an EDITOR, in the props of a `core/content-list` block — the same, placed on
  //     one page rather than declared by the theme.
  //
  // One question, therefore ONE resolver: `runQueries` below is the only place in
  // this service that turns a CollectionQuery into rows, which makes it the only
  // place where the tenant is scoped, the locale is honoured, drafts are excluded and
  // the limit is capped. A second path would be a second chance to forget one of
  // those, and the one it forgot would be a leak.
  // -------------------------------------------------------------------------

  /**
   * Runs a batch of collection queries: deduplicated, concurrent, bounded.
   *
   * Deduplicated because a page that shows "latest posts" in a block AND in the
   * theme's hero must not pay for it twice; concurrent because a front page with four
   * lists must not cost four sequential round trips to the database.
   *
   * Returns a map keyed by `queryKey` — the identity of a query, not the name anyone
   * gave it, since two names can be the same question.
   */
  private async runQueries(
    siteId: string,
    locale: string,
    activeThemeKey: string,
    queries: CollectionQuery[],
  ): Promise<Map<string, ContentDto[]>> {
    const unique = new Map<string, CollectionQuery>();
    for (const query of queries) unique.set(this.queryKey(query), query);

    const entries = await Promise.all(
      [...unique].map(
        async ([key, query]) =>
          [key, await this.runQuery(siteId, locale, activeThemeKey, query)] as const,
      ),
    );
    return new Map(entries);
  }

  /**
   * One collection query -> published rows.
   *
   * Every filter here is the same one the rest of this service applies to anything it
   * serves publicly, and for the same reasons:
   *
   *   - `siteId`, on top of the tenant transaction — a list is not a way out of a site;
   *   - `locale` — a Vietnamese page listing English posts would link every reader
   *     straight out of the language they chose (see `tryArchive`);
   *   - `status: PUBLISHED` — a draft is not in a list any more than it is at its own
   *     URL, and a theme is not trusted to filter one out;
   *   - the demo-theme rule — a demo post belongs to the theme that seeded it.
   *
   * An unknown content type matches nothing and yields `[]`. That is not an error: a
   * theme is installed on sites that do not have its content types yet, and a theme
   * whose install 500s the front page is a theme nobody installs.
   */
  private async runQuery(
    siteId: string,
    locale: string,
    activeThemeKey: string,
    query: CollectionQuery,
  ): Promise<ContentDto[]> {
    // Not a query at all — a block with no content type set, a manifest entry that is
    // not an object. Nothing to ask the database.
    if (!query.contentType) return [];

    const rows = await db().content.findMany({
      where: {
        siteId,
        locale,
        status: "PUBLISHED" as const,
        contentType: { key: query.contentType },
        OR: [{ demoThemeKey: null }, { demoThemeKey: activeThemeKey }],
      },
      include: CONTENT_INCLUDE,
      orderBy: COLLECTION_ORDER_BY[normaliseCollectionSort(query.sort)],
      // Already clamped by `normaliseQuery`; clamped again here because this is the
      // line that talks to the database, and it should be readable on its own.
      take: clampCollectionLimit(query.limit),
    });

    return rows.map(toContentDto);
  }

  /** Resolves the theme's declared lists on a page with no block tree of its own. */
  private async namedCollections(
    siteId: string,
    locale: string,
    activeThemeKey: string,
    declared: Map<string, CollectionQuery>,
  ): Promise<Record<string, ContentDto[]>> {
    const results = await this.runQueries(siteId, locale, activeThemeKey, [
      ...declared.values(),
    ]);
    const out: Record<string, ContentDto[]> = {};
    for (const [name, query] of declared) {
      out[name] = results.get(this.queryKey(query)) ?? [];
    }
    return out;
  }

  /**
   * `manifest.collections` -> queries, normalised and bounded.
   *
   * A manifest is a stranger's JSON: it may declare nothing, may declare junk, and
   * may declare five hundred lists. All three answer here rather than at the database.
   */
  private declaredCollections(
    manifest: unknown,
    activeThemeKey: string,
  ): Map<string, CollectionQuery> {
    const out = new Map<string, CollectionQuery>();
    const raw = (manifest as { collections?: unknown } | null | undefined)?.collections;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;

    for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
      if (out.size >= MAX_THEME_COLLECTIONS) {
        this.logger.warn(
          `Theme "${activeThemeKey}" declares more than ${MAX_THEME_COLLECTIONS} collections; "${name}" and any after it are ignored.`,
        );
        break;
      }
      out.set(name, this.normaliseQuery(value));
    }
    return out;
  }

  /**
   * The `core/content-list` blocks on a page, in document order, as queries.
   *
   * Blocks nest, so this walks `children` as well — a list inside a two-column layout
   * is still a list. Stops at MAX_CONTENT_LIST_BLOCKS: a block tree past that point is
   * not a page, it is a fan-out, and the blocks it drops resolve to an empty list.
   */
  private listQueriesIn(blocks: Block[]): CollectionQuery[] {
    const out: CollectionQuery[] = [];

    const visit = (nodes: Block[]): void => {
      for (const node of nodes) {
        if (out.length >= MAX_CONTENT_LIST_BLOCKS) return;
        if (node?.type === CONTENT_LIST_BLOCK) out.push(this.normaliseQuery(node.props));
        if (Array.isArray(node?.children)) visit(node.children);
      }
    };

    // Depth is bounded to MAX_BLOCK_DEPTH when the document is written, so this
    // recursion cannot be driven into the stack by a hostile block tree.
    if (Array.isArray(blocks)) visit(blocks);
    if (out.length >= MAX_CONTENT_LIST_BLOCKS) {
      this.logger.warn(
        `Page carries more than ${MAX_CONTENT_LIST_BLOCKS} ${CONTENT_LIST_BLOCK} blocks; the rest render empty.`,
      );
    }
    return out;
  }

  /**
   * Rewrites a block tree with every `core/content-list` block's `props.items` set to
   * what its query actually returned.
   *
   * `items` is OVERWRITTEN, never merged, and unconditionally — even when the stored
   * block already has one. That is the whole defence, not a detail of it: a block's
   * props are attacker-reachable (they are written through the content API, and a
   * theme cannot tell one prop from another), so a stored `items` array is untrusted
   * input claiming to be the result of a query nobody ran. Merging it, or honouring it
   * when the query returns nothing, would be a way to render rows the query would
   * never have returned — a draft, another locale, another tenant's post. The query is
   * the only thing allowed to say what is in a list.
   *
   * A COPY is built, never a mutation of the Prisma row: the payload this becomes is
   * cached, and writing into a cached object is how one request's data ends up on
   * another request's page.
   */
  private resolveListBlocks(blocks: Block[], results: Map<string, ContentDto[]>): Block[] {
    if (!Array.isArray(blocks)) return [];

    return blocks.map((block) => {
      const children = Array.isArray(block?.children)
        ? this.resolveListBlocks(block.children, results)
        : undefined;

      if (block?.type !== CONTENT_LIST_BLOCK) {
        return children ? { ...block, children } : { ...block };
      }

      const query = this.normaliseQuery(block.props);
      // `?? []` covers a block past MAX_CONTENT_LIST_BLOCKS, whose query was never
      // run. An empty list, not the stored one.
      const items = results.get(this.queryKey(query)) ?? [];

      return {
        ...block,
        props: { ...block.props, ...query, items },
        ...(children ? { children } : {}),
      };
    });
  }

  /**
   * Anything shaped like a query -> a query we will actually run. Used for BOTH a
   * manifest entry and a block's props, because they are the same shape by design.
   * The limit is capped and the sort is closed here, so nothing downstream has to
   * remember to.
   */
  private normaliseQuery(input: unknown): CollectionQuery {
    const raw = (input ?? {}) as { contentType?: unknown; limit?: unknown; sort?: unknown };
    return {
      contentType: typeof raw.contentType === "string" ? raw.contentType.trim() : "",
      limit: clampCollectionLimit(raw.limit),
      sort: normaliseCollectionSort(raw.sort),
    };
  }

  /** The identity of a query: two callers asking this are asking the same thing. */
  private queryKey(query: CollectionQuery): string {
    return `${query.contentType}|${clampCollectionLimit(query.limit)}|${normaliseCollectionSort(query.sort)}`;
  }

  /**
   * "/vi/blog/hello" -> { locale: "vi", path: "/blog/hello" }.
   *
   * The default locale is served unprefixed, and its prefix is deliberately *not*
   * accepted: on a site whose default is English, "/en/about" resolves to nothing
   * rather than to a second copy of "/about". Two URLs serving one page is the
   * duplicate-content problem canonical tags exist to clean up after — better not
   * to create it.
   *
   * A first segment that merely looks like a language ("/vi") is only treated as
   * one when the site actually publishes in it. A site with a page slugged "vi"
   * keeps that page.
   */
  private splitLocale(
    site: ResolvedSite,
    path: string,
  ): { locale: string; path: string } {
    const segments = path.replace(/^\//, "").split("/");
    const head = segments[0] ?? "";

    const isLocalePrefix =
      head !== "" &&
      head !== site.defaultLocale &&
      site.locales.includes(head);

    if (!isLocalePrefix) return { locale: site.defaultLocale, path };

    const rest = segments.slice(1).join("/");
    return { locale: head, path: rest ? `/${rest}` : "/" };
  }

  /**
   * Points a menu at the right language.
   *
   * A menu item stores a raw path — "/about" — and a theme runs it through
   * `ctx.url()`, which prefixes it with the locale being rendered. On a site whose
   * Vietnamese "about" page is slugged "gioi-thieu", that produces "/vi/about",
   * which is a **404**. So the site's own navigation would be the fastest way to
   * break the language switcher: pick Vietnamese, then click any menu item.
   *
   * Menus are stored once per site, not once per locale, so the fix is to resolve
   * them at render time:
   *
   *   - a path that resolves to content -> rewrite to that content's sibling in
   *     this locale;
   *   - a sibling that does not exist -> **drop the item**. An untranslated page
   *     is not in this language's navigation. A dead link would be worse, and a
   *     link that silently escapes back to English worse still;
   *   - anything else (an archive route like "/blog", an external URL, a path
   *     that matches nothing) -> left exactly as it was. Archives exist in every
   *     locale; they are routes, not rows.
   *
   * The label is taken from the translation's own title, because a menu label has
   * no translation of its own to take. That is a real limitation, not a design:
   * per-locale menu labels need a schema of their own, and until they exist, the
   * translated title is a better answer than an English word in a Vietnamese menu.
   *
   * Costs two queries, only on a non-default locale, and only on a cache miss.
   */
  private async localiseMenus(
    site: ResolvedSite,
    menus: Record<string, MenuDto>,
    locale: string,
    activeThemeKey: string,
  ): Promise<void> {
    if (locale === site.defaultLocale) return;

    const items = Object.values(menus).flatMap((menu) => flattenMenu(menu.items));
    const targets = new Map<string, { prefix: string; slug: string }>();

    for (const item of items) {
      const parsed = this.parseInternalPath(item.url);
      if (parsed) targets.set(item.url, parsed);
    }
    if (targets.size === 0) return;

    // What each menu path points at, in the site's own language.
    const originals = await db().content.findMany({
      where: {
        siteId: site.id,
        locale: site.defaultLocale,
        status: "PUBLISHED",
        AND: [
          { OR: [{ demoThemeKey: null }, { demoThemeKey: activeThemeKey }] },
          {
            OR: [...targets.values()].map(({ prefix, slug }) => ({
              slug,
              contentType: { routePrefix: prefix, isRoutable: true },
            })),
          },
        ],
      },
      select: {
        slug: true,
        demoThemeKey: true,
        translationGroupId: true,
        contentType: { select: { routePrefix: true } },
      },
    });

    if (originals.length === 0) return;

    const groupByPath = new Map<string, string>();
    for (const row of this.preferThemeDemo(originals, activeThemeKey)) {
      const prefix = row.contentType.routePrefix;
      groupByPath.set(contentPath(prefix, row.slug), row.translationGroupId);
    }

    // Those same pages, in the language being rendered.
    const translations = await db().content.findMany({
      where: {
        siteId: site.id,
        locale,
        status: "PUBLISHED",
        translationGroupId: { in: [...new Set(groupByPath.values())] },
        OR: [{ demoThemeKey: null }, { demoThemeKey: activeThemeKey }],
      },
      select: {
        slug: true,
        title: true,
        demoThemeKey: true,
        translationGroupId: true,
        contentType: { select: { routePrefix: true } },
      },
    });

    const byGroup = new Map(
      this.preferThemeDemo(translations, activeThemeKey).map((row) => [
        row.translationGroupId,
        row,
      ]),
    );

    for (const menu of Object.values(menus)) {
      menu.items = this.rewriteItems(menu.items, groupByPath, byGroup);
    }
  }

  private rewriteItems(
    items: MenuDto["items"],
    groupByPath: Map<string, string>,
    byGroup: Map<
      string,
      { slug: string; title: string; contentType: { routePrefix: string } }
    >,
  ): MenuDto["items"] {
    const out: MenuDto["items"] = [];

    for (const item of items) {
      const children = this.rewriteItems(item.children, groupByPath, byGroup);
      const group = groupByPath.get(item.url);

      // Not content: an archive, an external link, or a path matching nothing.
      // Those are locale-independent and stay exactly as the admin wrote them.
      if (!group) {
        out.push({ ...item, children });
        continue;
      }

      const translated = byGroup.get(group);
      // Content with no translation here. Dropped, with its children — a parent
      // that vanishes must not leave its submenu behind, orphaned under nothing.
      if (!translated) continue;

      out.push({
        ...item,
        label: translated.title,
        url: contentPath(translated.contentType.routePrefix, translated.slug),
        children,
      });
    }

    return out;
  }

  /** "/blog/hello" -> { prefix: "blog", slug: "hello" }. External URLs -> null. */
  private parseInternalPath(url: string): { prefix: string; slug: string } | null {
    if (!url.startsWith("/") || url.startsWith("//")) return null;

    const clean = url.split(/[?#]/)[0] ?? "";
    const segments = clean.replace(/^\//, "").replace(/\/$/, "").split("/").filter(Boolean);

    const slug = segments.length ? segments[segments.length - 1]! : "";
    const prefix = segments.slice(0, -1).join("/");

    return { prefix, slug };
  }

  /** The site-root-relative URL of `path` in `locale`. The inverse of splitLocale. */
  private localePath(site: ResolvedSite, locale: string, path: string): string {
    const prefix = locale === site.defaultLocale ? "" : `/${locale}`;
    const joined = `${prefix}${path}`.replace(/\/{2,}/g, "/");
    return joined.length > 1 ? joined.replace(/\/$/, "") : joined || "/";
  }

  /**
   * The published siblings of a piece of content, as ready-to-use hrefs.
   *
   * Only PUBLISHED siblings, and only in locales the site still publishes in — a
   * draft translation must not appear in hreflang or in the switcher, and neither
   * must a locale that was removed from the site after content was written in it.
   *
   * A sibling's slug is its own: "/about" and "/vi/gioi-thieu" are the same page.
   * That is the whole reason this is a database read and not string concatenation.
   */
  private async alternatesFor(
    site: ResolvedSite,
    translationGroupId: string,
    current: string,
    demoThemeKey: string | null,
  ): Promise<LocaleAlternate[]> {
    const siblings = await db().content.findMany({
      where: {
        siteId: site.id,
        translationGroupId,
        status: "PUBLISHED",
        locale: { in: site.locales },
        demoThemeKey,
      },
      select: {
        locale: true,
        slug: true,
        contentType: { select: { routePrefix: true, isRoutable: true } },
      },
    });

    return siblings
      .filter((row) => row.contentType.isRoutable)
      .map((row) => {
        const prefix = row.contentType.routePrefix ? `/${row.contentType.routePrefix}` : "";
        const path = row.slug ? `${prefix}/${row.slug}` : prefix || "/";
        return {
          locale: row.locale,
          path: this.localePath(site, row.locale, path),
          current: row.locale === current,
          // Derived from the code, not stored: a site's locales are free text in
          // the database and were never validated against the registry Z-CMS
          // ships. `flagUrl` answers for any BCP-47 tag, including null.
          flagUrl: flagUrl(row.locale),
        };
      })
      // Site order, not database order: the switcher should not reshuffle itself
      // because a translation was edited.
      .sort(
        (a, b) => site.locales.indexOf(a.locale) - site.locales.indexOf(b.locale),
      );
  }

  /**
   * Is this path the index of a routable content type (e.g. "/blog")?
   * Only types with a non-empty prefix qualify — a page type with prefix ""
   * would otherwise turn the homepage into an archive of every page.
   */
  private async tryArchive(
    siteId: string,
    path: string,
    page: number,
    locale: string,
    activeThemeKey: string,
  ) {
    const prefix = path.replace(/^\//, "");
    if (!prefix) return null;

    const contentType = await db().contentType.findFirst({
      where: { siteId, routePrefix: prefix, isRoutable: true },
    });
    if (!contentType) return null;

    // Scoped to the locale being rendered. Without this, /vi/blog lists the
    // English posts — every item links off to a page in another language, and the
    // archive silently becomes the one place on the site where the language
    // switcher does nothing.
    const where = {
      siteId,
      contentTypeId: contentType.id,
      status: "PUBLISHED" as const,
      locale,
      OR: [{ demoThemeKey: null }, { demoThemeKey: activeThemeKey }],
    };

    const [items, total] = await Promise.all([
      db().content.findMany({
        where,
        include: CONTENT_INCLUDE,
        orderBy: { publishedAt: "desc" },
        skip: (page - 1) * ARCHIVE_PAGE_SIZE,
        take: ARCHIVE_PAGE_SIZE,
      }),
      db().content.count({ where }),
    ]);

    return {
      contentTypeKey: contentType.key,
      title: contentType.pluralName,
      basePath: `/${contentType.routePrefix}`,
      items: items.map(toContentDto),
      page,
      totalPages: Math.max(1, Math.ceil(total / ARCHIVE_PAGE_SIZE)),
    };
  }

  /**
   * Path -> content. The path carries the route prefix, so "/blog/hello" must
   * match a post with slug "hello" *whose type is routed at /blog* — not a page
   * that happens to be called "hello". Matching on the slug alone would let a
   * page shadow a post.
   */
  private async findContent(
    siteId: string,
    locale: string,
    path: string,
    activeThemeKey: string,
  ) {
    const trimmed = path.replace(/^\//, "");
    const segments = trimmed ? trimmed.split("/") : [];

    const slug = segments.length ? segments[segments.length - 1]! : "";
    const prefix = segments.slice(0, -1).join("/");

    const candidates = await db().content.findMany({
      where: {
        siteId,
        locale,
        slug,
        status: "PUBLISHED",
        OR: [{ demoThemeKey: null }, { demoThemeKey: activeThemeKey }],
        contentType: { routePrefix: prefix, isRoutable: true },
      },
      include: CONTENT_INCLUDE,
    });

    return (
      candidates.find((row) => row.demoThemeKey === activeThemeKey) ??
      candidates[0] ??
      null
    );
  }

  private preferThemeDemo<T extends { demoThemeKey: string | null }>(
    rows: T[],
    activeThemeKey: string,
  ): T[] {
    return [...rows].sort((a, b) => {
      const ar = a.demoThemeKey === activeThemeKey ? 1 : 0;
      const br = b.demoThemeKey === activeThemeKey ? 1 : 0;
      return ar - br;
    });
  }

  private normalizePath(path: string): string {
    if (!path || path === "/") return "/";
    const withLeading = path.startsWith("/") ? path : `/${path}`;
    return withLeading.length > 1 ? withLeading.replace(/\/+$/, "") : withLeading;
  }
}
