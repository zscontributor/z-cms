import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { CMS_API_URL, CMS_INTERNAL_TOKEN } from "@/lib/env";

/**
 * The public plugin-query gateway, served at `/plugin-query/*` — deliberately NOT
 * under `/api/*` (same reasoning as `/commerce/*`): a reverse proxy in front of the
 * cluster only has to route cms-api's own prefix, `/api/v1`, and a gateway outside
 * `/api` cannot be swallowed by a proxy rule that claims more than that. It has
 * happened: an ingress `PathPrefix(/api)` sent `/api/forms/<id>/submit` to cms-api,
 * which has no such route, and every public form 404'd. A runtime widget fetches
 * here same-origin with the filter in the
 * query string; we forward it to cms-api's `/plugin-query/:capability` with the
 * internal token (the browser never sees it), and cms-api resolves the site from
 * `hostname`, dispatches the filter to the plugin that provides the capability, and
 * returns `{ items }`. Read-only; a failure degrades to an empty list, never an error
 * page — a filter that cannot answer must not take the storefront down.
 */
interface RouteContext {
  params: Promise<{ capability: string }>;
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const { capability } = await context.params;
  const incoming = await headers();
  const hostname = (incoming.get("x-forwarded-host") ?? incoming.get("host") ?? "")
    .split(",")[0]!
    .trim()
    .toLowerCase();

  if (!hostname || !capability) {
    return NextResponse.json({ items: [] }, { status: 400 });
  }

  const url = new URL(`${CMS_API_URL()}/api/v1/plugin-query/${encodeURIComponent(capability)}`);
  url.searchParams.set("hostname", hostname);
  for (const [key, value] of new URL(request.url).searchParams) {
    if (key !== "hostname") url.searchParams.append(key, value);
  }

  try {
    const response = await fetch(url, {
      headers: {
        "X-Internal-Token": CMS_INTERNAL_TOKEN(),
        ...(incoming.get("x-forwarded-for")
          ? { "x-forwarded-for": incoming.get("x-forwarded-for")! }
          : {}),
      },
      cache: "no-store",
    });
    if (!response.ok) {
      return NextResponse.json({ items: [] }, { status: response.status });
    }
    const data = (await response.json()) as { items?: unknown[] };
    return NextResponse.json({ items: Array.isArray(data.items) ? data.items : [] }, { status: 200 });
  } catch {
    return NextResponse.json({ items: [] }, { status: 502 });
  }
}
