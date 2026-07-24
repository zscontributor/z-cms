import { revalidateTag } from "next/cache";
import { NextResponse } from "next/server";
import { CMS_INTERNAL_TOKEN } from "@/lib/env";
import { pageTag, siteTag } from "@/lib/cache-tags";

/**
 * Cache purge hook: how publishing in the admin becomes visible on the site.
 *
 * cms-api POSTs here after a publish/unpublish/menu/theme-settings change with
 * the hostnames and paths it touched, and the matching tags are dropped — so a
 * page goes live in the time of one HTTP call rather than at the end of its 60s
 * TTL. The tags are computed from the same helpers the renderer tags its fetch
 * with, so the two can never drift apart.
 *
 *   POST /api/revalidate
 *   X-Internal-Token: <CMS_INTERNAL_TOKEN>
 *   { "hostname": "localhost:3000", "paths": ["/", "/blog/hello"] }
 *
 * Omitting `paths` purges the whole site (menus, theme settings, anything that
 * appears in the chrome of every page). Raw `tags` are accepted for the cases the
 * API knows a tag we have not thought of yet.
 */

interface RevalidateBody {
  hostname?: string;
  /** Single path, or many. Both spellings accepted — the API may send either. */
  path?: string;
  paths?: string[];
  tags?: string[];
}

export async function POST(request: Request) {
  const token = CMS_INTERNAL_TOKEN();
  const provided =
    request.headers.get("x-internal-token") ??
    request.headers.get("X-Internal-Token");

  // No token configured means no one may purge: an open cache-purge endpoint is
  // a denial-of-service lever against the origin.
  if (!token || provided !== token) {
    return NextResponse.json({ message: "Unauthorized" }, { status: 401 });
  }

  let body: RevalidateBody;
  try {
    body = (await request.json()) as RevalidateBody;
  } catch {
    return NextResponse.json({ message: "Invalid JSON body" }, { status: 400 });
  }

  const tags = new Set<string>(body.tags ?? []);

  if (body.hostname) {
    const paths = [
      ...(body.path ? [body.path] : []),
      ...(Array.isArray(body.paths) ? body.paths : []),
    ];

    if (paths.length === 0) {
      tags.add(siteTag(body.hostname));
    } else {
      for (const path of paths) {
        tags.add(pageTag(body.hostname, path));
      }
    }
  }

  if (tags.size === 0) {
    return NextResponse.json(
      { message: "Nothing to revalidate: pass `hostname` (with optional `paths`) or `tags`." },
      { status: 400 },
    );
  }

  for (const tag of tags) {
    // Next 16 requires a cache profile. `expire: 0` means the tag is dead on
    // arrival rather than stale-while-revalidate: an editor who hits Publish and
    // reloads must see the new page, not the old one plus a promise.
    revalidateTag(tag, { expire: 0 });
  }

  return NextResponse.json({ revalidated: [...tags], now: Date.now() });
}
