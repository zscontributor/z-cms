import { NextResponse, type NextRequest } from "next/server";
import { ApiError, getPluginReferenceOptions, getSession } from "@/lib/api";
import { getT } from "@/lib/locale";

/**
 * The choices behind a `reference` field, for the picker in the browser.
 *
 * Every other plugin-admin screen reads cms-api from a server component or a
 * server action, so none of them needed a route handler. The picker is the one
 * that cannot: it searches as the visitor types, which is a fetch FROM the
 * browser — and the browser has no cms-api token. The access token is an httpOnly
 * cookie on this origin, so the browser calls this handler and the handler calls
 * the API. The token never leaves the server, exactly as `/api/media` does it for
 * the media dialog.
 *
 * Its absence is why "Staff member" on a shift was empty: the client asked
 * `/api/plugin-admin/…/options/staff_id`, nothing in the admin served that path,
 * and Next answered 404 — which the picker rendered as "no matches", because an
 * empty list and a missing endpoint look identical from inside a dropdown.
 *
 * No permission is checked here beyond having a session. That is deliberate: the
 * real gate is the READ permission of the table being referenced, which only
 * cms-api can evaluate (it is a permission the *plugin* invented). Re-deciding it
 * here would be a second, weaker copy of a rule that already exists — so this
 * forwards the status the API returned, 403 included.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ plugin: string; resource: string; column: string }> },
) {
  const t = await getT();

  const user = await getSession();
  if (!user) {
    return NextResponse.json({ message: t("auth.session.required") }, { status: 401 });
  }

  const { plugin, resource, column } = await params;
  const search = request.nextUrl.searchParams;
  // Bounded before it is forwarded — cms-api caps these too, but a handler that
  // passes a megabyte of query string along has already done the work.
  const q = search.get("q")?.slice(0, 200) ?? undefined;
  const value = search.get("value")?.slice(0, 200) ?? undefined;

  try {
    const result = await getPluginReferenceOptions(plugin, resource, column, { q, value });
    return NextResponse.json(result);
  } catch (error) {
    const status = error instanceof ApiError ? error.status : 500;
    // The picker distinguishes 403 ("you may not see this list") from an empty
    // result, so the status has to survive the hop rather than collapsing to 500.
    const message = error instanceof ApiError ? error.message : t("common.actionFailed");
    return NextResponse.json({ message, options: [] }, { status });
  }
}
