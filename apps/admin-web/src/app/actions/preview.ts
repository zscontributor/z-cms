"use server";

import type { CollectionQuery, ContentDto } from "@zcmsorg/schemas";
import { can, getSession, previewCollections } from "@/lib/api";

/**
 * Real rows for the Theme Editor's canvas.
 *
 * A server action, not a client fetch: the cms-api preview route is site-scoped and
 * authenticated by the session cookie the browser cannot forward to another origin.
 * Re-checks `theme:author` (a server action is a public endpoint) and swallows every
 * failure to `{}` — the canvas falls back to sample rows, so a slow or missing list
 * never breaks the design surface.
 */
export async function previewCollectionsAction(
  locale: string,
  queries: CollectionQuery[],
): Promise<Record<string, ContentDto[]>> {
  if (queries.length === 0) return {};
  const user = await getSession();
  if (!user || !can(user, "theme:author")) return {};
  try {
    return await previewCollections({ locale, queries });
  } catch {
    return {};
  }
}
