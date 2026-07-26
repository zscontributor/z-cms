import { NextResponse } from "next/server";
import { canonicalHostFor } from "@zcmsorg/schemas";
import { canonicalUrl, currentHostname, resolveChrome } from "@/lib/render-client";

/**
 * Serves `/robots.txt` on the site's own domain.
 *
 * Its one job that matters for SEO is the `Sitemap:` line: a crawler that lands
 * on a bare domain reads robots.txt first, and that is how it discovers the
 * sitemap without anyone submitting the URL by hand. Per-page indexing is still
 * governed by each page's `robots` meta tag (see the site page); this file only
 * opens the door and points at the map.
 */

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const hostname = await currentHostname();
  const payload = await resolveChrome(hostname);

  // Unknown domain: refuse everything rather than invite a crawl of a site that
  // is not configured here.
  if (!payload) {
    return new NextResponse("User-agent: *\nDisallow: /\n", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  // Only a www/apex spelling folds onto its registered host; each registered domain
  // serves its own robots.txt, pointing at its own sitemap.
  const canonicalHost = hostname ? canonicalHostFor(hostname, payload.site.domains) : null;
  if (canonicalHost) {
    return NextResponse.redirect(await canonicalUrl(canonicalHost), 308);
  }

  // Absolute, on the host actually served — the spec requires the Sitemap URL be
  // fully qualified, and it must name the same host the sitemap's own <loc> entries
  // use, which for a registered domain is that domain itself.
  const proto = process.env.NODE_ENV === "production" ? "https" : "http";
  const host = hostname;
  const sitemapUrl = `${proto}://${host}/sitemap.xml`;

  const body = `User-agent: *\nAllow: /\n\nSitemap: ${sitemapUrl}\n`;

  return new NextResponse(body, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=300, s-maxage=300",
      // Explicit length so the response is not streamed chunked — see the sitemap
      // route. `middleware.ts` fixes the Vary header on this path so a CDN caches it.
      "content-length": String(Buffer.byteLength(body)),
    },
  });
}
