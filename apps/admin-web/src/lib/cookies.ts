/**
 * Cookie contract for the admin.
 *
 * The access token lives in an httpOnly cookie, never in localStorage: the
 * admin renders on the server, so the browser has no reason to ever hold the
 * token, and an XSS in a rich-text field must not be able to read it.
 */
export const ACCESS_TOKEN_COOKIE = "zcms_at";
export const REFRESH_TOKEN_COOKIE = "zcms_rt";
export const SITE_COOKIE = "zcms_site";
export const THEME_COOKIE = "zcms_theme";

const isProd = process.env.NODE_ENV === "production";

export interface CookieOptions {
  httpOnly: boolean;
  secure: boolean;
  sameSite: "lax";
  path: string;
  maxAge: number;
}

/** Access tokens are short-lived; the cookie is allowed to outlive the JWT
 *  slightly because expiry is enforced by the API, not by the browser. */
export const accessCookieOptions: CookieOptions = {
  httpOnly: true,
  secure: isProd,
  sameSite: "lax",
  path: "/",
  maxAge: 60 * 60, // 1h
};

export const refreshCookieOptions: CookieOptions = {
  httpOnly: true,
  secure: isProd,
  sameSite: "lax",
  path: "/",
  maxAge: 60 * 60 * 24 * 30, // 30d
};

/** Not httpOnly-sensitive, but there is no reason for client JS to read it. */
export const siteCookieOptions: CookieOptions = {
  httpOnly: true,
  secure: isProd,
  sameSite: "lax",
  path: "/",
  maxAge: 60 * 60 * 24 * 365,
};

/** A year, because a language that resets at every login is not a preference. */
export const localeCookieOptions: CookieOptions = {
  httpOnly: true,
  secure: isProd,
  sameSite: "lax",
  path: "/",
  maxAge: 60 * 60 * 24 * 365,
};
