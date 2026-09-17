import type { SiteMaintenanceStateDto } from "@zcmsorg/schemas";
import { CMS_API_URL, CMS_INTERNAL_TOKEN } from "./env";

/**
 * Maintenance mode, as the middleware sees it.
 *
 * The public site is closed from the FRONT door, in middleware, rather than by
 * the page: a page component cannot set a status code, and the status is the
 * point. A maintenance notice served as a 200 is a page search engines index
 * and — with `noindex` — one they use to drop the real pages; served as a 503
 * with `Retry-After`, it is an outage they wait out, keeping every page they
 * already know. So the middleware asks cms-api whether this hostname is closed
 * before any page is rendered, and answers the 503 itself.
 *
 * That question is asked before EVERY page, which is why its answer is memoised
 * here for a few seconds per hostname: after the first request the gate costs a
 * Map lookup, and cms-api sees one request per hostname per `MEMO_TTL_MS` per
 * process. Flipping the switch in the admin therefore takes effect within that
 * many seconds, which the admin says out loud. The memo lives on `globalThis`
 * so the cache-purge hook (`/api/revalidate`) can drop it early where the two
 * share a process; where they do not (the edge sandbox) the TTL is the bound.
 *
 * Fail open, deliberately. If cms-api cannot answer, the request goes on to the
 * page, which will draw its own error if the API really is down — a gate that
 * failed closed would turn every API blip into a site-wide "we'll be back".
 */

/** The cookie that lets an owner see the real site while it is closed. */
export const MAINTENANCE_BYPASS_COOKIE = "zc_maintenance_bypass";
/** `?zc-bypass=<key>` sets the cookie (and an empty value clears it). */
export const MAINTENANCE_BYPASS_PARAM = "zc-bypass";
/** `?zc-maintenance-preview=<key>` draws the notice even while the site is open. */
export const MAINTENANCE_PREVIEW_PARAM = "zc-maintenance-preview";
/** What a bypass key may look like; anything else is ignored, never stored. */
export const BYPASS_KEY_RE = /^[A-Za-z0-9_-]{8,128}$/;

/** How long one hostname's answer is trusted before cms-api is asked again. */
export const MEMO_TTL_MS = 10_000;
/** cms-api is on the same network; anything slower than this is "down" for the gate. */
const FETCH_TIMEOUT_MS = 1_500;

interface MemoEntry {
  until: number;
  state: SiteMaintenanceStateDto | null;
}

const MEMO_KEY = Symbol.for("zcms.site-runtime.maintenance-memo");

function memo(): Map<string, MemoEntry> {
  const holder = globalThis as unknown as Record<symbol, Map<string, MemoEntry> | undefined>;
  return (holder[MEMO_KEY] ??= new Map());
}

/**
 * The maintenance state of a hostname — `null` when the hostname resolves to no
 * published site (the page's own 404 handles that) or cms-api could not answer.
 */
export async function maintenanceStateFor(
  hostname: string,
  now = Date.now(),
): Promise<SiteMaintenanceStateDto | null> {
  const key = hostname.trim().toLowerCase();
  if (!key) return null;

  const cached = memo().get(key);
  if (cached && cached.until > now) return cached.state;

  const state = await fetchMaintenanceState(key);
  memo().set(key, { until: now + MEMO_TTL_MS, state });
  return state;
}

/** Drops the memoised answer for a hostname, or for every hostname. */
export function forgetMaintenanceState(hostname?: string): void {
  if (hostname === undefined) memo().clear();
  else memo().delete(hostname.trim().toLowerCase());
}

async function fetchMaintenanceState(hostname: string): Promise<SiteMaintenanceStateDto | null> {
  const url = new URL(`${CMS_API_URL()}/api/v1/render/maintenance`);
  url.searchParams.set("hostname", hostname);

  // AbortController rather than AbortSignal.timeout: this runs in the edge
  // runtime, where the static helper is not guaranteed.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { "X-Internal-Token": CMS_INTERNAL_TOKEN(), Accept: "application/json" },
      signal: controller.signal,
      // Plain fetch: this is the middleware's own memo above, not Next's data
      // cache, that bounds how often cms-api is asked.
      cache: "no-store",
    });
    if (response.status === 404) return null;
    if (!response.ok) {
      console.warn(`[maintenance] render/maintenance answered ${response.status} for ${hostname}; serving the site.`);
      return null;
    }
    return (await response.json()) as SiteMaintenanceStateDto;
  } catch (error) {
    console.warn(`[maintenance] Could not ask cms-api about ${hostname}; serving the site.`, error);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Whether a request should see the notice, given what the visitor presented.
 *
 *   - `closed`: the site is in maintenance and this visitor holds no valid bypass —
 *     a 503, the real thing.
 *   - `preview`: the site is OPEN but the owner asked to see the notice by
 *     presenting the key in the URL — a 200, so a mis-shared preview link never
 *     reads as an outage to a crawler.
 *   - `null`: serve the site.
 *
 * A bypass only exists once the owner has generated a key: with none set there is
 * nothing to compare against and no cookie value, however clever, gets through.
 */
export function maintenanceVerdict(
  state: SiteMaintenanceStateDto | null,
  presented: { cookie: string | undefined; previewParam: string | null },
): "closed" | "preview" | null {
  if (!state) return null;
  const hasKey = BYPASS_KEY_RE.test(state.bypassKey);

  if (state.enabled) {
    const bypassed = hasKey && presented.cookie === state.bypassKey;
    return bypassed ? null : "closed";
  }

  if (hasKey && presented.previewParam === state.bypassKey) return "preview";
  return null;
}

/**
 * `Retry-After`, in seconds: until the owner's expected time when it is set and
 * still ahead, otherwise an hour. Clamped so a typo'd date years out does not
 * tell crawlers to stay away for a decade.
 */
export function retryAfterSeconds(state: SiteMaintenanceStateDto, now = Date.now()): number {
  const fallback = 3600;
  if (!state.expectedBackAt) return fallback;
  const at = Date.parse(state.expectedBackAt);
  if (Number.isNaN(at) || at <= now) return fallback;
  return Math.min(Math.ceil((at - now) / 1000), 24 * 3600);
}

/**
 * Which language to draw the notice in: the URL's locale prefix when the site
 * publishes in it, else the site's default. The same rule cms-api's router uses,
 * applied to the only two facts the middleware has — the path and the site.
 */
export function maintenanceLocaleFor(
  pathname: string,
  site: { locales: string[]; defaultLocale: string },
): string {
  const first = pathname.split("/").filter(Boolean)[0]?.toLowerCase();
  if (first && site.locales.includes(first)) return first;
  return site.defaultLocale;
}
