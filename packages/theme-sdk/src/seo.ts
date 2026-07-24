import type { ContentDto, RenderPayload } from "@zcmsorg/schemas";
import type {
  ResolvedSeo,
  Theme,
  ThemeContext,
  ThemeIcons,
  ThemeOrganization,
  ThemeSeoDefaults,
} from "./types";

/**
 * Composes the document head for one page.
 *
 * Three sources, most specific first:
 *
 *   1. the page — `content.seo`, which a plugin may already have filtered,
 *   2. the site — whatever `Theme.seo(ctx)` derives from this site's settings,
 *   3. the theme — `manifest.seo`, the defaults it ships with.
 *
 * A page that sets nothing inherits the site's identity; a site that sets nothing
 * inherits the theme's. Nothing here reaches for a framework: the result is a
 * plain object, and the runtime is what turns it into <meta> tags.
 */
export function resolveSeo<S>(
  theme: Theme<S>,
  ctx: ThemeContext<S>,
  page: {
    content: ContentDto | null;
    archive: RenderPayload["archive"];
  },
): ResolvedSeo {
  const shipped: ThemeSeoDefaults = theme.manifest.seo ?? {};
  const derived: ThemeSeoDefaults = theme.seo?.(ctx) ?? {};

  const site = ctx.site;
  const pageSeo = page.content?.seo ?? {};

  // The organisation and the icons are merged field by field rather than
  // replaced wholesale: a site that overrides only the logo must not lose the
  // theme's address and social profiles by doing so.
  const organization = mergeOrganization(shipped.organization, derived.organization);

  // Icon paths are resolved through `ctx.asset`, which is what makes a favicon
  // the theme's rather than the runtime's: "assets/favicon.ico" is a file inside
  // *this* theme's package, and it resolves to that theme's asset base. An owner
  // who uploaded their own icon has an absolute URL, which `asset` passes through,
  // so it still wins.
  const icons = resolveThemeIcons({ ...shipped.icons, ...derived.icons }, ctx.asset);

  const titleTemplate = derived.titleTemplate ?? shipped.titleTemplate;
  const siteName = derived.defaultTitle ?? shipped.defaultTitle ?? site.name;

  const ownTitle = pageSeo.title || page.content?.title || page.archive?.title;

  const title = ownTitle
    ? applyTemplate(titleTemplate, ownTitle, siteName)
    : siteName;

  const description =
    pageSeo.description ??
    page.content?.excerpt ??
    derived.description ??
    shipped.description ??
    undefined;

  // A page may opt out of indexing; it may not opt *in* against a theme that has
  // switched indexing off site-wide. That is what makes `robots: { index: false }`
  // usable as a staging-wide kill switch: one setting, and no page can override it.
  const siteRobots = derived.robots ?? shipped.robots ?? { index: true, follow: true };
  const robots = pageSeo.noindex ? { index: false, follow: false } : siteRobots;

  return {
    title,
    description: description ?? undefined,
    canonical: pageSeo.canonical ?? undefined,
    robots,
    ogImage: pageSeo.ogImage ?? derived.ogImage ?? shipped.ogImage ?? undefined,
    ogType: page.content?.contentType.key === "post" ? "article" : "website",
    siteName,
    locale: site.locale,
    publishedTime: page.content?.publishedAt ?? undefined,
    twitterSite: derived.twitterSite ?? shipped.twitterSite ?? undefined,
    icons,
    organization,
  };
}

/**
 * Puts every icon *path* through the resolver, and leaves `themeColor` alone —
 * it is a colour, not a file, and the one field here that must not be treated as
 * one.
 *
 * Exported because the runtime needs the same mapping to resolve the icons it
 * falls back to when a theme declares none. Doing that by hand there would mean a
 * second list of "which of these fields is a path", and the day someone adds a
 * field to ThemeIcons only one of the two lists gets updated.
 */
export function resolveThemeIcons(
  icons: ThemeIcons,
  asset: (path: string) => string,
): ThemeIcons {
  const resolved: ThemeIcons = {};
  if (icons.favicon) resolved.favicon = asset(icons.favicon);
  if (icons.icon) resolved.icon = asset(icons.icon);
  if (icons.appleTouchIcon) resolved.appleTouchIcon = asset(icons.appleTouchIcon);
  if (icons.themeColor) resolved.themeColor = icons.themeColor;
  return resolved;
}

/** "Pricing" + "%s — Acme" -> "Pricing — Acme". No template: the title as-is. */
function applyTemplate(
  template: string | undefined,
  title: string,
  siteName: string,
): string {
  if (!template) return title;
  return template.replace("%s", title).replace("%site%", siteName);
}

function mergeOrganization(
  base: ThemeOrganization | undefined,
  override: ThemeOrganization | undefined,
): ThemeOrganization | undefined {
  if (!base && !override) return undefined;
  return {
    ...base,
    ...override,
    name: override?.name || base?.name || "",
    address: { ...base?.address, ...override?.address },
  };
}

/**
 * schema.org `Organization` as JSON-LD.
 *
 * Returned as a plain object, not a <script> tag: the runtime decides how to put
 * it in the document, and a theme that wants to render it itself can.
 */
export function organizationJsonLd(
  org: ThemeOrganization | undefined,
): Record<string, unknown> | null {
  if (!org?.name) return null;

  const address = org.address;
  const hasAddress =
    address && Object.values(address).some((v) => typeof v === "string" && v.length > 0);

  return prune({
    "@context": "https://schema.org",
    "@type": "Organization",
    name: org.name,
    legalName: org.legalName,
    url: org.url,
    logo: org.logo,
    email: org.email,
    telephone: org.phone,
    sameAs: org.sameAs?.length ? org.sameAs : undefined,
    address: hasAddress
      ? prune({
          "@type": "PostalAddress",
          streetAddress: address.street,
          addressLocality: address.locality,
          addressRegion: address.region,
          postalCode: address.postalCode,
          addressCountry: address.country,
        })
      : undefined,
  });
}

/** Drops empty keys — search engines read an absent field, not an empty one. */
function prune(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && v !== ""),
  );
}
