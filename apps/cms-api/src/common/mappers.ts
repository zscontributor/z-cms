import { parseSiteBrand } from "@zcmsorg/schemas";
import type {
  ContentDto,
  ContentTypeDto,
  MediaDto,
  MediaFolderDto,
  MenuDto,
  MenuItemDto,
  SiteDto,
} from "@zcmsorg/schemas";

/**
 * The public path a piece of content is served at.
 *
 * Slugs are stored bare; routing lives on the content type. That way changing a
 * blog's URL prefix from /blog to /tin-tuc is one row update, not a rewrite of
 * every post's slug.
 */
export function contentPath(routePrefix: string, slug: string): string {
  const prefix = routePrefix ? `/${routePrefix}` : "";
  if (!slug) return prefix || "/";
  return `${prefix}/${slug}`;
}

type ContentRow = {
  id: string;
  siteId: string;
  locale: string;
  translationGroupId: string;
  title: string;
  slug: string;
  excerpt: string | null;
  data: unknown;
  blocks: unknown;
  seo: unknown;
  status: string;
  publishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  contentType: { id: string; key: string; name: string; routePrefix: string };
  author?: { id: string; name: string } | null;
};

export function toContentDto(row: ContentRow): ContentDto {
  return {
    id: row.id,
    siteId: row.siteId,
    contentType: {
      id: row.contentType.id,
      key: row.contentType.key,
      name: row.contentType.name,
    },
    locale: row.locale,
    translationGroupId: row.translationGroupId,
    title: row.title,
    slug: row.slug,
    path: contentPath(row.contentType.routePrefix, row.slug),
    excerpt: row.excerpt,
    data: (row.data ?? {}) as Record<string, unknown>,
    blocks: (row.blocks ?? []) as ContentDto["blocks"],
    seo: (row.seo ?? {}) as ContentDto["seo"],
    status: row.status as ContentDto["status"],
    publishedAt: row.publishedAt?.toISOString() ?? null,
    author: row.author ? { id: row.author.id, name: row.author.name } : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toContentTypeDto(row: {
  id: string;
  key: string;
  name: string;
  pluralName: string;
  description: string | null;
  isSingleton: boolean;
  isRoutable: boolean;
  routePrefix: string;
  hasBlocks: boolean;
  icon: string | null;
  fields: unknown;
}): ContentTypeDto {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    pluralName: row.pluralName,
    description: row.description,
    isSingleton: row.isSingleton,
    isRoutable: row.isRoutable,
    routePrefix: row.routePrefix,
    hasBlocks: row.hasBlocks,
    icon: row.icon,
    fields: (row.fields ?? []) as ContentTypeDto["fields"],
  };
}

export function toSiteDto(row: {
  id: string;
  slug: string;
  name: string;
  status: string;
  defaultLocale: string;
  locales: string[];
  settings: unknown;
  domains: { id: string; hostname: string; isPrimary: boolean }[];
  themes: {
    status: string;
    theme: { key: string; name: string };
    version: { version: string };
  }[];
}): SiteDto {
  const active = row.themes.find((t) => t.status === "ACTIVE");
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    status: row.status as SiteDto["status"],
    defaultLocale: row.defaultLocale,
    locales: row.locales,
    // `settings` is a JSON column; `parseSiteBrand` is what makes reading it safe.
    brand: parseSiteBrand(row.settings),
    domains: row.domains,
    activeTheme: active
      ? {
          key: active.theme.key,
          name: active.theme.name,
          version: active.version.version,
        }
      : null,
  };
}

type MenuItemRow = {
  id: string;
  label: string;
  url: string;
  target: string;
  order: number;
  parentId: string | null;
};

/** Flat rows -> nested tree, ordered. */
export function toMenuDto(
  menu: { key: string; name: string; items: MenuItemRow[] },
): MenuDto {
  const byParent = new Map<string | null, MenuItemRow[]>();
  for (const item of menu.items) {
    const siblings = byParent.get(item.parentId) ?? [];
    siblings.push(item);
    byParent.set(item.parentId, siblings);
  }

  const build = (parentId: string | null): MenuItemDto[] =>
    (byParent.get(parentId) ?? [])
      .sort((a, b) => a.order - b.order)
      .map((item) => ({
        id: item.id,
        label: item.label,
        url: item.url,
        target: item.target,
        children: build(item.id),
      }));

  return { key: menu.key, name: menu.name, items: build(null) };
}

export function toMediaDto(
  row: {
    id: string;
    storageKey: string;
    filename: string;
    mimeType: string;
    size: number;
    width: number | null;
    height: number | null;
    alt: string | null;
    folderId: string | null;
    createdAt: Date;
  },
  publicBaseUrl: string,
): MediaDto {
  return {
    id: row.id,
    // Built at read time, so moving buckets or putting a CDN in front never
    // requires touching stored rows.
    url: `${publicBaseUrl.replace(/\/$/, "")}/${row.storageKey}`,
    filename: row.filename,
    mimeType: row.mimeType,
    size: row.size,
    width: row.width,
    height: row.height,
    alt: row.alt,
    folderId: row.folderId,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toMediaFolderDto(row: {
  id: string;
  name: string;
  parentId: string | null;
  createdAt: Date;
  _count: { media: number; children: number };
}): MediaFolderDto {
  return {
    id: row.id,
    name: row.name,
    parentId: row.parentId,
    fileCount: row._count.media,
    subfolderCount: row._count.children,
    createdAt: row.createdAt.toISOString(),
  };
}
