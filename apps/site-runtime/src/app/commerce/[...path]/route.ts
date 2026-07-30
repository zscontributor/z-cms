import {
  getCommerce,
  postCommerce,
  type CommerceRouteContext,
} from "@/lib/commerce-gateway";

/**
 * The public storefront gateway, served at `/commerce/*` — deliberately NOT under
 * `/api/*`. An ingress in front of the cluster only needs to route cms-api's own
 * prefix, `/api/v1`; a rule that claims all of `/api` on every tenant subdomain
 * instead hands site-runtime's own routes to cms-api, which 404s on paths it never
 * had. That is not hypothetical — the Traefik router `zcms-api` did exactly that,
 * and it is why `/api/forms/<id>/submit` returned 404 on a tenant subdomain while
 * the same theme worked on a custom domain (which falls through to the catch-all).
 * A gateway mounted off `/api` cannot be caught by that class of mistake. This
 * mirrors the AI assistant, whose public path is `/integrations/*`, also off `/api`.
 */
export function POST(request: Request, context: CommerceRouteContext) {
  return postCommerce(request, context);
}

export function GET(request: Request, context: CommerceRouteContext) {
  return getCommerce(request, context);
}
