import {
  getCommerce,
  postCommerce,
  type CommerceRouteContext,
} from "@/lib/commerce-gateway";

export function POST(request: Request, context: CommerceRouteContext) {
  return postCommerce(request, context);
}

export function GET(request: Request, context: CommerceRouteContext) {
  return getCommerce(request, context);
}
