import { NextResponse, type NextRequest } from "next/server";

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
export function middleware(request: NextRequest) {
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
    `img-src 'self' data: ${s3}`.trim(),
    `font-src 'self' data:`,
    `connect-src 'self' ${api}${dev ? " ws:" : ""}`.trim(),
    `object-src 'none'`,
    `base-uri 'self'`,
    `frame-ancestors 'none'`,
    `form-action 'self'`,
    ...(dev ? [] : ["upgrade-insecure-requests"]),
  ].join("; ");

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
