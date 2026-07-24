import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Verified bundles are import()ed at runtime. Vite blocks imports from outside
// the project root (server.fs.allow), so the fabricated bundles live under the
// app's own node_modules — an allowed, git-ignored root — rather than in os.tmpdir.
// cwd is the app directory when this suite runs.
const TMP_ROOT = path.join(process.cwd(), "node_modules", ".zcms-loader-test");

/**
 * This module imports code into site-runtime's OWN process. A theme is not
 * sandboxed — no isolate, no separate container, full Node — so the signature is the
 * only boundary there is, and every path here either verifies or refuses.
 *
 * Three halves, if that were a thing:
 *
 *   1. A MARKETPLACE theme is verified against the pinned marketplace key. With none
 *      pinned it does not even ask for the bundle.
 *   2. A BUILT-IN theme — one of the four we ship — is verified against the pinned
 *      FIRST-PARTY key. It used to be exempt from all of this: the default theme was
 *      simply compiled in and the other three did not load as built-ins at all.
 *      Being first-party now buys a different key to be checked against, not an
 *      exemption from being checked.
 *   3. A failed load NEVER takes the site down. It degrades to the COMPILED-IN
 *      default — which came from our build rather than from the volume, and so is the
 *      one thing that cannot fail the same way — and flags `degraded`.
 *
 * Both `ensureBundle` and `ensureBuiltinBundle` are mocked so the refusal paths can
 * be driven; their real signature enforcement is covered in @zcmsorg/package and in
 * plugin-runtime's registry-builtin suite.
 */

const ensureBundle = vi.fn();
const ensureBuiltinBundle = vi.fn();
vi.mock("@zcmsorg/package", () => ({
  ensureBundle: (...args: unknown[]) => ensureBundle(...args),
  ensureBuiltinBundle: (...args: unknown[]) => ensureBuiltinBundle(...args),
}));

import defaultTheme from "@zcmsorg/theme-default";
import { forgetTheme, loadTheme } from "../theme-loader";

const REAL_KEY = "vn.zsoft.theme.default";
let tmp: string;

/** Writes a minimal, valid theme ESM module and returns an InstalledBundle for it. */
function bundleFor(key: string, version: string, opts: { valid?: boolean; styles?: string } = {}) {
  const dir = fs.mkdtempSync(path.join(tmp, "bundle-"));
  const entry = "index.mjs";
  const body = opts.valid === false
    ? `export default { manifest: { id: ${JSON.stringify(key)} } };`
    : `export default { manifest: { id: ${JSON.stringify(key)}${opts.styles ? `, styles: ${JSON.stringify(opts.styles)}` : ""} }, Layout: () => null, templates: { page: () => null }, blocks: {}, messages: {} };`;
  fs.writeFileSync(path.join(dir, entry), body);
  return {
    key,
    version,
    dir,
    entryPath: path.join(dir, entry),
    manifest: { id: key, entry, ...(opts.styles ? { styles: opts.styles } : {}) },
    checksum: "deadbeef",
  };
}

/** A THEME_DIR holding one built-in theme, so the loader knows which path a key takes. */
function themeDirWith(...ids: string[]): string {
  const root = fs.mkdtempSync(path.join(tmp, "themes-"));
  for (const id of ids) {
    const dir = path.join(root, id.split(".").pop()!);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "theme.json"), JSON.stringify({ id, version: "1.2.0" }));
  }
  return root;
}

beforeEach(() => {
  ensureBundle.mockReset();
  ensureBuiltinBundle.mockReset();
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  tmp = fs.mkdtempSync(path.join(TMP_ROOT, "run-"));
  vi.stubEnv("MARKETPLACE_PUBLIC_KEY", "-----BEGIN PUBLIC KEY-----\\npinned\\n-----END PUBLIC KEY-----");
  vi.stubEnv("FIRST_PARTY_PUBLIC_KEY", "-----BEGIN PUBLIC KEY-----\\nfirstparty\\n-----END PUBLIC KEY-----");
  // The default: no built-ins on disk, so every key takes the marketplace path.
  // Tests that care about the built-in path point THEME_DIR at one.
  vi.stubEnv("THEME_DIR", themeDirWith());
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("loadTheme", () => {
  it("VERIFIES a built-in theme against the first-party key — it is not exempt", async () => {
    // The four themes we ship used to be the four nobody checked. A built-in now goes
    // through the first-party path, and it never touches the marketplace one: no
    // download, no network, no registry — an air-gapped install still verifies.
    const key = "vn.zsoft.theme.aurora";
    vi.stubEnv("THEME_DIR", themeDirWith(key));
    ensureBuiltinBundle.mockResolvedValue(bundleFor(key, "1.1.0", { styles: "theme.css" }));

    const loaded = await loadTheme(key, "1.1.0");

    expect(ensureBuiltinBundle).toHaveBeenCalledWith(
      expect.objectContaining({ firstPartyPublicKey: expect.stringContaining("firstparty") }),
      "theme",
      key,
      "1.1.0",
    );
    expect(ensureBundle).not.toHaveBeenCalled();
    expect(loaded.degraded).toBe(false);
  });

  it("REFUSES a built-in theme when no first-party key is pinned, and does not import", async () => {
    // Fail closed, and fail closed BEFORE importing. An operator who forgot the env
    // var gets the compiled-in default, not an unverified module in their process.
    // A key of its own: loadTheme's cache is module-level, and reusing a key another
    // test loaded successfully would test the cache rather than the refusal.
    const key = "vn.zsoft.theme.unpinnedbuiltin";
    vi.stubEnv("THEME_DIR", themeDirWith(key));
    vi.stubEnv("FIRST_PARTY_PUBLIC_KEY", "");

    const loaded = await loadTheme(key, "1.1.0");

    expect(ensureBuiltinBundle).not.toHaveBeenCalled();
    expect(loaded.degraded).toBe(true);
    expect(loaded.theme).toBe(defaultTheme);
  });

  it("degrades to the COMPILED-IN default when the built-in default fails its own signature", async () => {
    // The nastiest corner, and the reason the fallback is compiled in rather than
    // loaded. If a bad signature on the built-in default sent us to a fallback that
    // also had to verify the built-in default, the site would simply fail twice.
    vi.stubEnv("THEME_DIR", themeDirWith(REAL_KEY));
    ensureBuiltinBundle.mockRejectedValue(new Error("Invalid first-party signature."));

    const loaded = await loadTheme(REAL_KEY, "1.2.0");

    expect(loaded.degraded).toBe(true);
    expect(loaded.theme).toBe(defaultTheme); // the compiled-in copy, from our build
  });

  it("refuses to load anything when no marketplace key is pinned, and does not fetch", async () => {
    // The runtime pins the marketplace key in its OWN config. With none, it cannot
    // verify a signature, so it must refuse rather than trust the API's word — and
    // it must not even reach out for the bundle.
    vi.stubEnv("MARKETPLACE_PUBLIC_KEY", "");

    const loaded = await loadTheme("vn.zsoft.theme.unpinned", "1.0.0");

    expect(ensureBundle).not.toHaveBeenCalled();
    expect(loaded.degraded).toBe(true);
    expect(loaded.theme).toBe(defaultTheme);
  });

  it("degrades to the default theme, and does NOT cache, when signature verification fails", async () => {
    // ensureBundle throws exactly when verifyPackage rejects a forged/unsigned
    // package. That failure must never be cached, or one bad fetch would pin the
    // fallback for a version that later becomes loadable.
    const key = "vn.zsoft.theme.forged";
    ensureBundle.mockRejectedValue(new Error("not released by Z-CMS"));

    const first = await loadTheme(key, "1.0.0");
    expect(first.degraded).toBe(true);
    expect(first.theme).toBe(defaultTheme);

    // A second call re-attempts the load (was not cached), so ensureBundle runs again.
    await loadTheme(key, "1.0.0");
    expect(ensureBundle).toHaveBeenCalledTimes(2);
  });

  it("degrades when the verified bundle's entry module is missing Layout/templates", async () => {
    // A package can pass its signature check and still be structurally invalid.
    // Importing it must not throw up to the page.
    const key = "vn.zsoft.theme.broken";
    ensureBundle.mockResolvedValue(bundleFor(key, "1.0.0", { valid: false }));

    const loaded = await loadTheme(key, "1.0.0");

    expect(loaded.degraded).toBe(true);
    expect(loaded.theme).toBe(defaultTheme);
  });

  it("loads and caches a verified theme, serving the second call from memory", async () => {
    const key = "vn.zsoft.theme.corp";
    ensureBundle.mockResolvedValue(bundleFor(key, "1.0.0", { styles: "styles.css" }));

    const first = await loadTheme(key, "1.0.0");
    const second = await loadTheme(key, "1.0.0");

    expect(first.degraded).toBe(false);
    expect(first).toBe(second); // same cached object
    expect(ensureBundle).toHaveBeenCalledTimes(1);
    // The stylesheet URL is namespaced by key@version so it serves from the
    // matching verified cache, never another version's.
    expect(first.stylesheet).toBe(
      `/theme-assets/${encodeURIComponent(key)}/1.0.0/styles.css`,
    );
    // And so is everything else the theme ships — its logo, its favicon — which is
    // what stops two installed themes from claiming the same icon URL.
    expect(first.assetBase).toBe(`/theme-assets/${encodeURIComponent(key)}/1.0.0/`);
  });

  it("does not link the default theme's CSS twice", async () => {
    // The default theme's stylesheet is @import-ed into globals.css so the
    // compiled-in FALLBACK is not unstyled. Linking the packaged copy as well would
    // ship the same rules twice for nothing. Every other theme brings its own.
    vi.stubEnv("THEME_DIR", themeDirWith(REAL_KEY));
    ensureBuiltinBundle.mockResolvedValue(bundleFor(REAL_KEY, "1.2.0", { styles: "theme.css" }));

    const loaded = await loadTheme(REAL_KEY, "1.2.0");

    expect(loaded.degraded).toBe(false);
    expect(loaded.stylesheet).toBeNull();
  });

  it("falls back to the built-in asset base when a theme fails to load", async () => {
    // Degrading to the default theme but keeping the broken theme's asset base
    // would render the fallback with icons that are not there.
    ensureBundle.mockRejectedValue(new Error("bad signature"));

    const loaded = await loadTheme("vn.zsoft.theme.evil", "1.0.0");

    expect(loaded.degraded).toBe(true);
    expect(loaded.assetBase).toBe("/z-theme-assets/vn.zsoft.theme.default/");
  });

  it("busts the cache on a version change so a new release is not masked by an old one", async () => {
    const key = "vn.zsoft.theme.versioned";
    ensureBundle.mockResolvedValueOnce(bundleFor(key, "1.0.0"));
    ensureBundle.mockResolvedValueOnce(bundleFor(key, "2.0.0"));

    await loadTheme(key, "1.0.0");
    await loadTheme(key, "2.0.0");

    // Two distinct versions => two real loads; the 1.0.0 entry never answers 2.0.0.
    expect(ensureBundle).toHaveBeenCalledTimes(2);
    expect(ensureBundle).toHaveBeenNthCalledWith(2, expect.anything(), "marketplace", "theme", key, "2.0.0", undefined);
  });
});

describe("loadTheme — the operator (sideload) route", () => {
  it("verifies a SIDELOAD theme against the OPERATOR key, on the operator route", async () => {
    // A sideload is checked against the operator key pinned in THIS process — never
    // the marketplace key, and the route is named explicitly, not inferred.
    const key = "acme.theme.inhouse";
    vi.stubEnv("OPERATOR_PUBLIC_KEY", "-----BEGIN PUBLIC KEY-----\\noperator\\n-----END PUBLIC KEY-----");
    ensureBundle.mockResolvedValue(bundleFor(key, "1.0.0"));

    const loaded = await loadTheme(key, "1.0.0", "SIDELOAD");

    expect(ensureBundle).toHaveBeenCalledWith(
      expect.objectContaining({ operatorPublicKey: expect.stringContaining("operator") }),
      "operator",
      "theme",
      key,
      "1.0.0",
      undefined,
    );
    expect(loaded.degraded).toBe(false);
  });

  it("REFUSES a sideload when no operator key is pinned, and does not fetch", async () => {
    // An instance that never opted into sideloading has no operator key. A theme on
    // the operator route must then degrade to the default, not be trusted.
    const key = "acme.theme.unpinned";
    vi.stubEnv("OPERATOR_PUBLIC_KEY", "");

    const loaded = await loadTheme(key, "1.0.0", "SIDELOAD");

    expect(ensureBundle).not.toHaveBeenCalled();
    expect(loaded.degraded).toBe(true);
    expect(loaded.theme).toBe(defaultTheme);
  });

  it("THE GUARD: a built-in key claimed as SIDELOAD still takes the first-party path", async () => {
    // The confusion attack: a sideload (or a compromised cms-api) reports origin
    // SIDELOAD for a key the runtime ships as built-in, hoping to have it verified
    // against the operator key instead of the first-party one. The guard forces the
    // built-in path regardless of the claimed origin, so the operator route is never
    // even consulted for a built-in key. A key of its own — the module-level cache
    // would otherwise answer from an earlier test's successful load.
    const key = "vn.zsoft.theme.guardbuiltin";
    vi.stubEnv("THEME_DIR", themeDirWith(key));
    vi.stubEnv("OPERATOR_PUBLIC_KEY", "-----BEGIN PUBLIC KEY-----\\noperator\\n-----END PUBLIC KEY-----");
    ensureBuiltinBundle.mockResolvedValue(bundleFor(key, "1.1.0"));

    const loaded = await loadTheme(key, "1.1.0", "SIDELOAD");

    expect(ensureBuiltinBundle).toHaveBeenCalledWith(
      expect.objectContaining({ firstPartyPublicKey: expect.stringContaining("firstparty") }),
      "theme",
      key,
      "1.1.0",
    );
    expect(ensureBundle).not.toHaveBeenCalled();
    expect(loaded.degraded).toBe(false);
  });

  it("THE GUARD: the default key claimed as SIDELOAD never leaves the first-party path", async () => {
    // The safe-harbour fallback is the highest-value confusion target. Even claimed
    // as a sideload, vn.zsoft.theme.default resolves only as a built-in. A fresh
    // version so the module cache does not answer from another test's load.
    vi.stubEnv("OPERATOR_PUBLIC_KEY", "-----BEGIN PUBLIC KEY-----\\noperator\\n-----END PUBLIC KEY-----");
    ensureBuiltinBundle.mockResolvedValue(bundleFor(REAL_KEY, "9.9.9"));

    const loaded = await loadTheme(REAL_KEY, "9.9.9", "SIDELOAD");

    expect(ensureBuiltinBundle).toHaveBeenCalled();
    expect(ensureBundle).not.toHaveBeenCalled();
    expect(loaded.degraded).toBe(false);
  });
});

describe("forgetTheme", () => {
  it("drops a cached theme so the next load re-verifies it", async () => {
    // The kill switch: after revocation the in-memory module must be re-resolved,
    // which is what makes the next load a refused one.
    const key = "vn.zsoft.theme.revoked";
    ensureBundle.mockResolvedValue(bundleFor(key, "1.0.0"));

    await loadTheme(key, "1.0.0");
    forgetTheme(key, "1.0.0");
    await loadTheme(key, "1.0.0");

    expect(ensureBundle).toHaveBeenCalledTimes(2);
  });
});
