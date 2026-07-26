import { NextResponse } from "next/server";
import { canonicalHostFor } from "@zcmsorg/schemas";
import {
  canonicalUrl,
  currentHostname,
  resolveChrome,
} from "@/lib/render-client";
import { siteTag } from "@/lib/cache-tags";
import { RENDER_REVALIDATE_SECONDS } from "@/lib/env";

/**
 * Serves `/sitemap.xml` on the site's own domain.
 *
 * The sitemap is not built here. The worker's `site.sitemap` job rebuilds it on
 * every publish and parks the XML in S3 at `sites/{siteId}/sitemap.xml` (see
 * apps/worker/src/jobs/sitemap.ts) — already carrying `<lastmod>` and the
 * `hreflang` alternates that only that job, with the full content set in hand,
 * can compute. This route just puts that object behind the one URL a search
 * engine actually asks for: `https://<site>/sitemap.xml`. Regenerating the XML
 * here would duplicate the worker and cost another pass over every row.
 *
 * The chain is: Host header -> cms-api resolves the site (the same hot `/`
 * resolve the homepage uses, so no extra round trip) -> its id -> the S3 object.
 */

/** The Host header decides which site this is, so this can never be static. */
export const dynamic = "force-dynamic";

/**
 * The sitemap as an XML response.
 *
 * `Content-Length` is set explicitly: without it Next streams the body chunked,
 * and a few stricter SEO crawlers wait for a declared length before they consider
 * the document complete. `middleware.ts` overrides the App Router's `Vary: RSC…`
 * header to `Accept-Encoding` on this path, which is what lets a CDN cache the
 * result at all — most refuse to cache a response whose Vary is anything else.
 */
function xmlResponse(body: string): NextResponse {
  return new NextResponse(body, {
    headers: {
      "content-type": "application/xml; charset=utf-8",
      // A crawler may re-fetch often; let it and any CDN hold the doc briefly. The
      // worker rebuilds on publish, and the fetch below revalidates, so a few
      // minutes of staleness is the ceiling.
      "cache-control": "public, max-age=300, s-maxage=300",
      "content-length": String(Buffer.byteLength(body)),
    },
  });
}

/**
 * A valid, empty sitemap. Returned when the object does not exist yet — a site
 * that has never published routable content has no URLs to advertise, and a
 * well-formed empty `<urlset>` is a truer answer to a crawler than a 404, which
 * reads as "this site has no sitemap" and gets retried as an error.
 */
const EMPTY_SITEMAP =
  `<?xml version="1.0" encoding="UTF-8"?>\n` +
  `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>\n`;

export async function GET(): Promise<Response> {
  const hostname = await currentHostname();
  const payload = await resolveChrome(hostname);

  // Unknown domain — no site, no sitemap. A bare 404 is the honest answer; there
  // is no theme 404 to render for a non-page resource.
  if (!payload) {
    return new NextResponse("Not found", { status: 404 });
  }

  // The same canonicalisation the page does: only a www/apex spelling of a
  // registered host folds onto it, so each registered domain keeps its own sitemap
  // rather than one domain's crawler being bounced to another's.
  const canonicalHost = hostname ? canonicalHostFor(hostname, payload.site.domains) : null;
  if (canonicalHost) {
    return NextResponse.redirect(await canonicalUrl(canonicalHost), 308);
  }

  const base = process.env.S3_PUBLIC_URL?.replace(/\/+$/, "");
  if (!base) {
    // Misconfiguration, not a client error: the object exists but we cannot name
    // its public URL. Fail loud rather than serve an empty sitemap that would
    // quietly de-list the whole site.
    return new NextResponse("sitemap storage not configured", { status: 500 });
  }

  const objectUrl = `${base}/sites/${payload.site.id}/sitemap.xml`;

  let upstream: Response;
  try {
    upstream = await fetch(objectUrl, {
      headers: { Accept: "application/xml" },
      // Cached the same way rendered pages are: a short TTL as the safety net,
      // and tagged with the site so a chrome purge drops it early. A publish
      // rebuilds the S3 object within seconds; this bounds how long the old copy
      // is served after that.
      next: {
        revalidate: RENDER_REVALIDATE_SECONDS,
        // Tagged by the host actually served — cms-api purges every registered
        // hostname's siteTag on publish, so this drops with the rest.
        tags: [siteTag(hostname)],
      },
    });
  } catch {
    return new NextResponse("sitemap upstream unreachable", { status: 502 });
  }

  // Not built yet (or swept) — a valid empty sitemap, briefly cached so it fills
  // in once the worker writes the object.
  if (upstream.status === 403 || upstream.status === 404) {
    return xmlResponse(EMPTY_SITEMAP);
  }

  if (!upstream.ok) {
    return new NextResponse("sitemap upstream error", { status: 502 });
  }

  const xml = await upstream.text();
  return xmlResponse(xml);
}
