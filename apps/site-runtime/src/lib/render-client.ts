import { cache } from "react";
import { headers } from "next/headers";
import { BASE_LOCALE, directionOf } from "@zcmsorg/i18n";
import type { RenderPayload } from "@zcmsorg/schemas";
import { CMS_API_URL, CMS_INTERNAL_TOKEN, RENDER_REVALIDATE_SECONDS } from "./env";
import { normalisePath, renderTags } from "./cache-tags";

/**
 * The one call that renders a page.
 *
 * `GET /api/v1/render/resolve` answers with the site, its active theme + settings,
 * the menus and the matched content in a single payload — see RenderPayload. This
 * module is the *only* place site-runtime talks to cms-api, so caching, auth and
 * failure policy are decided once.
 */

export class RenderApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "RenderApiError";
  }
}

/** The Host header, lowercased. Port included: "localhost:3000" is a real domain row. */
export async function currentHostname(): Promise<string> {
  const h = await headers();
  // x-forwarded-host wins behind a proxy/CDN, which is how this looks in prod.
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "";
  return host.trim().toLowerCase();
}

/**
 * The same URL, on the site's canonical host.
 *
 * cms-api resolves "www.z-cms.org" and "z-cms.org" to the same site, because they
 * are the same site. But serving both would give every page two addresses, and a
 * search engine treats that as two competing pages rather than one — so the visitor
 * is sent to the canonical one, keeping the path and the query string they asked for.
 */
export async function canonicalUrl(canonicalHost: string): Promise<string> {
  const h = await headers();
  // Behind TLS termination the request arrives as plain http, so the scheme has to
  // come from the proxy — redirecting to http:// would downgrade the visitor.
  const forwarded = h.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const proto = forwarded || (process.env.NODE_ENV === "production" ? "https" : "http");
  const path = h.get("x-pathname") ?? "/";
  const search = h.get("x-search") ?? "";
  return `${proto}://${canonicalHost}${path}${search}`;
}

/**
 * Resolves one URL for one hostname.
 *
 * Returns `null` when the hostname maps to no site (API 404) — an unknown domain
 * must render a clean 404, never a 500. A payload whose `content` and `archive`
 * are both null is still a *successful* resolve: the site exists, the path does
 * not, and the caller has enough (theme, menus) to render the theme's 404.
 *
 * Wrapped in React `cache` so `generateMetadata` and the page component of the
 * same request share one result, and one network call.
 */
export const resolveRender = cache(
  async (
    hostname: string,
    path: string,
    page: number,
    searchQuery?: string,
  ): Promise<RenderPayload | null> => {
    if (!hostname) return null;

    const cleanPath = normalisePath(path);
    const url = new URL(`${CMS_API_URL()}/api/v1/render/resolve`);
    url.searchParams.set("hostname", hostname);
    url.searchParams.set("path", cleanPath);
    url.searchParams.set("page", String(page));
    if (cleanPath === "/search" && searchQuery?.trim()) {
      url.searchParams.set("q", searchQuery.trim());
    }

    let response: Response;
    try {
      response = await fetch(url, {
        headers: {
          "X-Internal-Token": CMS_INTERNAL_TOKEN(),
          Accept: "application/json",
        },
        next: {
          revalidate: RENDER_REVALIDATE_SECONDS,
          // Tagged so cms-api can purge exactly this page (or the whole site)
          // on publish, rather than waiting out the TTL.
          tags: renderTags(hostname, cleanPath),
        },
      });
    } catch (cause) {
      throw new RenderApiError(
        `cms-api unreachable at ${CMS_API_URL()} while resolving ${hostname}${cleanPath}.`,
        502,
        { cause },
      );
    }

    // No site for this hostname. Not an error condition — a 404 page is the
    // correct answer for a domain that points here but is not (yet) configured.
    if (response.status === 404) return null;

    if (!response.ok) {
      throw new RenderApiError(
        `render/resolve failed for ${hostname}${cleanPath}: ${response.status} ${response.statusText}`,
        response.status,
      );
    }

    return (await response.json()) as RenderPayload;
  },
);

/**
 * The site chrome (theme, settings, menus) without a specific page — what the
 * 404 route needs so it can still render inside the site's own theme. Reuses the
 * homepage resolve, which is the hottest cache entry there is, and ignores its
 * content.
 */
export async function resolveChrome(hostname: string): Promise<RenderPayload | null> {
  return resolveRender(hostname, "/", 1);
}

/** Parses ?page= from Next's searchParams. Anything nonsensical means page 1. */
export function parsePageParam(
  value: string | string[] | undefined,
): number {
  const raw = Array.isArray(value) ? value[0] : value;
  const parsed = Number.parseInt(raw ?? "1", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

/**
 * The language of the document, for the root layout.
 *
 * Which locale a URL is in is a question only cms-api can answer — "/vi/blog" is
 * Vietnamese on a site that publishes in Vietnamese, and a page slugged "vi" on
 * one that does not. But the root layout gets no params, so `middleware.ts` puts
 * the URL on a request header for it.
 *
 * This resolves through the very same `resolveRender` the page will call, with
 * the same arguments, so React's `cache` returns the *same promise* — the layout
 * costs no additional round trip and the one-call-per-page contract holds. Any
 * drift between the arguments built here and the ones built in the page would
 * silently double the API calls, which is why both derive them the same way.
 *
 * Failure is not fatal. If cms-api is down the page will render its own error;
 * the shell around it does not also need to explode over `lang`.
 */
export async function resolveDocumentLocale(): Promise<{
  lang: string;
  dir: "ltr" | "rtl";
}> {
  try {
    const payload = await resolveDocumentPayload();

    const locale = payload?.site.locale;
    if (!locale) return { lang: BASE_LOCALE, dir: "ltr" };

    return { lang: locale, dir: directionOf(locale) };
  } catch {
    return { lang: BASE_LOCALE, dir: "ltr" };
  }
}

/**
 * The payload for the URL currently being rendered, resolved the way the root
 * layout has to resolve it: from the headers `middleware.ts` planted, because a
 * layout receives no params.
 *
 * Everything the document shell needs — `lang`, `dir`, and the active theme's
 * colour modes — comes from this one call, and it is the SAME React-cached call the
 * page makes, so the one-API-request-per-page contract holds. Any drift between the
 * arguments built here and the ones built in the page would silently double the
 * traffic to cms-api, which is why they are built in one place.
 */
export async function resolveDocumentPayload(): Promise<RenderPayload | null> {
  const h = await headers();
  const pathname = h.get("x-pathname") ?? "/";
  const search = new URLSearchParams(h.get("x-search") ?? "");

  return resolveRender(
    await currentHostname(),
    normalisePath(pathname),
    parsePageParam(search.get("page") ?? undefined),
    search.get("q") ?? undefined,
  );
}
