import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { ensureThemeAssets, type ThemeOrigin } from "@/lib/theme-loader";

/**
 * Serves a theme's own assets (its compiled CSS, its images) out of the verified
 * bundle cache.
 *
 * Why a theme ships its own CSS at all: site-runtime's Tailwind build scans
 * site-runtime's source. A theme installed after that build is invisible to it,
 * so its classes would simply not exist in the stylesheet — the page would render
 * with correct markup and no styling. A theme therefore compiles its own CSS at
 * pack time and ships it inside the signed package.
 *
 * The route is NOT under `_theme`: a folder whose name starts with an underscore
 * is a *private folder* in the App Router and is excluded from routing entirely.
 * That produced a 404 for every stylesheet while the theme itself loaded fine —
 * correct markup, no styling, and nothing in the logs to explain it.
 *
 * This route reads from disk on request, so it is a file-serving endpoint with a
 * user-controlled path, which is to say it is a path-traversal bug waiting to
 * happen. The defences, in order:
 *
 *   - only an allowlist of extensions is served at all (never .js: a theme's
 *     code is imported by the runtime, never handed to a browser);
 *   - the resolved path must still be inside the bundle directory;
 *   - the bundle directory must exist and be marked verified.
 */

const ALLOWED_EXT = new Set([
  ".css",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".svg",
  ".woff2",
  // A theme owns its favicon, and a favicon is still an .ico for the browsers
  // that ask for one by that name.
  ".ico",
]);

const CONTENT_TYPE: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
};

function cacheRoot(): string {
  return process.env.THEME_CACHE_DIR ?? path.join(process.cwd(), ".zcms-themes");
}

export async function GET(
  request: Request,
  context: { params: Promise<{ path: string[] }> },
) {
  const { path: segments } = await context.params;

  // /theme-assets/<key>/<version>/<file...>
  const [key, version, ...rest] = segments;
  if (!key || !version || rest.length === 0) {
    return new NextResponse("Not found", { status: 404 });
  }

  const ext = path.extname(rest[rest.length - 1] ?? "").toLowerCase();
  if (!ALLOWED_EXT.has(ext)) {
    return new NextResponse("Not found", { status: 404 });
  }

  // Same sanitisation the loader uses when it writes the directory, so the two
  // agree on where a bundle lives.
  const safe = (s: string) => s.replace(/[^a-zA-Z0-9._-]/g, "_");
  const dir = path.join(cacheRoot(), "theme", safe(key), safe(version));

  if (!fs.existsSync(path.join(dir, ".zcms-verified"))) {
    const search = new URL(request.url).searchParams;
    const requestedOrigin = search.get("origin");
    const origin: ThemeOrigin | undefined =
      requestedOrigin === "BUILTIN" ||
      requestedOrigin === "MARKETPLACE" ||
      requestedOrigin === "SIDELOAD"
        ? requestedOrigin
        : undefined;

    try {
      await ensureThemeAssets(key, version, origin, search.get("checksum") ?? undefined);
    } catch {
      return new NextResponse("Not found", { status: 404 });
    }
  }

  if (!fs.existsSync(path.join(dir, ".zcms-verified"))) {
    return new NextResponse("Not found", { status: 404 });
  }

  const root = fs.realpathSync(dir);
  const target = path.resolve(root, ...rest);

  // First check: `path.resolve` has collapsed any "..", so a target outside the
  // bundle root means the request was trying to walk out of it by name.
  if (!target.startsWith(root + path.sep) || !fs.existsSync(target)) {
    return new NextResponse("Not found", { status: 404 });
  }

  // Second check, and the one the lexical check above cannot make: a symlink
  // that LIVES inside the bundle but POINTS outside it has a resolved-by-name
  // path that is inside root, yet reading it follows the link and serves the
  // outside file's bytes. Re-resolve the target through the filesystem and
  // require the real path to still be inside the (already-real) root. The
  // packing layer refuses to include links at all, so a link here means the
  // cache was tampered with — refuse, do not serve.
  let realTarget: string;
  try {
    realTarget = fs.realpathSync(target);
  } catch {
    return new NextResponse("Not found", { status: 404 });
  }
  if (realTarget !== root && !realTarget.startsWith(root + path.sep)) {
    return new NextResponse("Not found", { status: 404 });
  }

  const body = fs.readFileSync(realTarget);

  return new NextResponse(new Uint8Array(body), {
    headers: {
      "content-type": CONTENT_TYPE[ext] ?? "application/octet-stream",
      // A theme version is immutable — its bytes can never change under this
      // URL, because republishing a version is refused by the API.
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
}
