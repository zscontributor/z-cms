import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ACCESS_TOKEN_COOKIE, REFRESH_TOKEN_COOKIE } from "@/lib/cookies";
import { middleware } from "../middleware";

/** A request to `path` on this origin, carrying whatever cookies are given. */
function request(path: string, cookies: Record<string, string> = {}): NextRequest {
  const url = `https://admin.example.com${path}`;
  const cookieHeader = Object.entries(cookies)
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
  return new NextRequest(url, {
    headers: cookieHeader ? { cookie: cookieHeader } : {},
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

describe("middleware", () => {
  it("lets an authenticated request through to the admin", async () => {
    const response = await middleware(request("/content/pages", { [ACCESS_TOKEN_COOKIE]: "at" }));

    // NextResponse.next() is a pass-through: no redirect location.
    expect(response.headers.get("location")).toBeNull();
    // ...and it still carries the security header set.
    expect(response.headers.get("content-security-policy")).toBeTruthy();
  });

  it("redirects an unauthenticated request to /login and remembers where it was headed", async () => {
    const response = await middleware(request("/media"));

    const location = response.headers.get("location");
    expect(location).not.toBeNull();
    const redirectUrl = new URL(location as string);
    expect(redirectUrl.pathname).toBe("/login");
    expect(redirectUrl.searchParams.get("next")).toBe("/media");
  });

  it("redirects to the admin base path when mounted under /admin", async () => {
    vi.stubEnv("ADMIN_BASE_PATH", "/admin");

    const response = await middleware(request("/admin/media"));

    const redirectUrl = new URL(response.headers.get("location") as string);
    expect(redirectUrl.pathname).toBe("/admin/login");
    expect(redirectUrl.searchParams.get("next")).toBe("/media");
  });

  it("recognizes public auth pages under the admin base path", async () => {
    vi.stubEnv("ADMIN_BASE_PATH", "/admin");

    expect((await middleware(request("/admin/login"))).headers.get("location")).toBeNull();
    expect((await middleware(request("/admin/accept-invite?token=abc"))).headers.get("location")).toBeNull();
  });

  it("only ever redirects to a same-origin location, even for a crafted next query", async () => {
    // The gate records the *current* path as `next`, never a value from the query,
    // so a ?next=https://evil.com cannot turn the login bounce into an open
    // redirect: the destination stays on this origin.
    const response = await middleware(request("/dashboard?next=https://evil.com"));

    const redirectUrl = new URL(response.headers.get("location") as string);
    expect(redirectUrl.origin).toBe("https://admin.example.com");
    expect(redirectUrl.pathname).toBe("/login");
  });

  it("clears both auth cookies when it bounces an unauthenticated user", async () => {
    const response = await middleware(request("/settings"));

    // A stale/partial cookie must not linger after a failed gate.
    expect(response.cookies.get(ACCESS_TOKEN_COOKIE)?.value).toBe("");
    expect(response.cookies.get(REFRESH_TOKEN_COOKIE)?.value).toBe("");
  });

  it("does not gate the accept-invite page, which is reached before an account exists", async () => {
    const response = await middleware(request("/accept-invite?token=abc"));

    expect(response.headers.get("location")).toBeNull();
  });

  it("lets the login page validate a cookie instead of creating a redirect loop", async () => {
    const response = await middleware(request("/login", { [ACCESS_TOKEN_COOKIE]: "at" }));

    // A cookie can be expired or invalid. The login page's getMe() call is the
    // authority: it redirects a valid session and renders for a stale one.
    expect(response.headers.get("location")).toBeNull();
  });

  it("lets an unauthenticated user reach /login", async () => {
    const response = await middleware(request("/login"));

    expect(response.headers.get("location")).toBeNull();
  });

  it("silently rotates an expired access cookie using the refresh token", async () => {
    // The one place a fresh cookie pair can be written during a plain navigation:
    // a valid refresh token is exchanged and the request proceeds, no redirect.
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ accessToken: "new-at", refreshToken: "new-rt", user: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const response = await middleware(request("/content", { [REFRESH_TOKEN_COOKIE]: "rt" }));

    expect(response.headers.get("location")).toBeNull();
    expect(response.cookies.get(ACCESS_TOKEN_COOKIE)?.value).toBe("new-at");
    expect(response.cookies.get(REFRESH_TOKEN_COOKIE)?.value).toBe("new-rt");
  });

  it("redirects to /login when the refresh attempt fails", async () => {
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 401 }));

    const response = await middleware(request("/content", { [REFRESH_TOKEN_COOKIE]: "bad-rt" }));

    const redirectUrl = new URL(response.headers.get("location") as string);
    expect(redirectUrl.pathname).toBe("/login");
  });

  it("attaches the hardening headers to every response", async () => {
    const response = await middleware(request("/content/pages", { [ACCESS_TOKEN_COOKIE]: "at" }));

    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
  });

  it("allows the media CDN in img-src, so an uploaded file can be seen", async () => {
    // The media library renders plain <img> straight at S3. Without this origin the
    // upload succeeds and every thumbnail is then blocked by our own CSP.
    vi.stubEnv("S3_PUBLIC_URL", "https://cdn.example.org/zcms-media");

    const response = await middleware(request("/media", { [ACCESS_TOKEN_COOKIE]: "at" }));

    expect(response.headers.get("content-security-policy")).toContain(
      "img-src 'self' data: blob: https://cdn.example.org",
    );
  });

  it("allows the site runtime in img-src, so theme screenshots can be seen", async () => {
    vi.stubEnv("SITE_RUNTIME_URL", "https://sites.example.org");

    const response = await middleware(request("/appearance", { [ACCESS_TOKEN_COOKIE]: "at" }));

    expect(response.headers.get("content-security-policy")).toContain(
      "https://sites.example.org",
    );
  });

  it("drops the internal API host from connect-src rather than emitting an invalid source", async () => {
    // "z-cms_cms-api" is a Swarm service name. The underscore is not legal in a CSP
    // host-source, so the browser rejects the token and logs an error; the host is
    // unreachable from a browser anyway.
    vi.stubEnv("CMS_API_URL", "http://z-cms_cms-api:4100");

    const response = await middleware(request("/media", { [ACCESS_TOKEN_COOKIE]: "at" }));
    const policy = response.headers.get("content-security-policy") ?? "";

    expect(policy).not.toContain("z-cms_cms-api");
    expect(policy).toContain("connect-src 'self'");
  });
});
