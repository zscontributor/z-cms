import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { CMS_API_URL, CMS_INTERNAL_TOKEN } from "@/lib/env";

export interface CommerceRouteContext {
  params: Promise<{ path?: string[] }>;
}

/**
 * Same-origin storefront gateway. The browser talks to `/commerce/*` (kept off
 * `/api/*`, which the cluster ingress routes to cms-api, not here); this
 * forwards to cms-api's public `commerce` controller with the render token and the
 * request's hostname, exactly as the AI action gateway does. Like that one, it is
 * an explicit allow-list, never an open proxy: only the three storefront endpoints
 * pass, and the shopper's session (there is none) never enters it.
 */
const POST_PATHS = new Set(["quote", "checkout"]);

function targetPath(segments: string[]): string | null {
  const joined = segments.join("/");
  if (POST_PATHS.has(joined)) return joined;
  // orders/<token> — one segment of opaque token, nothing deeper.
  if (segments.length === 2 && segments[0] === "orders" && /^[A-Za-z0-9_-]{1,128}$/.test(segments[1]!)) {
    return `orders/${segments[1]}`;
  }
  return null;
}

async function forward(
  method: "GET" | "POST",
  request: Request,
  context: CommerceRouteContext,
) {
  const { path = [] } = await context.params;
  const target = targetPath(path);
  if (!target) {
    return NextResponse.json({ message: "Not found." }, { status: 404 });
  }
  if (method === "POST" && !POST_PATHS.has(target)) {
    return NextResponse.json({ message: "Method not allowed." }, { status: 405 });
  }
  if (method === "GET" && POST_PATHS.has(target)) {
    return NextResponse.json({ message: "Method not allowed." }, { status: 405 });
  }

  const incoming = await headers();
  const hostname = (incoming.get("x-forwarded-host") ?? incoming.get("host") ?? "")
    .trim()
    .toLowerCase();
  if (!hostname) return NextResponse.json({ message: "Missing hostname." }, { status: 400 });

  const url = new URL(`${CMS_API_URL()}/api/v1/commerce/${target}`);
  url.searchParams.set("hostname", hostname);

  try {
    const response = await fetch(url, {
      method,
      headers: {
        "content-type": "application/json",
        "X-Internal-Token": CMS_INTERNAL_TOKEN(),
        ...(incoming.get("x-forwarded-for")
          ? { "x-forwarded-for": incoming.get("x-forwarded-for")! }
          : {}),
      },
      ...(method === "POST" ? { body: await request.text() } : {}),
      cache: "no-store",
    });
    return new NextResponse(await response.text(), {
      status: response.status,
      headers: { "content-type": "application/json" },
    });
  } catch {
    return NextResponse.json({ message: "The shop is unavailable." }, { status: 502 });
  }
}

export function postCommerce(request: Request, context: CommerceRouteContext) {
  return forward("POST", request, context);
}

export function getCommerce(request: Request, context: CommerceRouteContext) {
  return forward("GET", request, context);
}
