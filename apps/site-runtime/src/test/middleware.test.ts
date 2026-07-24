import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { middleware } from "../middleware";

/**
 * The middleware is the public site's security-header layer. Its CSP is the
 * backstop for a stored XSS on a surface that renders authored HTML: a strict
 * script-src with a per-request nonce means an <script> a block accidentally
 * carries has no nonce and never runs. These tests pin the headers that make
 * that true, and prove the nonce is fresh per request.
 */

function run(url = "http://site.test/blog?page=2") {
  return middleware(new NextRequest(url));
}

function csp(res: ReturnType<typeof middleware>): string {
  return res.headers.get("content-security-policy") ?? "";
}

beforeEach(() => {
  vi.stubEnv("CMS_API_URL", "http://api.internal:4100");
  vi.stubEnv("S3_PUBLIC_URL", "https://cdn.example/bucket/key");
});

describe("middleware", () => {
  it("locks default-src, object-src and frame-ancestors down to a safe baseline", () => {
    const policy = csp(run());

    expect(policy).toContain("default-src 'self'");
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("base-uri 'self'");
  });

  it("gives script-src a per-request nonce instead of 'unsafe-inline'", () => {
    // The whole point: only scripts carrying this nonce run, so injected inline
    // <script> from authored content is refused by the browser.
    const policy = csp(run());

    expect(policy).toMatch(/script-src 'self' 'nonce-[^']+' 'strict-dynamic'/);
    expect(policy).not.toContain("script-src 'self' 'unsafe-inline'");
  });

  it("mints a different nonce on every request so one cannot be replayed", () => {
    const a = csp(run()).match(/'nonce-([^']+)'/)?.[1];
    const b = csp(run()).match(/'nonce-([^']+)'/)?.[1];

    expect(a).toBeTruthy();
    expect(a).not.toBe(b);
  });

  it("sets the anti-clickjacking and MIME-sniffing headers", () => {
    const res = run();

    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(res.headers.get("permissions-policy")).toContain("geolocation=()");
  });

  it("adds HSTS and forbids eval in production", () => {
    vi.stubEnv("NODE_ENV", "production");

    const res = run();

    expect(res.headers.get("strict-transport-security")).toContain("max-age=31536000");
    expect(csp(res)).not.toContain("'unsafe-eval'");
    expect(csp(res)).toContain("upgrade-insecure-requests");
  });

  it("does not send HSTS in development, where the site is served over http", () => {
    vi.stubEnv("NODE_ENV", "development");

    const res = run();

    expect(res.headers.get("strict-transport-security")).toBeNull();
  });

  it("reduces S3_PUBLIC_URL to an origin, with and without a path", () => {
    // A CSP source is an origin; the bucket path is not part of one. Stripping it
    // by regex would also eat the host of a URL that never had a path.
    expect(csp(run())).toContain("img-src 'self' data: https://cdn.example");

    vi.stubEnv("S3_PUBLIC_URL", "https://cdn.example");
    expect(csp(run())).toContain("img-src 'self' data: https://cdn.example");
  });

  it("drops an internal API host the browser cannot parse from connect-src", () => {
    // Swarm names the service "z-cms_cms-api", and an underscore is not legal in a
    // CSP host-source: the browser rejects the token outright ("contains an invalid
    // source") and ignores it. It is also unroutable from a browser, so emitting it
    // only leaks the cluster's service naming.
    vi.stubEnv("CMS_API_URL", "http://z-cms_cms-api:4100");

    const policy = csp(run());

    expect(policy).not.toContain("z-cms_cms-api");
    expect(policy).toContain("connect-src 'self'");
  });

  it("uses CMS_API_PUBLIC_URL for connect-src when the browser must reach the API", () => {
    vi.stubEnv("CMS_API_URL", "http://z-cms_cms-api:4100");
    vi.stubEnv("CMS_API_PUBLIC_URL", "https://api.example.org");

    expect(csp(run())).toContain("connect-src 'self' https://api.example.org");
  });
});
