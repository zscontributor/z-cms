import { headers } from "next/headers";
import { cache } from "react";
import type { SiteBrandingDto } from "@zcmsorg/schemas";
import { apiFetch } from "./api";

/**
 * Which site's admin is this, according to the address bar?
 *
 * The admin is served at `/admin` on EVERY tenant hostname — z-soft.com.vn/admin,
 * z-cms.org/admin, a customer's own domain/admin — so the Host header already names
 * the site. Before sign-in there is no session to ask with, and the screen used to
 * be identical everywhere: the same Z-CMS mark, the same "Sign in to Z-CMS", whoever
 * you were and whichever site you had come to run.
 *
 * So the hostname is the question and cms-api's public branding lookup is the
 * answer. Everything here degrades to null rather than throwing — a site that cannot
 * be identified (the dedicated admin hostname, an unregistered domain, an API that
 * is having a bad minute) must still render a sign-in form, because the form is what
 * the page is for.
 */
export interface SiteBranding {
  siteId: string;
  /** The site's own name, e.g. "Z-SOFT". */
  name: string;
  /** The logo URL, already vetted as something a browser may load. "" when none. */
  logo: string;
  /** The site's canonical hostname, for the link's label. */
  host: string;
  /** Absolute URL of the site's front page — the way back out of the admin. */
  portalUrl: string;
}

/**
 * The host this request arrived on, without its port.
 *
 * `x-forwarded-host` first: in every deployment the admin sits behind a proxy, and
 * `host` there is the internal service address. A proxy chain may leave a list;
 * the first entry is the one the browser typed.
 */
async function requestHost(): Promise<{ host: string; secure: boolean }> {
  const h = await headers();
  const raw = h.get("x-forwarded-host") ?? h.get("host") ?? "";
  const host = (raw.split(",")[0] ?? "").trim().toLowerCase();
  const proto = (h.get("x-forwarded-proto") ?? "").split(",")[0]?.trim();

  return {
    host: host.split(":")[0] ?? "",
    // No forwarded scheme means nobody is proxying us, which in practice means a
    // developer on localhost. Guessing https there would produce a link that only
    // fails once clicked.
    secure: proto ? proto === "https" : !isLocal(host),
  };
}

function isLocal(host: string): boolean {
  const name = host.split(":")[0] ?? "";
  return name === "localhost" || name === "127.0.0.1" || name === "[::1]" || name.endsWith(".local");
}

/**
 * A logo URL is a value out of a JSON column, written by whoever ran the site — so
 * it is treated as untrusted input, not as markup we authored. Absolute http(s) or
 * a path on this origin; anything else (`javascript:`, `data:`, a stray filename)
 * resolves to no logo at all, and the Z-CMS mark shows instead.
 */
function safeLogo(url: string): string {
  const value = url.trim();
  if (!value) return "";
  if (value.startsWith("/") && !value.startsWith("//")) return value;
  try {
    const { protocol } = new URL(value);
    return protocol === "https:" || protocol === "http:" ? value : "";
  } catch {
    return "";
  }
}

/**
 * Memoised per request: the sign-in page reads this twice — once for the metadata,
 * once for the body — and one page view should be one lookup.
 */
export const siteBranding = cache(async (): Promise<SiteBranding | null> => {
  const { host, secure } = await requestHost();
  if (!host) return null;

  try {
    const dto = await apiFetch<SiteBrandingDto>("/public/sites/branding", {
      query: { hostname: host },
      anonymous: true,
      siteScoped: false,
    });

    return {
      siteId: dto.siteId,
      name: dto.name,
      logo: safeLogo(dto.brand.logo),
      host: dto.host,
      // The site answers at its registered hostname, which is not necessarily the
      // one this request came in on (www vs apex), so the link is built from what
      // the API resolved rather than from the address bar.
      portalUrl: `${secure ? "https" : "http"}://${dto.host}`,
    };
  } catch {
    // 404 for a hostname no site is registered under is the ordinary case on the
    // dedicated admin domain, not an error worth surfacing. Neither is an API
    // outage: the login form still works, it just looks like plain Z-CMS.
    return null;
  }
});
