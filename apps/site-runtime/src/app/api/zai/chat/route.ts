import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { CMS_API_URL, CMS_INTERNAL_TOKEN } from "@/lib/env";

export async function POST(request: Request) {
  const incoming = await headers();
  const hostname = (incoming.get("x-forwarded-host") ?? incoming.get("host") ?? "")
    .trim()
    .toLowerCase();
  if (!hostname) return NextResponse.json({ message: "Missing hostname." }, { status: 400 });

  const body = await request.text();
  const url = new URL(`${CMS_API_URL()}/api/v1/ai/chat`);
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
      body,
      cache: "no-store",
    });
    return new NextResponse(await response.text(), {
      status: response.status,
      headers: { "content-type": "application/json" },
    });
  } catch {
    return NextResponse.json({ message: "AI service is unavailable." }, { status: 502 });
  }
}
