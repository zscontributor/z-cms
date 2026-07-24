import {
  postIntegrationAction,
  type IntegrationActionRouteContext,
} from "@/lib/integration-action-gateway";

export function POST(request: Request, context: IntegrationActionRouteContext) {
  return postIntegrationAction(request, context);
}
