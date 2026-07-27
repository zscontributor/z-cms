import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";
import { canonicalHostFor, type RenderPayload } from "@zcmsorg/schemas";
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

  const q = Array.isArray(search.q) ? search.q[0] : search.q;

  return { payload: await resolveRender(hostname, path, page, q), path, hostname };
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
/** "localhost:3000" has no TLS; every other host is https. */
function originFor(hostname: string): string {
  return hostname.startsWith("localhost") ? `http://${hostname}` : `https://${hostname}`;
}

function localeAlternates(
  payload: RenderPayload,
  hostname: string,
): Record<string, string> | undefined {
  if (payload.alternates.length < 2) return undefined;

  const origin = originFor(hostname);
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

  // The canonical URL is always the LOCALE-PREFIXED address of this page ("/en",
  // "/en/about"), even when the visitor reached it unprefixed ("/", "/about").
  // Both spellings serve a 200 — neither redirects — so this <link rel="canonical">
  // is what tells a search engine the two are one page and "/en" is the copy to
  // index. The `current` alternate carries that prefixed path (cms-api built it);
  // a page's own `content.seo.canonical`, if set, still wins.
  const selfPath = payload.alternates.find((a) => a.current)?.path;
  const canonical = isNotFound
    ? undefined
    : (seo.canonical ?? (selfPath ? `${originFor(hostname)}${selfPath}` : undefined));
  const alternates = {
    ...(canonical ? { canonical } : {}),
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

  // A site answers on several registered domains, and each is a first-class address:
  // "z-soft.vn" stays on "z-soft.vn", it is NOT bounced to "z-soft.com.vn". Only a
  // www/apex SPELLING of a registered host that is not itself registered gets folded
  // onto it — "www.z-soft.vn" -> "z-soft.vn" — so each domain still has one address
  // rather than two that rank against each other. 308, not 302: a spelling is a
  // property of the site, not of today.
  //
  // `canonicalHostFor` returns null when the request is already canonical, when the
  // spelling is unrecognised, OR when `domains` is empty — the last is a payload from
  // an older cms-api or a cache written before this field, and serving where the
  // visitor is beats redirecting the whole site to "https://undefined/" permanently.
  const canonicalHost = hostname ? canonicalHostFor(hostname, payload.site.domains) : null;
  if (canonicalHost) {
    permanentRedirect(await canonicalUrl(canonicalHost));
  }

  // Every locale is addressed under its own prefix — the default included, so
  // "/en" is a real, indexable English URL. The unprefixed spelling ("/", "/about")
  // ALSO serves a 200 here rather than redirecting: cms-api resolves it to the same
  // default-locale page. The two are kept from competing in search by the canonical
  // <link> generateMetadata emits, which always names the "/en/…" form — so "/en"
  // is the copy that gets indexed while "/" stays a working entry point.

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
    const Archive = path === "/search" ? templates.search ?? templates.archive : templates.archive;

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
  // The homepage is the content with an empty slug — one per locale (the platform's
  // "empty slug IS the homepage" contract). Matching on `path === "/"` only caught
  // the default locale: a localized home keeps its locale prefix ("/ja", "/vi") on
  // purpose (see resolveRoute), so those fell through to `templates.page`, which
  // draws a page-head band above the theme's own hero — the hero "pushed down".
  const isHome = content.slug === "";
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
