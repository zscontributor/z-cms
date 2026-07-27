import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { CMS_API_URL, CMS_INTERNAL_TOKEN } from "@/lib/env";

/**
 * The contact form's submit target.
 *
 * Two callers, one handler. A theme ships no client JS, so its form is a plain
 * HTML `POST` and this route answers with a 303 back to the page carrying a
 * `#contact-sent` / `#contact-error` fragment (the no-JS path). When the runtime's
 * progressive-enhancement script is present it sends the same POST with
 * `Accept: application/json` and this route answers `{ ok }` instead — so the
 * script can reveal the result without a navigation, keeping what the visitor
 * typed on error and clearing the form only on success.
 *
 * Either way the fields are forwarded to cms-api with the internal token (the
 * browser never sees that token or the API's address), and cms-api decides who the
 * mail goes to and validates it.
 */
export async function POST(request: Request): Promise<Response> {
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
      : redirectWith(back, ok ? "sent" : "error");

  if (!hostname) return done(false);

  let payload: Record<string, string>;
  try {
    const form = await request.formData();
    payload = {
      name: field(form.get("name")),
      company: field(form.get("company")),
      email: field(form.get("email")),
      need: field(form.get("need")),
      message: field(form.get("message")),
    };
  } catch {
    return done(false);
  }

  try {
    const url = new URL(`${CMS_API_URL()}/api/v1/contact/submit`);
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
    return done(response.ok);
  } catch {
    return done(false);
  }
}

/** A form value as a trimmed string; anything non-textual becomes "". */
function field(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Where to send the visitor after the POST — the page they submitted from, but
 * only if it is genuinely one of ours. A `referer` on another origin (or none) is
 * ignored in favour of the site root, so this route can never be turned into an
 * open redirect. Query and hash are dropped; we set our own fragment.
 */
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

/** 303 back to `base`, adding the fragment the theme's CSS keys its banner off. */
function redirectWith(base: string, status: "sent" | "error"): Response {
  return NextResponse.redirect(`${base}#contact-${status}`, 303);
}
