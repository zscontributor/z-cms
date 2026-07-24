import { NextResponse, type NextRequest } from "next/server";
import { ApiError, getSession, listMedia } from "@/lib/api";
import { getT } from "@/lib/locale";

/**
 * The media picker needs to page through the library from the client (inside a
 * dialog, without a navigation). Rather than expose the cms-api token to the
 * browser, the browser calls this handler and the handler calls the API with the
 * httpOnly cookie — the token never leaves the server.
 */
export async function GET(request: NextRequest) {
  const t = await getT();

  const user = await getSession();
  if (!user) {
    return NextResponse.json({ message: t("auth.session.required") }, { status: 401 });
  }
  if (!user.permissions.includes("media:read")) {
    return NextResponse.json({ message: t("media.denied") }, { status: 403 });
  }

  const params = request.nextUrl.searchParams;
  const page = Math.max(1, Number(params.get("page") ?? "1") || 1);
  const search = params.get("search")?.trim();
  // Absent = the whole library, which is what the picker wants: someone inserting
  // an image mid-sentence is looking for a file, not for a place in the filing.
  const folder = params.get("folder") ?? undefined;

  try {
    const result = await listMedia({ page, perPage: 24, search: search || undefined, folder });
    return NextResponse.json(result);
  } catch (error) {
    const status = error instanceof ApiError ? error.status : 500;
    const message = error instanceof ApiError ? error.message : t("media.picker.loadFailed");
    return NextResponse.json({ message }, { status });
  }
}
