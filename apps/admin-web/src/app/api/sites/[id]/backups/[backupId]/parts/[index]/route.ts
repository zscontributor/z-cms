import { NextResponse, type NextRequest } from "next/server";
import { ApiError, apiStream, getSession } from "@/lib/api";
import { getT } from "@/lib/locale";

/**
 * Hands a backup part to the browser.
 *
 * The browser cannot call cms-api itself — the token is an httpOnly cookie it
 * never sees — so a download link points here and this handler forwards the
 * bytes with the token attached. Forwarded, not buffered: the upstream body is
 * the response body, so a part of any size costs this process a few kilobytes.
 *
 * `Range` goes through in both directions, which is what lets a browser resume
 * a download that was cut off, and `Content-Disposition` is passed on so the
 * file lands on disk under the name the parts are meant to be joined by.
 */
export const dynamic = "force-dynamic";

const FORWARDED = [
  "content-type",
  "content-length",
  "content-range",
  "content-disposition",
  "accept-ranges",
  "x-part-sha256",
];

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; backupId: string; index: string }> },
) {
  const t = await getT();
  const { id, backupId, index } = await params;

  const user = await getSession();
  if (!user) {
    return NextResponse.json({ message: t("auth.session.required") }, { status: 401 });
  }
  if (!user.permissions.includes("site:update")) {
    return NextResponse.json({ message: t("admin.sites.errors.updateDenied") }, { status: 403 });
  }

  try {
    const upstream = await apiStream(
      `/sites/${encodeURIComponent(id)}/backups/${encodeURIComponent(backupId)}/parts/${encodeURIComponent(index)}`,
      { range: request.headers.get("range") ?? undefined, siteScoped: false },
    );
    const headers = new Headers();
    for (const name of FORWARDED) {
      const value = upstream.headers.get(name);
      if (value) headers.set(name, value);
    }
    headers.set("cache-control", "private, no-store");
    return new Response(upstream.body, { status: upstream.status, headers });
  } catch (error) {
    const status = error instanceof ApiError ? error.status : 500;
    const message = error instanceof ApiError ? error.message : t("admin.sites.backup.downloadFailed");
    return NextResponse.json({ message }, { status });
  }
}
