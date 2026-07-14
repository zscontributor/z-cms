import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureBuiltinBundle, ensureBundle } from "@zcmsorg/package";

/**
 * Which plugin bundles this runtime is willing to execute.
 *
 * There are two kinds, and until recently only one of them was checked.
 *
 * A MARKETPLACE plugin arrives as a signed `.zcms`, is verified against the pinned
 * marketplace key, and only then unpacked. Anyone can publish one, so nobody trusted
 * it, and it showed.
 *
 * A BUILT-IN plugin shipped inside the image, and the runtime simply read its
 * `dist/index.js` off the volume and ran it. The reasoning was that the volume is
 * the operator's — but "the operator's volume" is a bad image layer, a mounted host
 * path, a compromised CI step, or an operator with a text editor. First-party code
 * runs with the most privilege in the system (zAI holds `network:fetch` and spends
 * the site's API keys), and it was the only code nobody verified.
 *
 * Now both are signed and both are verified. A built-in is a `.zcms` sitting next to
 * its source, signed with the first-party key and checked against
 * `FIRST_PARTY_PUBLIC_KEY` — a key pinned in this process's config, not one that
 * travelled with the package. Edit `dist/index.js` on the volume and nothing happens,
 * because nothing reads it any more.
 *
 * cms-api never sends code to this service either way. It sends a plugin *key*. A
 * compromised API cannot make the runtime execute arbitrary JavaScript.
 */

export interface LoadedPlugin {
  key: string;
  version: string;
  bundlePath: string;
  code: string;
  checksum: string;
}

const PLUGIN_DIR = () =>
  process.env.PLUGIN_DIR ?? path.resolve(__dirname, "../../../plugins");

const BUILTIN_CACHE_DIR = () =>
  process.env.PLUGIN_BUILTIN_CACHE_DIR ??
  path.join(os.tmpdir(), "zcms-builtin-plugins");

const firstPartyPublicKey = () =>
  (process.env.FIRST_PARTY_PUBLIC_KEY ?? "").replace(/\\n/g, "\n");

const cache = new Map<string, LoadedPlugin>();

/**
 * Loads a BUILT-IN plugin from its signed package.
 *
 * The heavy lifting — verify against the pinned key, then extract without letting
 * the archive choose where its files land — is `ensureBuiltinBundle`, shared with
 * site-runtime, because a second implementation of those two steps is a second place
 * to get them wrong.
 *
 * What comes back is the manifest from INSIDE the verified payload, never the
 * `plugin.json` lying next to it on disk. That distinction is the whole point: a
 * manifest declares the plugin's permissions and the hosts it may reach, so an
 * unsigned copy of it is an unsigned copy of the security policy. Whoever could edit
 * the volume would otherwise widen `network.hosts` without touching a line of signed
 * code.
 */
export async function loadBuiltinPlugin(key: string): Promise<LoadedPlugin> {
  const cached = cache.get(key);
  if (cached && process.env.NODE_ENV === "production") return cached;

  // Checked here rather than left to the shared loader, which cannot know what the
  // key is called in *this* process's config. An operator reading this line in a log
  // needs the name of the variable they forgot, not a generic complaint about pinning.
  if (!firstPartyPublicKey()) {
    throw new Error(
      "FIRST_PARTY_PUBLIC_KEY is not configured — refusing to run an unverified built-in plugin.",
    );
  }

  const bundle = await ensureBuiltinBundle(
    {
      cacheDir: BUILTIN_CACHE_DIR(),
      root: PLUGIN_DIR(),
      firstPartyPublicKey: firstPartyPublicKey(),
    },
    "plugin",
    key,
  );

  const loaded: LoadedPlugin = {
    key,
    version: bundle.version,
    bundlePath: bundle.entryPath,
    code: fs.readFileSync(bundle.entryPath, "utf8"),
    // The payload digest the signature covers — not a hash of the file we just
    // wrote. The signed thing is what we are identifying.
    checksum: bundle.checksum,
  };
  cache.set(key, loaded);
  return loaded;
}

/**
 * Loads a marketplace plugin from its signed package.
 *
 * The exact path a theme takes, for the same reason: this is the one place code
 * we did not write reaches the runtime, so it is verified against the pinned
 * marketplace key before a byte of it is read. The pinned key lives in this
 * process's config; a compromised cms-api cannot forge a signature it accepts.
 */
export async function loadSignedPlugin(key: string, version: string): Promise<string> {
  const marketplacePublicKey = (process.env.MARKETPLACE_PUBLIC_KEY ?? "").replace(
    /\\n/g,
    "\n",
  );
  if (!marketplacePublicKey) {
    throw new Error(
      "MARKETPLACE_PUBLIC_KEY is not configured — refusing to load an unverified plugin.",
    );
  }

  const bundle = await ensureBundle(
    {
      cacheDir: process.env.PLUGIN_CACHE_DIR ?? path.resolve(__dirname, "../.zcms-plugins"),
      apiUrl: process.env.CMS_API_URL ?? "http://localhost:4100",
      internalToken: process.env.CMS_INTERNAL_TOKEN ?? "",
      marketplacePublicKey,
    },
    "marketplace",
    "plugin",
    key,
    version,
  );

  return fs.readFileSync(bundle.entryPath, "utf8");
}

/**
 * Loads an OPERATOR-sideloaded plugin from its signed package.
 *
 * The same shape as `loadSignedPlugin`, one pinned key over: this instance's operator
 * signed it, and it is verified against OPERATOR_PUBLIC_KEY held here — never the
 * marketplace key, and with no fallback between the two. An instance that did not
 * opt into sideloading has no operator key pinned, and `verifyOperator` refuses the
 * package rather than run it. cms-api only ever routes a package here when its stored
 * origin is SIDELOAD; the runtime still verifies, because cms-api's word is not the
 * gate — the signature is.
 */
export async function loadOperatorPlugin(key: string, version: string): Promise<string> {
  const operatorPublicKey = (process.env.OPERATOR_PUBLIC_KEY ?? "").replace(/\\n/g, "\n");
  if (!operatorPublicKey) {
    throw new Error(
      "OPERATOR_PUBLIC_KEY is not configured — refusing to load a sideloaded plugin.",
    );
  }

  const bundle = await ensureBundle(
    {
      cacheDir: process.env.PLUGIN_CACHE_DIR ?? path.resolve(__dirname, "../.zcms-plugins"),
      apiUrl: process.env.CMS_API_URL ?? "http://localhost:4100",
      internalToken: process.env.CMS_INTERNAL_TOKEN ?? "",
      // Not used on the operator route, but the config shape requires it. The route,
      // not this field, decides which key verifies — see ensureBundle.
      marketplacePublicKey: "",
      operatorPublicKey,
    },
    "operator",
    "plugin",
    key,
    version,
  );

  return fs.readFileSync(bundle.entryPath, "utf8");
}

/**
 * Forgets a plugin bundle — the kill switch, as seen from the runtime.
 *
 * REJECTED stops new downloads and does nothing to a bundle already on disk and
 * in memory: the runtime would keep executing a pulled plugin until it restarted.
 * cms-api calls the purge endpoint, this drops both caches, and the next
 * invocation has to fetch again — which the API now refuses.
 */
export function forgetPlugin(key: string, version: string): void {
  cache.delete(key);

  const cacheDir =
    process.env.PLUGIN_CACHE_DIR ?? path.resolve(__dirname, "../.zcms-plugins");
  const safe = (s: string) => s.replace(/[^a-zA-Z0-9._-]/g, "_");
  const dir = path.join(cacheDir, "plugin", safe(key), safe(version));

  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The built-in keys, for the health endpoint.
 *
 * Reads the unsigned `plugin.json` on purpose: this answers "what did the operator
 * put in this image?", which is a question about the volume, and its answer is only
 * ever printed. Nothing here decides what runs — `loadBuiltinPlugin` does, and it
 * reads the signed manifest.
 */
export function listInstalledKeys(): string[] {
  const root = PLUGIN_DIR();
  if (!fs.existsSync(root)) return [];

  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(root, d.name, "plugin.json"))
    .filter((p) => fs.existsSync(p))
    .map((p) => (JSON.parse(fs.readFileSync(p, "utf8")) as { id: string }).id);
}
