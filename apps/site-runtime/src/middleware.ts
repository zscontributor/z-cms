import { NextResponse, type NextRequest } from "next/server";
import {
  BYPASS_KEY_RE,
  MAINTENANCE_BYPASS_COOKIE,
  MAINTENANCE_BYPASS_PARAM,
  MAINTENANCE_PREVIEW_PARAM,
  maintenanceLocaleFor,
  maintenanceStateFor,
  maintenanceVerdict,
  retryAfterSeconds,
} from "@/lib/maintenance";
import { renderMaintenanceHtml } from "@/lib/maintenance-page";

/**
 * Security headers for the public site, with a per-request CSP nonce.
 *
 * A nonce is what makes `script-src` strict without `'unsafe-inline'`: Next
 * injects inline hydration scripts, and only scripts carrying this exact nonce
 * are allowed to run. An `<script>` an author accidentally pasted into block
 * richtext has no nonce, so the browser refuses it — the backstop for a stored
 * XSS on a surface that renders authored HTML.
 *
 * Why a nonce is safe here despite the render cache: these pages read the `Host`
 * header, which makes them dynamic — Next renders the HTML per request. Only the
 * `fetch` to cms-api is cached (its own data cache), so each request produces
 * fresh HTML with a fresh nonce while still reusing the expensive API result. A
 * nonce would only be unsafe if the whole HTML were statically cached and
 * replayed, which it is not.
 *
 * The nonce must reach Next: it is set on the *request* header the framework
 * reads (`x-nonce`) and in the CSP on both the request and the response.
 */
export async function middleware(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");

  const s3 = cspOrigin(process.env.S3_PUBLIC_URL);
  const api = cspOrigin(process.env.CMS_API_PUBLIC_URL ?? process.env.CMS_API_URL);
  const dev = process.env.NODE_ENV !== "production";

  const csp = [
    `default-src 'self'`,
    // 'strict-dynamic' lets Next's nonce'd loader pull in the chunks it needs
    // without listing every one. In dev, Next's HMR needs eval; never in prod.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    `style-src 'self' 'unsafe-inline'`,
    // Themes and authored content reference images from arbitrary external hosts
    // (CDNs, placeholder services, embedded media), so the public site must load
    // any secure image origin. `https:` opens image loading only; images cannot
    // execute, and script/connect stay locked to same-origin + the API.
    `img-src 'self' data: https:${dev ? " http:" : ""} ${s3}`.replace(/\s+/g, " ").trim(),
    // <video>/<audio> fall to media-src, not img-src — background-video nodes and
    // embedded media reference arbitrary external hosts, so open it the same way.
    `media-src 'self' data: blob: https:${dev ? " http:" : ""} ${s3}`
      .replace(/\s+/g, " ")
      .trim(),
    `font-src 'self' data:`,
    `connect-src 'self' ${api}${dev ? " ws:" : ""}`.trim(),
    `object-src 'none'`,
    `base-uri 'self'`,
    `frame-ancestors 'none'`,
    `form-action 'self'`,
    ...(dev ? [] : ["upgrade-insecure-requests"]),
  ].join("; ");

  // Maintenance mode is decided HERE, before any page: only a response written
  // by the middleware can carry the 503 that tells crawlers to come back later
  // rather than index (or de-index) a notice. `/api/*` is exempt — the cache-purge
  // hook, the readiness probe and the form endpoints are not pages, and the purge
  // hook in particular is how the admin's "open the site again" reaches us.
  if (!request.nextUrl.pathname.startsWith("/api/")) {
    const gate = await maintenanceGate(request, csp, dev, nonce);
    if (gate) return gate;
  }

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("content-security-policy", csp);

  // The URL, for the root layout.
  //
  // `<html lang>` and `<html dir>` depend on which locale the URL resolved to,
  // and only cms-api can say — "/vi/blog" is Vietnamese on a site that publishes
  // in Vietnamese and a 404 on one that does not. But a root layout receives no
  // params, so it cannot reconstruct the URL, and fetching one just to decorate
  // <html> would break the one-API-call-per-page contract.
  //
  // So the URL is handed to it here. The layout then calls the *same* resolve the
  // page does, with the same arguments — React `cache` dedupes them into one call,
  // and the contract holds.
  requestHeaders.set("x-pathname", request.nextUrl.pathname);
  requestHeaders.set("x-search", request.nextUrl.search);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  applySecurityHeaders(response, csp, dev);

  // `/sitemap.xml` and `/robots.txt` are fetched directly by crawlers and SEO
  // tools, never navigated to by Next's client router — so the `Vary: RSC,
  // Next-Router-…` header that NextResponse.next() stamps on for RSC negotiation
  // is meaningless on them, and it is exactly what keeps a CDN from caching the
  // response: Cloudflare (and most caches) refuse to cache anything whose Vary is
  // not a bare `Accept-Encoding`, which is why these come back `cf-cache-status:
  // DYNAMIC` and chunked. Narrowing Vary here lets the sitemap be edge-cached and
  // served with a Content-Length — friendlier to the stricter SEO crawlers, and a
  // load the origin then does not carry. Scoped to these two paths on purpose: a
  // real page still needs the RSC Vary for the client router's prefetch cache.
  const path = request.nextUrl.pathname;
  if (path === "/sitemap.xml" || path === "/robots.txt") {
    response.headers.set("vary", "Accept-Encoding");
  }

  return response;
}

/** The same headers on every response this middleware writes, gate or page. */
function applySecurityHeaders(response: NextResponse, csp: string, dev: boolean): void {
  response.headers.set("content-security-policy", csp);
  response.headers.set("x-content-type-options", "nosniff");
  response.headers.set("x-frame-options", "DENY");
  response.headers.set("referrer-policy", "strict-origin-when-cross-origin");
  response.headers.set(
    "permissions-policy",
    "camera=(), microphone=(), geolocation=()",
  );
  if (!dev) {
    response.headers.set(
      "strict-transport-security",
      "max-age=31536000; includeSubDomains",
    );
  }
}

/**
 * The maintenance gate: the notice, the bypass, or nothing.
 *
 * Returns a response when this request must not reach the site — the notice
 * itself (503 while the site is closed, 200 for an owner's preview), or the
 * redirect that turns `?zc-bypass=<key>` into the cookie the gate then honours.
 * Returns null to let the request through. See lib/maintenance.ts for why the
 * answer is memoised and why an unreachable cms-api opens rather than closes.
 */
async function maintenanceGate(
  request: NextRequest,
  csp: string,
  dev: boolean,
  nonce: string,
): Promise<NextResponse | null> {
  const url = request.nextUrl;

  // `/?zc-bypass=<key>` is the link the admin hands the owner. The key moves
  // from the URL into a cookie and the visitor is sent to the same page without
  // it — so the key is not in their history, their referrer, or the URL they
  // paste to a colleague. An empty value clears the cookie. The value is only
  // ever stored if it is SHAPED like a key; cms-api decides whether it is one.
  const bypassParam = url.searchParams.get(MAINTENANCE_BYPASS_PARAM);
  if (bypassParam !== null) {
    const clean = new URLSearchParams(url.searchParams);
    clean.delete(MAINTENANCE_BYPASS_PARAM);
    const query = clean.toString();
    const response = new NextResponse(null, {
      status: 302,
      headers: { location: `${url.pathname}${query ? `?${query}` : ""}` },
    });
    if (BYPASS_KEY_RE.test(bypassParam)) {
      response.cookies.set(MAINTENANCE_BYPASS_COOKIE, bypassParam, {
        httpOnly: true,
        sameSite: "lax",
        secure: !dev,
        path: "/",
        maxAge: 60 * 60 * 24 * 7,
      });
    } else {
      response.cookies.delete(MAINTENANCE_BYPASS_COOKIE);
    }
    applySecurityHeaders(response, csp, dev);
    return response;
  }

  // The same hostname resolution the page uses: the proxy's, when there is one.
  const hostname = (request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? "")
    .trim()
    .toLowerCase();
  const state = await maintenanceStateFor(hostname);
  const verdict = maintenanceVerdict(state, {
    cookie: request.cookies.get(MAINTENANCE_BYPASS_COOKIE)?.value,
    previewParam: url.searchParams.get(MAINTENANCE_PREVIEW_PARAM),
  });
  if (!state || !verdict) return null;

  const html = renderMaintenanceHtml(state, maintenanceLocaleFor(url.pathname, state.site), {
    nonce,
  });
  // Maintenance is an outage: 503 + Retry-After, so crawlers wait it out. Coming
  // soon is the site's launch page: a 200, indexable, no Retry-After — there is
  // nothing to come back FOR yet, and a 503 held for weeks reads as a dead site.
  const outage = verdict === "closed" && state.mode !== "coming-soon";
  const response = new NextResponse(html, {
    status: outage ? 503 : 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      // Never cached by a CDN: the moment the owner opens the site, the next
      // request must see it, not a copy of the notice with minutes left on it.
      "cache-control": "no-store",
      ...(outage ? { "retry-after": String(retryAfterSeconds(state)) } : {}),
    },
  });
  applySecurityHeaders(response, csp, dev);
  return response;
}

/**
 * A URL reduced to the origin a CSP can name — or "" if there is no such origin.
 *
 * Two things are being defended against. The first is the scheme+host+port shape:
 * a CSP source is an origin, so the path in `S3_PUBLIC_URL`
 * ("https://cdn.example.org/zcms-media") has to come off, and stripping it by
 * regex mangles a URL that never had one.
 *
 * The second is that the env var pointing at cms-api is an *internal* address.
 * Under Swarm it is "http://z-cms_cms-api:4100", and the underscore is not legal
 * in a CSP host-source: the browser rejects the token, logs "contains an invalid
 * source", and drops it. Emitting a host the browser cannot even parse — let alone
 * route to — buys nothing and leaks the cluster's service naming to every visitor,
 * so anything that is not a public hostname is dropped here instead. Set
 * `CMS_API_PUBLIC_URL` if the browser genuinely must reach the API cross-origin.
 */
function cspOrigin(value: string | undefined): string {
  if (!value) return "";
  try {
    const { protocol, hostname, port } = new URL(value);
    if (!/^[a-z0-9.-]+$/i.test(hostname)) return "";
    return `${protocol}//${hostname}${port ? `:${port}` : ""}`;
  } catch {
    return "";
  }
}

export const config = {
  // Everything except Next's own static assets, which are hashed and immutable,
  // and the two places a theme's own files are served from: `theme-assets` (a
  // downloaded theme, out of its verified bundle) and `z-theme-assets` (a built-in
  // one, out of public/). Neither is a page, so neither needs a site resolved for
  // it — and an icon request that went through here would pay a hostname lookup to
  // return the same bytes.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|theme-assets|z-theme-assets).*)",
  ],
};
