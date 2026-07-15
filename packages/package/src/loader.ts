import fs from "node:fs";
import path from "node:path";
import { installPayload, openPackage } from "./build";
import { sha256, verifyFirstParty, verifyOperator, verifyPackage } from "./signing";
import {
  PackageError,
  type PackageEnvelope,
  type PackageKind,
  type PackageManifest,
  type PackageTrust,
} from "./types";

/**
 * How a runtime gets code onto its own disk, safely.
 *
 * Shared by site-runtime (themes) and plugin-runtime (plugins), because the
 * dangerous parts are identical and there must be exactly one implementation of
 * them: verify a signature against a PINNED key, then extract without letting
 * the archive choose where its files land.
 *
 * The pinned key is the whole point. This module downloads the package FROM
 * cms-api — so if it trusted cms-api's word about the package being genuine, a
 * compromised API could serve a backdoored theme to every site on the platform.
 * Instead the marketplace's public key lives in the runtime's own config, and
 * the signature is checked against that. An attacker who owns the API still
 * cannot produce a package that passes.
 */

export interface LoaderConfig {
  /** Where verified packages are unpacked. Must be writable by the runtime. */
  cacheDir: string;
  /** cms-api base URL, e.g. "http://localhost:4100". */
  apiUrl: string;
  /** Shared token for the internal bundle endpoint. */
  internalToken: string;
  /** Marketplace Ed25519 public key, SPKI PEM. PINNED — never fetched. */
  marketplacePublicKey: string;
  /**
   * Operator Ed25519 public key, SPKI PEM. PINNED — never fetched. Present only on
   * instances that allow sideloading; a package on the "operator" trust route is
   * checked against this and nothing else. Empty on instances that do not sideload,
   * in which case any attempt on the operator route is refused by `verifyOperator`.
   */
  operatorPublicKey?: string;
}

export interface InstalledBundle {
  key: string;
  version: string;
  dir: string;
  entryPath: string;
  manifest: PackageManifest;
  checksum: string;
}

function bundleDir(cfg: LoaderConfig, kind: PackageKind, key: string, version: string) {
  // The key is reverse-DNS and the version is semver, but both arrive from the
  // database, so neither is allowed to shape a path. Anything outside the
  // expected alphabet is replaced rather than trusted.
  const safeKey = key.replace(/[^a-zA-Z0-9._-]/g, "_");
  const safeVersion = version.replace(/[^a-zA-Z0-9._-]/g, "_");
  return path.join(cfg.cacheDir, kind, safeKey, safeVersion);
}

const MARKER = ".zcms-verified";

/**
 * Ensures a verified copy of `key@version` exists on disk, and returns where.
 *
 * On a cache hit the payload is re-hashed before it is used. That is not
 * paranoia about our own code: the cache is a directory on disk, and "the file
 * changed after we verified it" is precisely how a package-manager cache becomes
 * a persistence mechanism for an attacker who got write access once.
 */
export async function ensureBundle(
  cfg: LoaderConfig,
  trust: PackageTrust,
  kind: PackageKind,
  key: string,
  version: string,
  expectedChecksum?: string,
): Promise<InstalledBundle> {
  const dir = bundleDir(cfg, kind, key, version);
  const markerPath = path.join(dir, MARKER);

  if (fs.existsSync(markerPath)) {
    const marker = JSON.parse(fs.readFileSync(markerPath, "utf8")) as {
      checksum: string;
      manifest: PackageManifest;
    };

    // A checksum the API disagrees with means the version was republished (which
    // the API forbids) or the cache was tampered with. Either way: re-fetch.
    if (!expectedChecksum || marker.checksum === expectedChecksum) {
      const entryPath = path.join(dir, marker.manifest.entry);
      if (fs.existsSync(entryPath)) {
        return {
          key,
          version,
          dir,
          entryPath,
          manifest: marker.manifest,
          checksum: marker.checksum,
        };
      }
    }
  }

  const file = await download(cfg, kind, key, version);
  const pkg = await openPackage(file);

  // Nothing has been written to the cache yet, and nothing will be until this
  // passes. A package that fails verification never lands on disk at all.
  //
  // WHICH key checks it is decided by `trust` — a discrete argument the caller
  // passed — never by inspecting the envelope. If routing keyed off "does this
  // envelope have a marketplaceSignature?", an attacker could downgrade a package
  // onto whichever route has the weaker key by stripping one field and adding
  // another. There is no `else` and no retry: a package handed the wrong route
  // fails here, which is the intended outcome, not a bug to paper over.
  if (trust === "operator") {
    verifyOperator(pkg.envelope, pkg.payload, cfg.operatorPublicKey ?? "");
  } else {
    verifyPackage(pkg.envelope, pkg.payload, cfg.marketplacePublicKey);
  }

  if (expectedChecksum && pkg.envelope.checksum !== expectedChecksum) {
    throw new PackageError(
      `Checksum of ${key}@${version} differs from the registered one. ` +
        `The package may have been altered after it was released.`,
    );
  }

  const manifest = pkg.envelope.manifest;
  if (manifest.id !== key) {
    // The envelope says it is a different package than the one we asked for.
    throw new PackageError(
      `The package returned is "${manifest.id}" but "${key}" was requested.`,
    );
  }

  return unpackVerified(dir, markerPath, key, version, pkg.envelope, pkg.payload);
}

/**
 * Writes a package that has ALREADY passed a signature check onto disk.
 *
 * Called from both the marketplace path above and the built-in path below, and it
 * is the same code on purpose: everything here is about not letting the archive
 * choose where its own files land, and there must be exactly one version of that.
 */
async function unpackVerified(
  dir: string,
  markerPath: string,
  key: string,
  version: string,
  envelope: PackageEnvelope,
  payload: Buffer,
): Promise<InstalledBundle> {
  const manifest = envelope.manifest;

  await installPayload(payload, dir);

  // The entry must resolve INSIDE the bundle. `unpackTo` already refuses hostile
  // paths, but the entry name comes from the manifest, which is attacker-authored
  // too — "../../../etc/passwd" as an entry would otherwise be loaded happily.
  //
  // Both sides of the comparison are resolved through realpath, and they have to be.
  // The previous version compared `path.resolve(dir + entry)` against
  // `realpathSync(dir)`, which silently disagrees with itself the moment the cache
  // lives behind a symlink — on macOS `/var` IS a link to `/private/var`, so a
  // perfectly ordinary bundle in a temp directory "pointed outside the package".
  // A path check that fails on honest input is a path check nobody will trust for
  // long.
  const root = fs.realpathSync(dir);
  const entryPath = path.resolve(root, manifest.entry);

  if (!entryPath.startsWith(root + path.sep)) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw new PackageError(`Entry "${manifest.entry}" points outside the package.`);
  }
  if (!fs.existsSync(entryPath)) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw new PackageError(`Entry "${manifest.entry}" is not in the package.`);
  }

  fs.writeFileSync(
    markerPath,
    JSON.stringify({ checksum: envelope.checksum, manifest }, null, 2),
  );

  return { key, version, dir, entryPath, manifest, checksum: envelope.checksum };
}

export interface BuiltinLoaderConfig {
  /** Where verified packages are unpacked. Same layout as the marketplace cache. */
  cacheDir: string;
  /** Directory holding the built-in packages: `<root>/<name>/<id>-<version>.zcms`. */
  root: string;
  /** First-party Ed25519 public key, SPKI PEM. PINNED — never read from a package. */
  firstPartyPublicKey: string;
}

/**
 * Gets a BUILT-IN package onto disk, verified — the offline twin of `ensureBundle`.
 *
 * A built-in ships inside the image rather than through the marketplace, so there is
 * no download, no counter-signature and no registry to call. What there used to be
 * instead was *nothing*: the runtime read the bundle straight off the volume and ran
 * it, because the volume belongs to the operator. That reasoning holds right up until
 * the volume is a bad image layer, a mounted host path, or a compromised CI step —
 * and built-in code is the code with the MOST privilege in the system. A theme is not
 * even sandboxed: it renders in site-runtime's own process, with its own Node.
 *
 * So it is verified against a pinned first-party key, and it lands in the same cache
 * layout the marketplace path uses. The identical layout is not tidiness: it is what
 * lets the theme-assets route serve a built-in theme's CSS and icons out of a
 * verified directory without knowing, or caring, which of the two paths put it there.
 */
export async function ensureBuiltinBundle(
  cfg: BuiltinLoaderConfig,
  kind: PackageKind,
  key: string,
  requestedVersion?: string,
): Promise<InstalledBundle> {
  if (!cfg.firstPartyPublicKey) {
    throw new PackageError(
      "No first-party public key is pinned — refusing to load an unverified built-in package.",
    );
  }

  // A runtime normally knows the exact immutable version selected for the site.
  // Narrow by the operator-controlled package filename before opening anything,
  // otherwise an unrelated built-in signed with an older key can prevent every
  // later package in the directory scan from loading. The package itself is still
  // verified below and its manifest must still match both id and version.
  const expectedFile = requestedVersion ? `${key}-${requestedVersion}.zcms` : null;
  const files = builtinPackageFiles(cfg.root).filter(
    (file) => expectedFile === null || path.basename(file) === expectedFile,
  );

  for (const file of files) {
    const { envelope, payload } = await openPackage(fs.readFileSync(file));

    // Before the manifest is read out of it, and long before anything is imported.
    // Note the order: an attacker's package for the WRONG key still gets verified
    // rather than skipped on the strength of its own unverified manifest.
    verifyFirstParty(envelope, payload, cfg.firstPartyPublicKey);

    if (
      envelope.manifest.id !== key ||
      (requestedVersion !== undefined && envelope.manifest.version !== requestedVersion)
    ) {
      continue;
    }

    const version = envelope.manifest.version;
    const dir = bundleDir(
      { cacheDir: cfg.cacheDir } as LoaderConfig,
      kind,
      key,
      version,
    );
    const markerPath = path.join(dir, MARKER);

    // A warm cache is reused only if it holds THIS checksum. A built-in that was
    // re-signed (a new build of the same version, in development) must not keep
    // serving the previous bytes out of the cache.
    if (fs.existsSync(markerPath)) {
      const marker = JSON.parse(fs.readFileSync(markerPath, "utf8")) as {
        checksum: string;
        manifest: PackageManifest;
      };
      const entryPath = path.join(dir, marker.manifest.entry);
      if (marker.checksum === envelope.checksum && fs.existsSync(entryPath)) {
        return {
          key,
          version,
          dir,
          entryPath,
          manifest: marker.manifest,
          checksum: marker.checksum,
        };
      }
    }

    return unpackVerified(dir, markerPath, key, version, envelope, payload);
  }

  throw new PackageError(
    `Built-in ${kind} "${key}" has no signed package in ${cfg.root}. ` +
      `Run: pnpm sign:${kind}s`,
  );
}

/** Every `.zcms` under `<root>/<name>/`. Discovery only — nothing is trusted yet. */
function builtinPackageFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];

  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const dir = path.join(root, entry.name);
      return fs
        .readdirSync(dir)
        .filter((file) => file.endsWith(".zcms"))
        .map((file) => path.join(dir, file));
    });
}

async function download(
  cfg: LoaderConfig,
  kind: PackageKind,
  key: string,
  version: string,
): Promise<Buffer> {
  const url = `${cfg.apiUrl.replace(/\/+$/, "")}/api/v1/packages/${kind}/${encodeURIComponent(key)}/${encodeURIComponent(version)}/bundle`;

  const res = await fetch(url, {
    headers: { "x-internal-token": cfg.internalToken },
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    throw new PackageError(
      `Could not download package ${key}@${version}: HTTP ${res.status}.`,
    );
  }

  return Buffer.from(await res.arrayBuffer());
}

/** Re-hashes a bundle already on disk. Cheap integrity check for a warm cache. */
export function bundleChecksumOnDisk(dir: string): string | null {
  const markerPath = path.join(dir, MARKER);
  if (!fs.existsSync(markerPath)) return null;
  return (JSON.parse(fs.readFileSync(markerPath, "utf8")) as { checksum: string })
    .checksum;
}

export { sha256 };
