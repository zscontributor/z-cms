import {
  getCommerce,
  postCommerce,
  type CommerceRouteContext,
} from "@/lib/commerce-gateway";

/**
 * The public storefront gateway, served at `/commerce/*` — deliberately NOT under
 * `/api/*`. On a deployed cluster the ingress reserves `/api` on every tenant
 * subdomain for cms-api (Traefik router `zcms-api`, PathPrefix `/api`), so a route
 * mounted at `/api/commerce/*` never reaches site-runtime — the request is handed
 * straight to cms-api, which serves its own routes under `/api/v1` and 404s. This
 * mirrors the AI assistant, whose public path is `/integrations/*`, also off `/api`.
 */
export function POST(request: Request, context: CommerceRouteContext) {
  return postCommerce(request, context);
}

export function GET(request: Request, context: CommerceRouteContext) {
  return getCommerce(request, context);
}
