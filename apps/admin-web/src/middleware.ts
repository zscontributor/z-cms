import { NextResponse, type NextRequest } from "next/server";
import type { AuthResult } from "@zcmsorg/schemas";
import {
  ACCESS_TOKEN_COOKIE,
  REFRESH_TOKEN_COOKIE,
  accessCookieOptions,
  refreshCookieOptions,
} from "@/lib/cookies";

const API_BASE = `${process.env.CMS_API_URL ?? "http://localhost:4000"}/api/v1`;

/**
 * The gate. It does not verify the JWT signature — that is the API's job, and
 * duplicating it here would mean shipping the secret to the edge. It only asks
 * "is there a credential at all", and silently rotates an expired access cookie
 * using the refresh token, which is the one place in the app where a new cookie
 * pair can actually be written during a plain navigation.
 */
export async function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl;

  // A per-request nonce for the CSP. Admin pages are per-user and never
  // full-page cached, so a nonce is both safe and the way to keep script-src
  // strict without 'unsafe-inline'. It must reach Next via the request header.
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("content-security-policy", csp(nonce));

  const forward = { request: { headers: requestHeaders } };

  const accessToken = request.cookies.get(ACCESS_TOKEN_COOKIE)?.value;
  const refreshToken = request.cookies.get(REFRESH_TOKEN_COOKIE)?.value;
  const isLoginPage = pathname === "/login";

  if (isLoginPage) {
    // Cookie presence is not proof of authentication. An expired or otherwise
    // invalid access token used to bounce /login to / here; the authenticated
    // layout then rejected it and bounced / back to /login forever. Let the
    // login page call getMe() and redirect genuinely authenticated users itself.
    return secure(NextResponse.next(forward), nonce);
  }

  // Redeeming an invitation is the one authenticated-looking thing a person does
  // before they have an account, so it cannot be behind the gate. Unlike /login it
  // is NOT bounced when a session already exists: the invite names a different
  // person, and accepting it signs the browser in as them. Sending an already
  // signed-in user to the dashboard instead would leave the link unusable on the
  // machine they are actually sitting at.
  if (pathname === "/accept-invite") {
    return secure(NextResponse.next(forward), nonce);
  }

  if (accessToken) return secure(NextResponse.next(forward), nonce);

  if (refreshToken) {
    const refreshed = await refresh(refreshToken);
    if (refreshed) {
      // The RSC render below this middleware would otherwise still see the OLD
      // request cookies and 401 a perfectly valid session: mutating
      // request.cookies rewrites the forwarded Cookie header.
      requestHeaders.set(
        "cookie",
        rewriteCookie(request.headers.get("cookie") ?? "", refreshed),
      );
      request.cookies.set(ACCESS_TOKEN_COOKIE, refreshed.accessToken);
      request.cookies.set(REFRESH_TOKEN_COOKIE, refreshed.refreshToken);

      const response = secure(NextResponse.next({ request: { headers: requestHeaders } }), nonce);
      response.cookies.set(ACCESS_TOKEN_COOKIE, refreshed.accessToken, accessCookieOptions);
      response.cookies.set(REFRESH_TOKEN_COOKIE, refreshed.refreshToken, refreshCookieOptions);
      return response;
    }
  }

  const loginUrl = new URL("/login", request.url);
  if (pathname !== "/") loginUrl.searchParams.set("next", `${pathname}${search}`);

  const response = secure(NextResponse.redirect(loginUrl), nonce);
  response.cookies.delete(ACCESS_TOKEN_COOKIE);
  response.cookies.delete(REFRESH_TOKEN_COOKIE);
  return response;
}

/** Builds the admin CSP. Stricter than the public site: no third-party anything. */
function csp(nonce: string): string {
  const api = cspOrigin(process.env.CMS_API_PUBLIC_URL ?? process.env.CMS_API_URL);
  const s3 = cspOrigin(process.env.S3_PUBLIC_URL);
  const dev = process.env.NODE_ENV !== "production";

  return [
    `default-src 'self'`,
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' data: blob: ${s3}`.trim(),
    `font-src 'self' data:`,
    // Server actions are same-origin; the API is called from the client only
    // through same-origin route handlers, but allow it explicitly for safety.
    `connect-src 'self' ${api}${dev ? " ws:" : ""}`.trim(),
    `object-src 'none'`,
    `base-uri 'self'`,
    `frame-ancestors 'none'`,
    `form-action 'self'`,
    ...(dev ? [] : ["upgrade-insecure-requests"]),
  ].join("; ");
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
 * route to — buys nothing and leaks the cluster's service naming to every admin,
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

/** Attaches the CSP and the rest of the security header set to a response. */
function secure(response: NextResponse, nonce: string): NextResponse {
  const dev = process.env.NODE_ENV !== "production";
  response.headers.set("content-security-policy", csp(nonce));
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

/** Swaps the auth cookies in a Cookie header so the RSC render sees the new pair. */
function rewriteCookie(cookie: string, refreshed: AuthResult): string {
  const parts = cookie
    .split(";")
    .map((c) => c.trim())
    .filter((c) => c && !c.startsWith(`${ACCESS_TOKEN_COOKIE}=`) && !c.startsWith(`${REFRESH_TOKEN_COOKIE}=`));
  parts.push(`${ACCESS_TOKEN_COOKIE}=${refreshed.accessToken}`);
  parts.push(`${REFRESH_TOKEN_COOKIE}=${refreshed.refreshToken}`);
  return parts.join("; ");
}

async function refresh(refreshToken: string): Promise<AuthResult | null> {
  try {
    const res = await fetch(`${API_BASE}/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken }),
      cache: "no-store",
    });
    if (!res.ok) return null;
    return (await res.json()) as AuthResult;
  } catch {
    return null;
  }
}

export const config = {
  matcher: [
    /*
     * Everything except Next's own assets and the favicon. Server Actions POST
     * to the page they live on, so they pass through here as well and get the
     * same refresh treatment.
     */
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
