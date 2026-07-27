import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { CMS_API_URL, CMS_INTERNAL_TOKEN } from "@/lib/env";

/**
 * The generic public-form submit target — the plugin-form counterpart of
 * `/api/contact/submit`.
 *
 * A visitor's browser posts here same-origin; we forward the fields to cms-api's
 * `/forms/:formId/submit` with the internal token (the browser never sees it), and
 * cms-api resolves the form from the site's installed plugin manifests, validates
 * the values against the form's declared fields, and dispatches them to the
 * plugin's handler. Two response shapes, one handler: JSON `{ ok }` when the client
 * asked for it (the enhanced path — no navigation, keep-on-error), otherwise a 303
 * back to the page with a `#<formId>-sent` / `#<formId>-error` fragment the
 * reveal-on-target primitive shows (the no-JS fallback).
 */
interface RouteContext {
  params: Promise<{ formId: string }>;
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const { formId } = await context.params;
  const incoming = await headers();
  const wantsJson = (incoming.get("accept") ?? "").includes("application/json");
  const proto = (incoming.get("x-forwarded-proto") ?? "https").split(",")[0]!.trim();
  const hostname = (incoming.get("x-forwarded-host") ?? incoming.get("host") ?? "")
    .split(",")[0]!
    .trim()
    .toLowerCase();

  const back = safeReturn(incoming.get("referer"), proto, hostname);
  const done = (ok: boolean): Response =>
    wantsJson
      ? NextResponse.json({ ok }, { status: 200 })
      : NextResponse.redirect(`${back}#${encodeURIComponent(formId)}-${ok ? "sent" : "error"}`, 303);

  if (!hostname || !formId) return done(false);

  let payload: Record<string, string>;
  try {
    const form = await request.formData();
    payload = {};
    for (const [key, value] of form.entries()) {
      if (typeof value === "string") payload[key] = value.trim();
    }
  } catch {
    return done(false);
  }

  try {
    const url = new URL(`${CMS_API_URL()}/api/v1/forms/${encodeURIComponent(formId)}/submit`);
    url.searchParams.set("hostname", hostname);
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Internal-Token": CMS_INTERNAL_TOKEN(),
        ...(incoming.get("x-forwarded-for")
          ? { "x-forwarded-for": incoming.get("x-forwarded-for")! }
          : {}),
      },
      body: JSON.stringify(payload),
      cache: "no-store",
    });
    // cms-api returns { ok } with 200 for a handled rejection, non-2xx for a real
    // failure; either way `response.ok && body.ok` is the answer.
    let ok = response.ok;
    if (ok) {
      try {
        const data = (await response.json()) as { ok?: boolean };
        ok = data.ok !== false;
      } catch {
        /* keep response.ok */
      }
    }
    return done(ok);
  } catch {
    return done(false);
  }
}

/** Same-origin return target only; never an open redirect. Query/hash dropped. */
function safeReturn(referer: string | null, proto: string, hostname: string): string {
  const fallback = `${proto}://${hostname || "localhost"}/`;
  if (!referer) return fallback;
  try {
    const url = new URL(referer);
    if (url.hostname.toLowerCase() !== hostname) return fallback;
    return `${url.origin}${url.pathname}`;
  } catch {
    return fallback;
  }
}
