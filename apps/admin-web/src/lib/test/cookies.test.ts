import { describe, expect, it } from "vitest";
import {
  ACCESS_TOKEN_COOKIE,
  REFRESH_TOKEN_COOKIE,
  SITE_COOKIE,
  THEME_COOKIE,
  accessCookieOptions,
  localeCookieOptions,
  refreshCookieOptions,
  siteCookieOptions,
} from "../cookies";

describe("cookie names", () => {
  it("are stable, distinct constants the middleware and API agree on", () => {
    // A rename on one side of the wire silently logs everyone out; pinning the
    // literal names is what makes that a failing test rather than an incident.
    const names = [ACCESS_TOKEN_COOKIE, REFRESH_TOKEN_COOKIE, SITE_COOKIE, THEME_COOKIE];
    expect(names).toEqual(["zcms_at", "zcms_rt", "zcms_site", "zcms_theme"]);
    expect(new Set(names).size).toBe(names.length); // no two share a name
  });
});

describe("accessCookieOptions / refreshCookieOptions", () => {
  it("keep the auth tokens httpOnly so client JS — and any XSS — cannot read them", () => {
    // The stated reason the token never touches localStorage; if httpOnly ever
    // flipped, an XSS in a rich-text field could exfiltrate the session.
    expect(accessCookieOptions.httpOnly).toBe(true);
    expect(refreshCookieOptions.httpOnly).toBe(true);
  });

  it("scope the tokens to lax same-site and the whole site path", () => {
    for (const opts of [accessCookieOptions, refreshCookieOptions]) {
      expect(opts.sameSite).toBe("lax");
      expect(opts.path).toBe("/");
    }
  });

  it("let the refresh cookie outlive the access cookie", () => {
    // The access token is short-lived and rotated behind the longer-lived refresh
    // token; the reverse would defeat silent re-auth.
    expect(refreshCookieOptions.maxAge).toBeGreaterThan(accessCookieOptions.maxAge);
  });
});

describe("siteCookieOptions / localeCookieOptions", () => {
  it("are also httpOnly, lax, and root-scoped", () => {
    for (const opts of [siteCookieOptions, localeCookieOptions]) {
      expect(opts.httpOnly).toBe(true);
      expect(opts.sameSite).toBe("lax");
      expect(opts.path).toBe("/");
    }
  });
});
