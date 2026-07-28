import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { getSystemDb } from "@zcmsorg/database";
import { t } from "../common/i18n";
import { PluginsService } from "../plugins/plugins.service";

/**
 * The read counterpart of the public forms endpoint.
 *
 * A theme renders a filter (a product grid, a store finder, a job board) but ships
 * no JavaScript and cannot query anything — so a runtime widget fetches this
 * endpoint with the filter, and it dispatches the filter to whichever plugin
 * provides the named capability, through the plugin's `calls["query"]` handler in
 * the sandbox. The plugin runs `ctx.db.select` against its own tables and returns
 * rows; nothing about which plugin answers, or its scopes, comes from the request.
 *
 * Only the fixed call `"query"` is ever invoked — a visitor cannot reach an
 * arbitrary plugin call — and only for a capability an active plugin actually
 * provides. It is read-only and rate-limited, the mirror of the forms write door.
 */

/** Reverse-dotted/hyphenated capability id, e.g. "catalog.search". */
const CAPABILITY_RE = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const MAX_PARAMS = 24;
const MAX_PARAM_LEN = 200;
const MAX_ARRAY = 50;

@Injectable()
export class PluginQueryService {
  constructor(private readonly plugins: PluginsService) {}

  async run(
    hostname: string,
    capability: string,
    rawParams: Record<string, unknown>,
  ): Promise<{ items: unknown[] }> {
    if (!hostname) throw new BadRequestException(t()("errors.query.hostnameRequired"));
    if (!CAPABILITY_RE.test(capability)) {
      throw new NotFoundException(t()("errors.query.invalidCapability"));
    }

    const domain = await getSystemDb().domain.findUnique({
      where: { hostname: hostname.toLowerCase() },
      include: { site: true },
    });
    if (!domain || domain.site.status !== "PUBLISHED") {
      throw new NotFoundException(t()("errors.query.siteNotFound"));
    }
    const site = domain.site;

    // Dispatch the filter to whichever ACTIVE plugin provides this capability, via
    // its `query` call in the sandbox. `callCapability` 404s when none does.
    const result = await this.plugins.callCapability(
      site.tenantId,
      site.id,
      capability,
      "query",
      { params: sanitizeParams(rawParams) },
    );

    return { items: normalizeItems(result) };
  }
}

/** Keep the params small and shallow — strings and string arrays only. */
function sanitizeParams(raw: Record<string, unknown>): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  let count = 0;
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (key === "hostname" || count >= MAX_PARAMS) continue;
    if (typeof value === "string") {
      out[key] = value.slice(0, MAX_PARAM_LEN);
      count += 1;
    } else if (Array.isArray(value)) {
      out[key] = value
        .filter((v): v is string => typeof v === "string")
        .slice(0, MAX_ARRAY)
        .map((v) => v.slice(0, MAX_PARAM_LEN));
      count += 1;
    }
  }
  return out;
}

/** A handler may return an array, or `{ items }`; anything else yields no rows. */
function normalizeItems(result: unknown): unknown[] {
  if (Array.isArray(result)) return result;
  if (result && typeof result === "object" && Array.isArray((result as { items?: unknown }).items)) {
    return (result as { items: unknown[] }).items;
  }
  return [];
}
