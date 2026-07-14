import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";
import type { RenderPayload } from "@zcmsorg/schemas";
import { organizationJsonLd, resolveSeo } from "@zcmsorg/theme-sdk";
import { buildThemeContext } from "@/lib/theme-context";
import { resolveTheme, withPlatformIcons } from "@/lib/theme-registry";
import {
  canonicalUrl,
  currentHostname,
  parsePageParam,
  resolveRender,
} from "@/lib/render-client";

/**
 * The one route this app has.
 *
 * Every public URL of every tenant lands here: the Host header says which site,
 * the slug says which path, and one call to `render/resolve` returns everything
 * needed to draw the page. There is no per-tenant build and no route per content
 * type — routing is data, resolved at request time by cms-api.
 */

type SearchParams = Record<string, string | string[] | undefined>;

interface RouteProps {
  params: Promise<{ slug?: string[] }>;
  searchParams: Promise<SearchParams>;
}

/** ["blog","hello"] -> "/blog/hello"; [] (the homepage) -> "/". */
function pathFromSlug(slug: string[] | undefined): string {
  const segments = (slug ?? []).filter(Boolean);
  return segments.length === 0 ? "/" : `/${segments.join("/")}`;
}

async function resolveRoute(props: RouteProps): Promise<{
  payload: RenderPayload | null;
  path: string;
  hostname: string;
}> {
  const [{ slug }, search, hostname] = await Promise.all([
    props.params,
    props.searchParams,
    currentHostname(),
  ]);

  // The locale prefix is left in the path on purpose. cms-api owns the mapping
  // from URL to locale — it is the only side that knows which languages this site
  // publishes in, and therefore whether "/vi/…" is Vietnamese or a page slugged
  // "vi". Splitting it here would be site-runtime guessing.
  const path = pathFromSlug(slug);
  const page = parsePageParam(search.page);

  return { payload: await resolveRender(hostname, path, page), path, hostname };
}

/**
 * hreflang, as Next expects it.
 *
 * Two rules that are easy to get wrong and cost real indexing:
 *
 *   - the URLs must be absolute. A relative hreflang is ignored.
 *   - `x-default` must exist, and point at the default locale — it is what a
 *     search engine serves to a reader whose language the site does not publish.
 *
 * A page with no translations gets no `languages` block at all: hreflang that
 * names only the page itself is noise, and hreflang naming a page that does not
 * exist is an error.
 */
function localeAlternates(
  payload: RenderPayload,
  hostname: string,
): Record<string, string> | undefined {
  if (payload.alternates.length < 2) return undefined;

  const origin = hostname.startsWith("localhost") ? `http://${hostname}` : `https://${hostname}`;
  const languages: Record<string, string> = {};

  for (const alternate of payload.alternates) {
    languages[alternate.locale] = `${origin}${alternate.path}`;
  }

  const fallback = payload.alternates.find(
    (a) => a.locale === payload.site.defaultLocale,
  );
  if (fallback) languages["x-default"] = `${origin}${fallback.path}`;

  return languages;
}

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

/**
 * The document head belongs to the theme.
 *
 * The theme decides the title shape, the icons, the organisation identity and
 * the social card; `resolveSeo` folds those together with whatever the page (and
 * any SEO plugin that filtered it) says, and this function is the only place that
 * knows the result has to be expressed as a Next.js `Metadata` object. A theme
 * never imports Next.
 */
export async function generateMetadata(props: RouteProps): Promise<Metadata> {
  // Shares the single resolve of this request via React `cache` — no extra call.
  const { payload, hostname } = await resolveRoute(props);
  if (!payload) return { title: "404" };

  const { theme, assetBase } = await resolveTheme(
    payload.theme.key,
    payload.theme.version,
    payload.theme.origin,
  );
  const ctx = buildThemeContext(theme, payload, assetBase);

  const seo = resolveSeo(theme, ctx, {
    content: payload.content,
    archive: payload.archive,
  });

  // Nothing lives here and it is not an archive: a 404 must never be indexed,
  // whatever the theme's default says.
  const isNotFound = !payload.content && !payload.archive;
  const robots = isNotFound ? { index: false, follow: false } : seo.robots;

  const languages = isNotFound ? undefined : localeAlternates(payload, hostname);
  const alternates = {
    ...(seo.canonical ? { canonical: seo.canonical } : {}),
    ...(languages ? { languages } : {}),
  };

  // A theme is free to ship no icons at all. Rather than emit a document with no
  // <link rel="icon"> — which leaves the browser asking for /favicon.ico and
  // getting a 404 — anything the theme left out is filled in from the platform's
  // own. Whatever the theme (or the site owner) DID declare still wins.
  const icons = withPlatformIcons(seo.icons);

  return {
    title: seo.title,
    ...(seo.description ? { description: seo.description } : {}),
    ...(Object.keys(alternates).length > 0 ? { alternates } : {}),
    robots,
    icons: {
      ...(icons.favicon ? { shortcut: icons.favicon } : {}),
      ...(icons.icon ? { icon: icons.icon } : {}),
      ...(icons.appleTouchIcon ? { apple: icons.appleTouchIcon } : {}),
    },
    ...(icons.themeColor ? { other: { "theme-color": icons.themeColor } } : {}),
    openGraph: {
      title: seo.title,
      ...(seo.description ? { description: seo.description } : {}),
      siteName: seo.siteName,
      locale: seo.locale,
      type: seo.ogType,
      ...(seo.ogImage ? { images: [{ url: seo.ogImage }] } : {}),
      ...(seo.ogType === "article" && seo.publishedTime
        ? { publishedTime: seo.publishedTime }
        : {}),
    },
    twitter: {
      card: seo.ogImage ? "summary_large_image" : "summary",
      title: seo.title,
      ...(seo.description ? { description: seo.description } : {}),
      ...(seo.twitterSite ? { site: seo.twitterSite } : {}),
      ...(seo.ogImage ? { images: [seo.ogImage] } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

export default async function CatchAllPage(props: RouteProps) {
  const { payload, path, hostname } = await resolveRoute(props);

  // No site for this hostname: a clean 404, never a 500.
  if (!payload) notFound();

  // Reached by one of the site's other names — "www.z-cms.org" when the site is
  // "z-cms.org". It resolved, so the visitor is in the right place; they are just
  // at the wrong address for it. 308 rather than 302: this is a property of the
  // site, not of today, and a permanent redirect is what moves the search ranking
  // onto the canonical host instead of splitting it across both.
  //
  // The canonical host must be non-empty before it can be redirected to. A payload
  // from an older cms-api — or one served from a cache written before this field
  // existed — carries no `canonicalHost`, and `!==` against `undefined` is true for
  // every request: without this check the whole site 308s to "https://undefined/",
  // permanently, in every visitor's browser cache. Serving the page on a
  // non-canonical host is a far smaller harm than that.
  const canonicalHost = payload.site.canonicalHost;
  if (canonicalHost && hostname && hostname !== canonicalHost) {
    permanentRedirect(await canonicalUrl(canonicalHost));
  }

  // The theme is fetched, signature-verified and imported on demand — a theme
  // installed a minute ago renders here without this app being rebuilt.
  const { theme, stylesheet, assetBase } = await resolveTheme(
    payload.theme.key,
    payload.theme.version,
    payload.theme.origin,
  );
  const ctx = buildThemeContext(theme, payload, assetBase);
  const { Layout, templates } = theme;
  // Themes published before integration slots existed still receive floating UI.
  // A new theme opts into ownership by declaring the slot in its manifest.
  const legacyFloatingIntegration = theme.manifest.integrationSlots?.includes("floating")
    ? null
    : ctx.renderSlot("floating");

  // A dynamically installed theme ships its own compiled CSS: site-runtime's
  // Tailwind build scanned only site-runtime's source, so it has never seen this
  // theme's classes and cannot have emitted them.
  const themeStyles = stylesheet ? (
    <link rel="stylesheet" href={stylesheet} precedence="high" />
  ) : null;

  // The publisher identity the theme declares, as schema.org JSON-LD. Rendered
  // here rather than in the theme so that every theme gets it for free by filling
  // in `organization` — and none of them has to hand-write a <script> tag.
  const orgLd = organizationJsonLd(
    resolveSeo(theme, ctx, { content: payload.content, archive: payload.archive })
      .organization,
  );

  const structuredData = orgLd ? (
    <script
      type="application/ld+json"
      // `<` is escaped rather than trusted. These values come from theme settings
      // an admin typed, and a literal "</script>" in one of them would otherwise
      // close this tag and turn the rest into markup the browser executes.
      dangerouslySetInnerHTML={{
        __html: JSON.stringify(orgLd).replace(/</g, "\\u003c"),
      }}
    />
  ) : null;

  // Archive routes ("/blog") come back with `archive` set and `content` null.
  if (payload.archive) {
    const Archive = templates.archive;

    if (!Archive) {
      // A theme with no archive template cannot draw a listing. Falling through
      // to a 404 is honest; pretending the URL does not exist beats a blank page.
      console.warn(
        `[render] Theme "${theme.manifest.id}" declares no archive template; ${path} has nothing to render it with.`,
      );
      notFound();
    }

    return (
      <Layout ctx={ctx}>
        {themeStyles}
        {structuredData}
        <Archive ctx={ctx} archive={payload.archive} />
        {legacyFloatingIntegration}
      </Layout>
    );
  }

  // The site exists, this path does not. next/navigation's notFound() gives the
  // real 404 status; app/not-found.tsx redraws it inside this site's theme.
  if (!payload.content) notFound();

  const content = payload.content;
  const isHome = path === "/";
  const isPost = content.contentType.key === "post";

  // `page` is the only required template — everything falls back to it, so a
  // theme that ships nothing else still renders every content type.
  const Template =
    (isPost ? templates.post : undefined) ??
    (isHome ? templates.home : undefined) ??
    templates.page;

  return (
    <Layout ctx={ctx}>
      {themeStyles}
      {structuredData}
      <Template ctx={ctx} content={content} />
      {legacyFloatingIntegration}
    </Layout>
  );
}
