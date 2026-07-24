import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { CMS_API_URL, CMS_INTERNAL_TOKEN } from "@/lib/env";

export interface IntegrationActionRouteContext {
  params: Promise<{ capability: string; action: string }>;
}

/** Same-origin public gateway with an explicit allow-list; never an open proxy. */
export async function postIntegrationAction(
  request: Request,
  context: IntegrationActionRouteContext,
) {
  const { capability, action } = await context.params;
  if (capability !== "ai.assistant" || action !== "chat") {
    return NextResponse.json({ message: "Integration action not found." }, { status: 404 });
  }

  const incoming = await headers();
  const hostname = (incoming.get("x-forwarded-host") ?? incoming.get("host") ?? "")
    .trim()
    .toLowerCase();
  if (!hostname) return NextResponse.json({ message: "Missing hostname." }, { status: 400 });

  const url = new URL(
    `${CMS_API_URL()}/api/v1/integrations/${encodeURIComponent(capability)}/actions/${encodeURIComponent(action)}`,
  );
  url.searchParams.set("hostname", hostname);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Internal-Token": CMS_INTERNAL_TOKEN(),
        ...(incoming.get("x-forwarded-for")
          ? { "x-forwarded-for": incoming.get("x-forwarded-for")! }
          : {}),
      },
      body: await request.text(),
      cache: "no-store",
    });
    return new NextResponse(await response.text(), {
      status: response.status,
      headers: { "content-type": "application/json" },
    });
  } catch {
    return NextResponse.json({ message: "Integration is unavailable." }, { status: 502 });
  }
}
