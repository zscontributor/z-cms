import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { db } from "@zcmsorg/database";
import {
  buildContentDataSchema,
  type ContentDto,
  type CreateContentInput,
  type Paginated,
  type TranslationDto,
  type UpdateContentInput,
} from "@zcmsorg/schemas";
import { t } from "../common/i18n";
import { toContentDto } from "../common/mappers";
import { sanitizeBlocks } from "../common/sanitize-blocks";
import type { RequestActor } from "../common/request-context";
import { AuditService } from "../audit/audit.module";
import { QueueService } from "../queue/queue.module";
import { PluginsService } from "../plugins/plugins.service";
import { CacheService } from "../redis/cache.service";

const CONTENT_INCLUDE = {
  contentType: {
    select: { id: true, key: true, name: true, routePrefix: true },
  },
  author: { select: { id: true, name: true } },
} as const;

@Injectable()
export class ContentsService {
  constructor(
    private readonly cache: CacheService,
    private readonly plugins: PluginsService,
    private readonly audit: AuditService,
    private readonly queue: QueueService,
  ) {}

  /**
   * Rebuilds the site's sitemap after anything that changes which URLs exist.
   *
   * `jobId` is the site id, so a burst of publishes collapses into ONE rebuild
   * rather than one per edit — BullMQ refuses a duplicate id while the job is
   * still queued. Regenerating a 50k-URL sitemap once per keystroke would be a
   * self-inflicted load test.
   */
  private rebuildSitemap(actor: RequestActor, siteId: string): void {
    void this.queue
      .enqueue(
        "site.sitemap",
        { tenantId: actor.tenantId, siteId },
        { jobId: `sitemap-${siteId}`, delayMs: 5_000 },
      )
      .catch(() => undefined);
  }

  /**
   * Notifies plugins that something happened.
   *
   * Not awaited, on purpose. A publish is a user-facing action; it must not wait
   * on third-party code, and it must not fail if that code is broken. Plugins
   * react to the CMS — they do not gate it.
   */
  private emit(
    actor: RequestActor,
    siteId: string,
    action: string,
    payload: Record<string, unknown>,
  ): void {
    void this.plugins
      .dispatchAction(actor.tenantId, siteId, action, payload)
      .catch(() => undefined);
  }

  private async visibleDemoScope(
    siteId: string,
  ): Promise<({ demoThemeKey: null } | { demoThemeKey: string })[]> {
    const active = await db().siteTheme.findFirst({
      where: { siteId, status: "ACTIVE" },
      select: { theme: { select: { key: true } } },
    });

    return [{ demoThemeKey: null }, { demoThemeKey: active?.theme.key ?? "" }];
  }

  async list(
    siteId: string,
    query: {
      contentTypeKey?: string;
      status?: string;
      locale?: string;
      search?: string;
      page: number;
      perPage: number;
    },
  ): Promise<Paginated<ContentDto>> {
    const where = {
      siteId,
      OR: await this.visibleDemoScope(siteId),
      ...(query.contentTypeKey ? { contentType: { key: query.contentTypeKey } } : {}),
      ...(query.status ? { status: query.status as never } : {}),
      ...(query.locale ? { locale: query.locale } : {}),
      ...(query.search
        ? {
            AND: [
              {
                OR: [
                  { title: { contains: query.search, mode: "insensitive" as const } },
                  { slug: { contains: query.search, mode: "insensitive" as const } },
                ],
              },
            ],
          }
        : {}),
    };

    const [items, total] = await Promise.all([
      db().content.findMany({
        where,
        include: CONTENT_INCLUDE,
        orderBy: { updatedAt: "desc" },
        skip: (query.page - 1) * query.perPage,
        take: query.perPage,
      }),
      db().content.count({ where }),
    ]);

    return {
      items: items.map(toContentDto),
      page: query.page,
      perPage: query.perPage,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.perPage)),
    };
  }

  async findOne(siteId: string, id: string): Promise<ContentDto> {
    const content = await db().content.findFirst({
      where: { id, siteId, OR: await this.visibleDemoScope(siteId) },
      include: CONTENT_INCLUDE,
    });
    if (!content) throw new NotFoundException(t()("errors.content.notFound"));
    return toContentDto(content);
  }

  /**
   * Every locale the site publishes in, and this page's version of it — or null.
   *
   * One row per *site locale*, not per existing translation, and the difference is
   * the whole point: the editor has to show "Vietnamese — not translated yet" as a
   * thing you can act on. A list of what exists cannot say what is missing.
   *
   * Locales the site no longer publishes in are left out even if a row survives in
   * them: the router will not serve that URL, so offering to edit it would be
   * offering to edit a page nobody can reach.
   */
  async translations(siteId: string, id: string): Promise<TranslationDto[]> {
    const content = await db().content.findFirst({
      where: { id, siteId, OR: await this.visibleDemoScope(siteId) },
      select: { translationGroupId: true, demoThemeKey: true },
    });
    if (!content) throw new NotFoundException(t()("errors.content.notFound"));

    const [site, siblings] = await Promise.all([
      db().site.findFirst({ where: { id: siteId }, select: { locales: true } }),
      db().content.findMany({
        where: {
          siteId,
          translationGroupId: content.translationGroupId,
          demoThemeKey: content.demoThemeKey,
        },
        include: CONTENT_INCLUDE,
      }),
    ]);

    const byLocale = new Map(siblings.map((row) => [row.locale, toContentDto(row)]));

    return (site?.locales ?? []).map((locale) => {
      const dto = byLocale.get(locale);
      return {
        locale,
        content: dto
          ? {
              id: dto.id,
              title: dto.title,
              slug: dto.slug,
              path: dto.path,
              status: dto.status,
              updatedAt: dto.updatedAt,
            }
          : null,
      };
    });
  }

  async create(
    actor: RequestActor,
    siteId: string,
    input: CreateContentInput,
  ): Promise<ContentDto> {
    const [contentType, site] = await Promise.all([
      db().contentType.findFirst({ where: { id: input.contentTypeId, siteId } }),
      db().site.findFirst({ where: { id: siteId }, select: { defaultLocale: true } }),
    ]);
    if (!contentType) {
      throw new BadRequestException(t()("errors.content.contentTypeNotFound"));
    }

    this.validateData(contentType.fields, input.data);

    // The caller may leave the locale out; the site's default is the only sane
    // answer, and the API is the only side that knows it. A hardcoded fallback
    // here would file entries under a language the site may not even publish in.
    const locale = input.locale ?? site?.defaultLocale ?? "en";

    // A singleton is one per *locale*, not one per site — the homepage exists in
    // English and in Vietnamese, and neither is a duplicate of the other.
    if (contentType.isSingleton) {
      const existing = await db().content.count({
        where: { siteId, contentTypeId: contentType.id, locale, demoThemeKey: null },
      });
      if (existing > 0) {
        throw new BadRequestException(
          t()("errors.content.singletonExists", { name: contentType.name }),
        );
      }
    }

    // Creating a translation into a locale the group already has. The database
    // would refuse it anyway — (site, group, locale) is unique — but a raw
    // constraint violation reaches the admin as a 500 and tells the author
    // nothing. This is the same check, in a language a person can act on.
    if (input.translationGroupId) {
      const taken = await db().content.findFirst({
        where: {
          siteId,
          translationGroupId: input.translationGroupId,
          locale,
          demoThemeKey: null,
        },
        select: { id: true },
      });
      if (taken) {
        throw new BadRequestException(
          t()("errors.content.translationExists", { locale }),
        );
      }
    }

    // An AUTHOR may create content but not publish it. Enforced here rather than
    // by permissions alone, because the rule is about the *transition*, not the
    // resource: the same role may edit a draft it owns but never push it live.
    const status = this.resolveStatus(actor, input.status ?? "DRAFT");

    const content = await db().content.create({
      data: {
        tenantId: actor.tenantId,
        siteId,
        contentTypeId: contentType.id,
        locale,
        // Omitted for a new page: the column defaults to a fresh uuid, so the page
        // is the sole member of its own group. Supplied when this entry is a
        // translation of an existing one.
        ...(input.translationGroupId
          ? { translationGroupId: input.translationGroupId }
          : {}),
        title: input.title,
        slug: input.slug,
        excerpt: input.excerpt,
        data: input.data as never,
        // Rich text is rendered by themes with `dangerouslySetInnerHTML`, so the
        // HTML inside a block is stripped of scripts, handlers and javascript:
        // URLs here, at the write boundary — never at render time, where every
        // theme would have to remember. See common/sanitize-blocks.ts.
        blocks: sanitizeBlocks(input.blocks) as never,
        seo: input.seo as never,
        status: status as never,
        publishedAt: status === "PUBLISHED" ? new Date() : null,
        authorId: actor.userId,
      },
      include: CONTENT_INCLUDE,
    });

    await this.snapshot(actor, content.id, "Created");
    // A row created straight into PUBLISHED is already listable — the front page's
    // "latest posts" is wrong the instant this returns.
    await this.invalidate(
      siteId,
      content.status === "PUBLISHED",
      toContentDto(content).path,
    );

    const dto = toContentDto(content);
    this.emit(actor, siteId, "content.created", {
      siteId,
      contentId: dto.id,
      contentType: dto.contentType.key,
      title: dto.title,
    });
    if (dto.status === "PUBLISHED") {
      this.emit(actor, siteId, "content.published", {
        siteId,
        contentId: dto.id,
        contentType: dto.contentType.key,
        title: dto.title,
        path: dto.path,
        publishedAt: dto.publishedAt ?? new Date().toISOString(),
      });
    }

    await this.audit.record(actor, "content.created", "content", dto.id, {
      title: dto.title,
      contentType: dto.contentType.key,
      status: dto.status,
    });

    if (dto.status === "PUBLISHED") this.rebuildSitemap(actor, siteId);

    return dto;
  }

  async update(
    actor: RequestActor,
    siteId: string,
    id: string,
    input: UpdateContentInput,
  ): Promise<ContentDto> {
    const existing = await db().content.findFirst({
      where: { id, siteId },
      include: CONTENT_INCLUDE,
    });
    if (!existing) throw new NotFoundException(t()("errors.content.notFound"));

    this.assertCanEdit(actor, existing.authorId);

    if (input.data) {
      const contentType = await db().contentType.findFirst({
        where: { id: existing.contentTypeId },
      });
      this.validateData(contentType!.fields, input.data);
    }

    const status = input.status
      ? this.resolveStatus(actor, input.status)
      : (existing.status as string);

    const content = await db().content.update({
      where: { id },
      data: {
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.slug !== undefined ? { slug: input.slug } : {}),
        ...(input.excerpt !== undefined ? { excerpt: input.excerpt } : {}),
        ...(input.locale !== undefined ? { locale: input.locale } : {}),
        ...(input.data !== undefined ? { data: input.data as never } : {}),
        // Sanitised on update too: an edit is a write, and a page that was clean
        // on create must not become dirty on its second save.
        ...(input.blocks !== undefined
          ? { blocks: sanitizeBlocks(input.blocks) as never }
          : {}),
        ...(input.seo !== undefined ? { seo: input.seo as never } : {}),
        status: status as never,
        publishedAt:
          status === "PUBLISHED" && !existing.publishedAt
            ? new Date()
            : status === "PUBLISHED"
              ? existing.publishedAt
              : null,
      },
      include: CONTENT_INCLUDE,
    });

    await this.snapshot(actor, content.id, "Updated");
    // Both paths: the slug may have changed, so the old URL must be purged too.
    // Site-wide when the row is (or was) public: its title in a list, or its very
    // presence in one, may have just changed.
    await this.invalidate(
      siteId,
      existing.status === "PUBLISHED" || content.status === "PUBLISHED",
      toContentDto(existing).path,
      toContentDto(content).path,
    );

    // Field NAMES, not values. An audit row is read by a human looking for "who
    // touched this"; storing the whole new body would duplicate the version
    // snapshot and drag any sensitive field into a second table.
    await this.audit.record(actor, "content.updated", "content", content.id, {
      title: content.title,
      changed: Object.keys(input),
      statusFrom: existing.status,
      statusTo: content.status,
    });

    return toContentDto(content);
  }

  async setPublished(
    actor: RequestActor,
    siteId: string,
    id: string,
    published: boolean,
  ): Promise<ContentDto> {
    const existing = await db().content.findFirst({
      where: { id, siteId },
      include: CONTENT_INCLUDE,
    });
    if (!existing) throw new NotFoundException(t()("errors.content.notFound"));

    if (!actor.permissions.includes("content:publish")) {
      throw new ForbiddenException(t()("errors.content.publishForbidden"));
    }

    const content = await db().content.update({
      where: { id },
      data: {
        status: (published ? "PUBLISHED" : "DRAFT") as never,
        publishedAt: published ? (existing.publishedAt ?? new Date()) : null,
      },
      include: CONTENT_INCLUDE,
    });

    await this.snapshot(actor, id, published ? "Published" : "Unpublished");
    // Both directions are site-wide: publishing adds the row to every list of its
    // type, unpublishing must remove it from them.
    await this.invalidate(siteId, true, toContentDto(content).path);

    const dto = toContentDto(content);
    this.emit(
      actor,
      siteId,
      published ? "content.published" : "content.unpublished",
      published
        ? {
            siteId,
            contentId: dto.id,
            contentType: dto.contentType.key,
            title: dto.title,
            path: dto.path,
            publishedAt: dto.publishedAt ?? new Date().toISOString(),
          }
        : { siteId, contentId: dto.id, contentType: dto.contentType.key },
    );

    await this.audit.record(
      actor,
      published ? "content.published" : "content.unpublished",
      "content",
      dto.id,
      { title: dto.title, path: dto.path },
    );

    this.rebuildSitemap(actor, siteId);

    return dto;
  }

  async remove(actor: RequestActor, siteId: string, id: string): Promise<void> {
    const existing = await db().content.findFirst({
      where: { id, siteId },
      include: CONTENT_INCLUDE,
    });
    if (!existing) throw new NotFoundException(t()("errors.content.notFound"));

    const gone = toContentDto(existing);

    await db().content.delete({ where: { id } });
    // A deleted published row must vanish from the lists that carried it, not just
    // from its own URL.
    await this.invalidate(siteId, gone.status === "PUBLISHED", gone.path);

    // The row is gone; this audit line is the only thing left that says it ever
    // existed, so it carries enough to answer "what was deleted, and by whom".
    await this.audit.record(actor, "content.deleted", "content", id, {
      title: gone.title,
      path: gone.path,
      contentType: gone.contentType.key,
      status: gone.status,
    });

    if (gone.status === "PUBLISHED") this.rebuildSitemap(actor, siteId);
  }

  /**
   * Snapshots the row after every write. Storing the whole row rather than a
   * diff makes restore a copy instead of a replay, which is what you want at
   * 3am when someone has wrecked the homepage.
   */
  private async snapshot(actor: RequestActor, contentId: string, message: string) {
    const row = await db().content.findUnique({ where: { id: contentId } });
    if (!row) return;

    const last = await db().contentVersion.findFirst({
      where: { contentId },
      orderBy: { version: "desc" },
      select: { version: true },
    });

    await db().contentVersion.create({
      data: {
        tenantId: actor.tenantId,
        contentId,
        version: (last?.version ?? 0) + 1,
        snapshot: row as never,
        message,
        authorId: actor.userId,
      },
    });
  }

  private validateData(fields: unknown, data: Record<string, unknown>) {
    const schema = buildContentDataSchema(
      (fields ?? []) as Parameters<typeof buildContentDataSchema>[0],
    );
    const result = schema.safeParse(data);
    if (!result.success) {
      throw new BadRequestException({
        message: t()("errors.validation.invalidFields"),
        errors: result.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
    }
  }

  private resolveStatus(actor: RequestActor, requested: string): string {
    if (requested === "PUBLISHED" && !actor.permissions.includes("content:publish")) {
      throw new ForbiddenException(t()("errors.content.draftOnly"));
    }
    return requested;
  }

  private assertCanEdit(actor: RequestActor, authorId: string | null) {
    // "content:update" alone is not enough for an AUTHOR: they may only touch
    // their own rows. A permission string cannot express ownership, so the check
    // lives here, next to the data.
    if (actor.role === "AUTHOR" && authorId !== actor.userId) {
      throw new ForbiddenException(t()("errors.content.editOwnOnly"));
    }
  }

  /**
   * Drops the cached renders a content write has just made wrong.
   *
   * `paths` are the URLs of the row itself (both of them, when a slug changed), and
   * for a long time that was the whole story: a page appeared at one address, so one
   * address went stale.
   *
   * It stopped being true the moment content could be LISTED. A published post is now
   * also a row inside every `core/content-list` block and every theme-declared
   * collection on the site — the front page's "latest posts", a sidebar of related
   * products, the type's own archive. Those pages are cached under their own keys, and
   * a path-keyed purge names none of them: publishing a post would leave the front
   * page advertising the previous one until its TTL happened to lapse. "The article is
   * live but the home page does not show it" is the bug this exists to prevent.
   *
   * Working out *which* pages embed a list of this type would mean walking every
   * page's block tree, plus the active theme's manifest, on every publish — and then
   * being right about it. Bumping the site's cache version is ONE Redis INCR and
   * orphans every render of the site at once (see CacheService.invalidateSite). It
   * costs a cold cache for pages that did not actually change, which is a slower next
   * request. The alternative costs a wrong page, indefinitely.
   *
   * So: a write that changes what the public site can see purges the SITE; a write
   * that stays private (draft -> draft) purges only its own paths, and cannot have
   * changed a list, because a list only ever contains PUBLISHED rows.
   */
  private async invalidate(
    siteId: string,
    publiclyVisible: boolean,
    ...paths: string[]
  ) {
    await this.cache.invalidateSitePaths(siteId, [...new Set(paths)]);
    if (publiclyVisible) await this.cache.invalidateSite(siteId);
  }
}
