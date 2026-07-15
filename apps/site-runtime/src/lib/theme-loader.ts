import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Theme } from "@zcmsorg/theme-sdk";
import {
  ensureBuiltinBundle,
  ensureBundle,
  type InstalledBundle,
} from "@zcmsorg/package";
import defaultTheme from "@zcmsorg/theme-default";

/**
 * Loads whichever theme a site has activated — including one uploaded five
 * minutes ago that this process has never seen.
 *
 * Before this existed, themes were statically imported, which meant "install a
 * theme" was really "edit site-runtime and redeploy". That is not a CMS; it is a
 * website with extra steps. A theme is now a signed package: the runtime gets it,
 * verifies it against a PINNED key, unpacks it into a cache directory, and imports
 * it at runtime.
 *
 * There are two kinds, and both are signed:
 *
 *   - a MARKETPLACE theme is downloaded and checked against `MARKETPLACE_PUBLIC_KEY`;
 *   - a BUILT-IN theme ships in the image and is checked against
 *     `FIRST_PARTY_PUBLIC_KEY`. It used to be checked against nothing at all — the
 *     four themes we ship were the four we never verified.
 *
 * That second one matters more here than it does for plugins, and it is worth being
 * blunt about why: **a theme is not sandboxed.** A plugin runs in an isolated-vm
 * isolate inside a separate process that holds no credentials. A theme is imported
 * into site-runtime and rendered there, with site-runtime's own Node, its own
 * `process.env`, its own filesystem. There is no isolate underneath it to catch
 * anything. The signature IS the boundary.
 *
 * Two properties are worth being explicit about:
 *
 *   - The default theme ALSO stays compiled in. That copy is the fallback when
 *     anything else fails, so it must not itself depend on the network, the cache, or
 *     a signature check succeeding — it comes from the build, not from the volume,
 *     which is precisely what makes it trustworthy without one.
 *
 *   - A theme that fails to load NEVER takes the site down. Bad signature, missing
 *     bundle, broken module — all of it degrades to that compiled-in default plus a
 *     loud log. The visitor sees a site; the operator sees the error. Degrading is
 *     not the same as trusting: nothing unverified is ever imported.
 */

/**
 * The compiled-in fallback. NOT the built-in loading path.
 *
 * This is the one theme that exists twice — once compiled into this bundle (here),
 * and once as a signed package on the volume like the other three. They are for
 * different jobs: this copy answers "what do we render when everything else failed?",
 * and the answer must not be able to fail for the same reason.
 */
const COMPILED_IN_FALLBACK: Theme<any> = defaultTheme;
const DEFAULT_KEY = "vn.zsoft.theme.default";

/** Where the signed built-in themes live: `<root>/<name>/<id>-<version>.zcms`. */
const THEME_DIR = () =>
  process.env.THEME_DIR ?? path.resolve(process.cwd(), "../../themes");

const firstPartyPublicKey = () =>
  (process.env.FIRST_PARTY_PUBLIC_KEY ?? "").replace(/\\n/g, "\n");

/**
 * Which keys are built in.
 *
 * Read from the volume, not hard-coded — but note what this list is FOR: it decides
 * which loading path a key takes, and nothing else. A liar who adds a directory here
 * gets their package sent down the first-party path, where it is verified against a
 * key they do not have, and refused. Discovery does not grant anything.
 */
function builtinThemeKeys(): string[] {
  const root = THEME_DIR();
  if (!fs.existsSync(root)) return [];

  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, entry.name, "theme.json"))
    .filter((file) => fs.existsSync(file))
    .map((file) => (JSON.parse(fs.readFileSync(file, "utf8")) as { id: string }).id);
}

/**
 * Where a BUILT-IN theme's assets are served from.
 *
 * A downloaded theme's files are served out of its verified bundle, under its key
 * and version. A built-in one has no bundle to serve from — it was compiled into
 * this app — so its files are copied into `public/` at build time and served from
 * there instead. `themes/default/scripts/sync-assets.ts` is the copy; this is the
 * URL, and the two have to agree.
 *
 * Namespaced by theme key, and under a prefix odd enough that no tenant's page
 * slug can collide with it — the same reasoning, and the same trick, as
 * `z-flags` in @zcmsorg/i18n.
 */
export const BUILT_IN_ASSET_ROOT = "/z-theme-assets";

/** e.g. "/z-theme-assets/vn.zsoft.theme.default/" */
export function builtInAssetBase(key: string): string {
  return `${BUILT_IN_ASSET_ROOT}/${encodeURIComponent(key)}/`;
}

/** e.g. "/theme-assets/vn.zsoft.theme.aurora/1.1.0/" — served by the route of the same name. */
export function packagedAssetBase(key: string, version: string): string {
  return `/theme-assets/${encodeURIComponent(key)}/${encodeURIComponent(version)}/`;
}

export interface LoadedTheme {
  theme: Theme<any>;
  /** URL of the theme's own compiled CSS, when it ships one. */
  stylesheet: string | null;
  /**
   * Site-root path the theme's own files hang off — its logo, its icons. Handed
   * to the theme as `ctx.asset`, which is the only way a theme can name a file it
   * ships without knowing where it was installed.
   *
   * This is what makes a favicon belong to a theme: two themes on one platform
   * have two different bases, so neither can serve the other's icon.
   */
  assetBase: string;
  /** True when we fell back — the site is not rendering what it asked for. */
  degraded: boolean;
}

/**
 * The fallback, used whenever a requested theme cannot be loaded.
 *
 * Deliberately the COMPILED-IN copy of the default theme, never the signed package on
 * the volume. If a bad signature on the built-in default sent us to a fallback that
 * also had to verify the built-in default, the failure would simply happen twice and
 * the site would be down. The fallback has to be the thing that cannot fail the same
 * way — and code that came from our own build rather than from the volume is exactly
 * that thing.
 */
function builtInDefault(): LoadedTheme {
  return {
    theme: COMPILED_IN_FALLBACK,
    stylesheet: null,
    assetBase: builtInAssetBase(DEFAULT_KEY),
    degraded: true,
  };
}

const cache = new Map<string, LoadedTheme>();

/**
 * Drops a theme from the in-memory cache.
 *
 * Called by the purge endpoint when the marketplace revokes a version. Deleting
 * the disk cache alone would not be enough: the module object is already loaded
 * and would keep rendering until the process restarted.
 *
 * Node's ESM loader has no unload — the module stays in the loader's own cache —
 * but nothing reaches it once this map forgets it, and the next load of that
 * key@version is refused by the API anyway. A revoked theme cannot come back.
 */
export function forgetTheme(key: string, version: string): void {
  cache.delete(`${key}@${version}`);
}

function loaderConfig() {
  const marketplacePublicKey = (process.env.MARKETPLACE_PUBLIC_KEY ?? "").replace(
    /\\n/g,
    "\n",
  );
  const operatorPublicKey = (process.env.OPERATOR_PUBLIC_KEY ?? "").replace(
    /\\n/g,
    "\n",
  );

  return {
    cacheDir:
      process.env.THEME_CACHE_DIR ?? path.join(process.cwd(), ".zcms-themes"),
    apiUrl: process.env.CMS_API_URL ?? "http://localhost:4100",
    internalToken: process.env.CMS_INTERNAL_TOKEN ?? "",
    marketplacePublicKey,
    operatorPublicKey,
  };
}

/**
 * Loads in flight, keyed by key@version.
 *
 * A page resolves its theme twice — once in `generateMetadata`, once in the page
 * component — and those run concurrently. Without this, both miss the cache and
 * both start a full download-verify-unpack, racing each other over the same
 * directory. Sharing the promise means the second caller waits for the first
 * rather than fighting it.
 */
const inFlight = new Map<string, Promise<LoadedTheme>>();

export type ThemeOrigin = "BUILTIN" | "MARKETPLACE" | "SIDELOAD";

/**
 * Verifies and unpacks a theme so its declared media can be served without importing
 * and executing the theme module. The asset route uses this for Appearance previews:
 * looking at a screenshot must never execute a theme the user has not activated.
 */
export async function ensureThemeAssets(
  key: string,
  version: string,
  origin?: ThemeOrigin,
  checksum?: string,
): Promise<void> {
  const builtIn = key === DEFAULT_KEY || builtinThemeKeys().includes(key);

  if (builtIn) {
    await loadBuiltinBundle(key, version);
  } else if (origin === "SIDELOAD") {
    await loadOperatorBundle(key, version, checksum);
  } else {
    await loadMarketplaceBundle(key, version, checksum);
  }
}

export async function loadTheme(
  key: string,
  version: string,
  origin?: ThemeOrigin,
  checksum?: string,
): Promise<LoadedTheme> {
  const cacheKey = `${key}@${version}`;
  const hit = cache.get(cacheKey);
  if (hit) return hit;

  const pending = inFlight.get(cacheKey);
  if (pending) return pending;

  const load = loadUncached(key, version, cacheKey, origin, checksum).finally(() => {
    inFlight.delete(cacheKey);
  });
  inFlight.set(cacheKey, load);
  return load;
}

async function loadUncached(
  key: string,
  version: string,
  cacheKey: string,
  origin?: ThemeOrigin,
  checksum?: string,
): Promise<LoadedTheme> {
  // THE GUARD. A key this runtime knows as built-in — one it ships and verifies
  // against the first-party key — ALWAYS takes the built-in path, whatever origin
  // cms-api claimed for it. This is what stops a sideload or a compromised cms-api
  // from naming a package `vn.zsoft.theme.default` (or any shipped key) and having it
  // verified against the operator or marketplace key instead. The safe-harbour
  // fallback in particular must never be resolvable by any route but its own.
  const builtIn = key === DEFAULT_KEY || builtinThemeKeys().includes(key);

  try {
    // Each route ends the same way — a VERIFIED bundle unpacked into the same cache
    // layout, then imported. Only the pinned key they are checked against differs,
    // because only the question differs: "did the marketplace review this stranger's
    // code?" / "did this instance's operator sign it?" / "is the code we ship the
    // code we signed?". The route is chosen HERE, from the guard and the origin
    // cms-api reported — never from anything inside the package.
    const bundle = builtIn
      ? await loadBuiltinBundle(key, version)
      : origin === "SIDELOAD"
        ? await loadOperatorBundle(key, version, checksum)
        : await loadMarketplaceBundle(key, version, checksum);

    const theme = await importTheme(bundle);

    // Served by app/theme-assets/[...path]/route.ts out of the same verified cache the
    // bundle was unpacked into — the stylesheet and the theme's icons and logo all
    // hang off this one base. A built-in gets the identical treatment now that it has
    // a real bundle, which is why its CSS no longer has to be @import-ed into
    // globals.css to exist.
    const assetBase = packagedAssetBase(key, bundle.version);

    // The default theme's CSS is already in the page: it is @import-ed into
    // globals.css so that the compiled-in FALLBACK is not unstyled. Linking the
    // packaged copy as well would ship the same rules twice for no benefit. Every
    // other theme, built-in or not, brings its own — site-runtime's Tailwind only
    // scans site-runtime's own source, so a theme it did not compile is invisible to
    // it (see docs/distribution.md, "Why a theme carries its own CSS").
    const styles = (bundle.manifest as { styles?: string }).styles;
    const loaded: LoadedTheme = {
      theme,
      stylesheet: styles && key !== DEFAULT_KEY ? `${assetBase}${styles}` : null,
      assetBase,
      degraded: false,
    };

    cache.set(cacheKey, loaded);
    return loaded;
  } catch (err) {
    // Loudly, but not fatally. A site with the wrong theme is a bug; a site returning
    // 500 to every visitor is an outage.
    //
    // Degrading is NOT trusting. Nothing unverified was imported to get here — the
    // failure happened before `importTheme`, on purpose. What renders instead is the
    // compiled-in default, which came from our build rather than from the volume.
    console.error(
      `[theme-loader] ${builtIn ? "BUILT-IN " : ""}theme "${key}@${version}" could not be loaded; ` +
        `falling back to the compiled-in default theme.\n  ${(err as Error).message}`,
    );
    return builtInDefault();
  }
}

/** A theme we ship. Verified against the first-party key; no network, no marketplace. */
async function loadBuiltinBundle(key: string, version: string): Promise<InstalledBundle> {
  const pinned = firstPartyPublicKey();
  if (!pinned) {
    throw new Error(
      "FIRST_PARTY_PUBLIC_KEY is not configured. A built-in theme cannot be verified — " +
        "refusing to import unverified code into this process.",
    );
  }

  return ensureBuiltinBundle(
    {
      cacheDir:
        process.env.THEME_CACHE_DIR ?? path.join(process.cwd(), ".zcms-themes"),
      root: THEME_DIR(),
      firstPartyPublicKey: pinned,
    },
    "theme",
    key,
    version,
  );
}

/** A theme a stranger published. Downloaded, verified against the marketplace key. */
async function loadMarketplaceBundle(
  key: string,
  version: string,
  checksum?: string,
): Promise<InstalledBundle> {
  const cfg = loaderConfig();
  if (!cfg.marketplacePublicKey) {
    throw new Error(
      "MARKETPLACE_PUBLIC_KEY is not configured. The theme cannot be verified — " +
        "refusing to load unverified code.",
    );
  }

  return ensureBundle(cfg, "marketplace", "theme", key, version, checksum);
}

/**
 * A theme this instance's operator sideloaded. Downloaded, verified against the
 * OPERATOR key — never the marketplace key, and with no fallback to it.
 *
 * An air-gapped instance has no marketplace key at all, so this route must not touch
 * `loadMarketplaceBundle`, and it does not. An instance that did not opt into
 * sideloading has no operator key pinned, and `ensureBundle` (via `verifyOperator`)
 * refuses the theme rather than importing it — degrading to the compiled-in default,
 * which is the right outcome for a theme it cannot vouch for.
 */
async function loadOperatorBundle(
  key: string,
  version: string,
  checksum?: string,
): Promise<InstalledBundle> {
  const cfg = loaderConfig();
  if (!cfg.operatorPublicKey) {
    throw new Error(
      "OPERATOR_PUBLIC_KEY is not configured. This sideloaded theme cannot be " +
        "verified — refusing to load unverified code.",
    );
  }

  return ensureBundle(cfg, "operator", "theme", key, version, checksum);
}

/**
 * Imports the verified bundle.
 *
 * The ignore comments matter: without them the bundler tries to resolve this
 * import at BUILD time and fails, because the file does not exist yet — it is
 * downloaded at run time. Both bundlers Next can use are told to leave it alone.
 *
 * The theme bundle declares `react` and `react/jsx-runtime` as externals, so it
 * resolves them from node_modules and shares the runtime's React rather than
 * bundling a second copy. Two Reacts in one render is the classic way a plugin
 * system produces "invalid hook call" in production and nowhere else.
 */
async function importTheme(bundle: InstalledBundle): Promise<Theme<any>> {
  const url = pathToFileURL(bundle.entryPath).href;

  const mod = (await import(
    /* webpackIgnore: true */ /* turbopackIgnore: true */ url
  )) as { default?: Theme<any> } & Theme<any>;

  const theme = mod.default ?? mod;

  if (!theme?.templates?.page || !theme.Layout) {
    throw new Error(
      `Theme "${bundle.key}" is invalid: missing Layout or templates.page.`,
    );
  }

  return theme;
}
