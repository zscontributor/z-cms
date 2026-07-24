import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { CMS_INTERNAL_TOKEN } from "@/lib/env";
import { forgetTheme } from "@/lib/theme-loader";

/**
 * The kill switch, as seen from the runtime.
 *
 * Marking a version REJECTED stops new downloads — and does nothing at all to a
 * runtime that already has the bundle on disk and the module in memory. It would
 * keep serving the pulled theme until the process restarted, which for a
 * long-lived server could be weeks. That is not a kill switch; it is a note.
 *
 * So cms-api calls here. This drops the in-memory module and deletes the verified
 * cache directory, and the next request re-resolves the theme — finding the API
 * now refuses to serve it, and falling back to the default.
 *
 * Trusting the API for THIS is safe, and worth being explicit about: the API can
 * only ever *remove* trust here. It cannot use this endpoint to make the runtime
 * load something — that still requires a signature it cannot forge.
 */
export async function POST(request: Request) {
  const expected = CMS_INTERNAL_TOKEN();
  const provided = request.headers.get("x-internal-token");

  if (!expected || provided !== expected) {
    return NextResponse.json({ message: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    key?: string;
    version?: string;
  };

  if (!body.key || !body.version) {
    return NextResponse.json({ message: "key and version are required" }, { status: 400 });
  }

  forgetTheme(body.key, body.version);

  // The verified-cache marker is what lets a bundle be reused without a fresh
  // signature check. Removing the directory is what makes the next load a real
  // load — and therefore a refused one.
  const safe = (s: string) => s.replace(/[^a-zA-Z0-9._-]/g, "_");
  const root = process.env.THEME_CACHE_DIR ?? path.join(process.cwd(), ".zcms-themes");
  const dir = path.join(root, "theme", safe(body.key), safe(body.version));

  let removed = false;
  try {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
      removed = true;
    }
  } catch (err) {
    // A cache we failed to delete is a cache that may still be served. Loud.
    console.error(
      `[purge] Could not delete the cached bundle for ${body.key}@${body.version}: ${(err as Error).message}`,
    );
    return NextResponse.json(
      { message: "Cache directory could not be removed" },
      { status: 500 },
    );
  }

  console.warn(`[purge] ${body.key}@${body.version} revoked — cache dropped (disk: ${removed})`);

  return NextResponse.json({ purged: true, diskCacheRemoved: removed });
}
