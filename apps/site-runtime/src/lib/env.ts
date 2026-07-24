/**
 * Server-only configuration. Read lazily (not at module scope) so a missing var
 * fails the request that needs it with a clear message, instead of crashing the
 * whole process at import time — a build must not need a live API.
 */

export const CMS_API_URL = (): string =>
  process.env.CMS_API_URL?.replace(/\/+$/, "") ?? "http://localhost:4100";

export const CMS_INTERNAL_TOKEN = (): string => process.env.CMS_INTERNAL_TOKEN ?? "";

/**
 * How long a rendered page may be served from cache without checking back.
 * Publishing does not wait for this: cms-api POSTs /api/revalidate to purge the
 * exact tags immediately. The TTL is only the safety net for a missed webhook.
 */
export const RENDER_REVALIDATE_SECONDS = 60;
