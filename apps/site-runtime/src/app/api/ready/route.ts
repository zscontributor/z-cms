import type { RenderPayload } from "@zcmsorg/schemas";
import { CMS_API_URL, CMS_INTERNAL_TOKEN } from "@/lib/env";
import { resolveTheme } from "@/lib/theme-registry";

export const dynamic = "force-dynamic";

const unavailable = () =>
  Response.json(
    { status: "unavailable", service: "site-runtime" },
    { status: 503 },
  );

/**
 * Deployment readiness, deliberately stronger than liveness.
 *
 * A plain GET / only proves that Next can return a response for "localhost".
 * Production renders a tenant hostname, resolves it through cms-api, downloads
 * the active signed theme into the container's private tmpfs, verifies it, and
 * imports it. A new task must finish that cold path before Swarm removes the old
 * one, otherwise the first visitor becomes the pre-warm request and can hit the
 * proxy's 30-second timeout.
 */
export async function GET(): Promise<Response> {
  const hostname = (process.env.READINESS_HOST ?? "").trim().toLowerCase();
  if (!hostname) return unavailable();

  try {
    const url = new URL(`${CMS_API_URL()}/api/v1/render/resolve`);
    url.searchParams.set("hostname", hostname);
    url.searchParams.set("path", "/");
    url.searchParams.set("page", "1");

    // No Next/Redis cache shortcut here: readiness must prove that this task can
    // reach the live API and that the API can resolve the production tenant.
    const response = await fetch(url, {
      cache: "no-store",
      headers: {
        "X-Internal-Token": CMS_INTERNAL_TOKEN(),
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return unavailable();

    const payload = (await response.json()) as RenderPayload;
    const loaded = await resolveTheme(
      payload.theme.key,
      payload.theme.version,
      payload.theme.origin,
    );

    // Falling back keeps a visitor-facing request alive, but it is not readiness:
    // the task still cannot serve the theme the tenant selected.
    if (loaded.degraded) return unavailable();

    return Response.json({ status: "ok", service: "site-runtime" });
  } catch (error) {
    console.error("[readiness] Failed to pre-warm the production tenant.", error);
    return unavailable();
  }
}
