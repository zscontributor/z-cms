import { copyFileSync, cpSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Copies this theme's own assets — its logo, its icons — into site-runtime's
 * `public/`, so that a theme which is *compiled into* the runtime can still serve
 * files the way an installed one does.
 *
 * Every other theme is a signed package: the runtime downloads it, verifies it,
 * unpacks it, and serves its files out of that directory. The default theme is
 * the one that cannot work that way, because it is the fallback for everything
 * that can go wrong with a downloaded theme — a bad signature, an unreachable
 * marketplace — and so it must not itself depend on any of that machinery. It
 * ships inside the runtime instead, and its assets have to ship with it.
 *
 * `BUILT_IN_ASSET_ROOT` in site-runtime's theme-loader is the URL these are served
 * at. The two have to agree. The prefix is deliberately odd for the same reason
 * `z-flags` is: it is a path on every tenant's site, and it must not be able to
 * collide with a page a tenant slugged "brand" or "assets".
 *
 * The copy is gitignored, exactly like the flags — the theme's `assets/` is the
 * source of truth, and a generated directory that is also committed is a directory
 * that will eventually disagree with its source.
 *
 * This task is marked `cache: false` (themes/default/turbo.json) because it writes
 * OUTSIDE its own package. Turbo caches a task by restoring its declared outputs,
 * and it can only restore paths within the package that produced them — so a cache
 * hit here would "succeed" while copying nothing, and a fresh checkout would build
 * a runtime whose every icon 404s. It is a file copy; running it every time is
 * cheaper than the failure mode of not running it.
 */

const REPO = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");

const THEME_KEY = "vn.zsoft.theme.default";
const SOURCE = join(REPO, "themes", "default", "assets");

// Mirrors the bundle layout: a packaged theme's manifest names "assets/logo.png"
// relative to its package root, so the built-in copy keeps the "assets" segment
// and the very same manifest path resolves under either base.
const DESTINATION = join(
  REPO,
  "apps",
  "site-runtime",
  "public",
  "z-theme-assets",
  THEME_KEY,
  "assets",
);

// Replaced wholesale rather than merged: an asset the theme *removes* must stop
// being served, not linger from an older build.
rmSync(DESTINATION, { recursive: true, force: true });
mkdirSync(DESTINATION, { recursive: true });
cpSync(SOURCE, DESTINATION, { recursive: true });

/**
 * And the same icon again at the site root.
 *
 * Every page already carries a <link rel="icon">, so no browser NEEDS this. But a
 * browser asks for /favicon.ico anyway — before it has parsed any HTML, and for
 * bookmarks, history entries and RSS readers that never parse it at all — and so
 * do crawlers. Without a file here that is a 404 on every site on the platform,
 * logged forever, for a request nobody sent on purpose.
 *
 * It is the platform's icon, not a tenant's: a tenant's own favicon reaches the
 * browser through the <link>, which wins over this. This is only what answers a
 * request made before anyone knew whose site it was.
 */
const PUBLIC = join(REPO, "apps", "site-runtime", "public");
copyFileSync(join(SOURCE, "favicon.ico"), join(PUBLIC, "favicon.ico"));

console.log(`Synced ${THEME_KEY} assets -> ${DESTINATION.replace(`${REPO}/`, "")}`);
console.log(`Synced ${THEME_KEY} favicon -> apps/site-runtime/public/favicon.ico`);
