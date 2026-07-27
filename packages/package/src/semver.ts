/**
 * Just enough semver to compare two package versions correctly.
 *
 * There is a `semver` package on npm and it is very good, but neither repo
 * depends on it, and pulling a dependency into the ONE module that both the CLI
 * and the marketplace vendor is a cost paid in two places forever. What is needed
 * here is small and its edges are the ones the spec is explicit about, so it is
 * written out rather than imported.
 *
 * "Correctly" is doing real work in that first sentence. The naive version — sort
 * the version strings, or compare them field by field as numbers — gets two
 * things wrong that matter:
 *
 *   - "1.0.0-alpha" is LESS than "1.0.0". A pre-release is not a release; it
 *     sorts before the thing it is a pre-release OF. Miss this and a `-rc1`
 *     uploaded before its final release counts as newer than the release.
 *   - "1.0.0-alpha.10" is GREATER than "1.0.0-alpha.2". Numeric pre-release
 *     identifiers compare as numbers, not as text — as text, "10" < "2".
 *
 * Build metadata ("+sha.1234") is ignored entirely, as the spec requires: two
 * versions differing only in build metadata have the same precedence.
 */

export interface Semver {
  major: number;
  minor: number;
  patch: number;
  /** The dot-separated pre-release identifiers, or [] for a release. */
  prerelease: (string | number)[];
}

// MAJOR.MINOR.PATCH, optional -prerelease, optional +build. No leading zeroes in
// the numeric core, which the spec forbids and which is usually a typo anyway.
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** Parses a version, or returns null if it is not valid semver. */
export function parseSemver(version: string): Semver | null {
  if (typeof version !== "string") return null;
  const match = SEMVER.exec(version.trim());
  if (!match) return null;

  const prerelease = match[4]
    ? match[4].split(".").map((id) => (/^\d+$/.test(id) ? Number(id) : id))
    : [];

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease,
  };
}

/**
 * Returns an error message, or null if `version` is a usable semver.
 *
 * The canonical copy. It used to live in the CLI as a loose regex that ran only
 * on the author's machine; the marketplace, which is where a hostile version
 * string actually arrives, checked nothing.
 */
export function validateVersion(version: unknown): string | null {
  if (typeof version !== "string" || !version.trim()) return "version is required.";
  if (!parseSemver(version)) {
    return `"${version}" is not a semantic version. Use MAJOR.MINOR.PATCH, e.g. 1.0.0.`;
  }
  return null;
}

/**
 * Compares two versions by precedence: negative if a < b, 0 if equal, positive
 * if a > b. Throws on an unparseable input — a caller comparing versions has
 * already validated them, and comparing garbage should be loud, not a silent 0.
 */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa) throw new Error(`Not a semantic version: "${a}".`);
  if (!pb) throw new Error(`Not a semantic version: "${b}".`);

  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  if (pa.patch !== pb.patch) return pa.patch - pb.patch;

  // A release outranks any pre-release of the same core. Empty prerelease wins.
  if (pa.prerelease.length === 0 && pb.prerelease.length === 0) return 0;
  if (pa.prerelease.length === 0) return 1;
  if (pb.prerelease.length === 0) return -1;

  // Identifier by identifier: numbers below strings, numbers numerically,
  // strings lexically. The one with more identifiers wins if all else is equal.
  const n = Math.min(pa.prerelease.length, pb.prerelease.length);
  for (let i = 0; i < n; i++) {
    const x = pa.prerelease[i]!;
    const y = pb.prerelease[i]!;
    if (x === y) continue;

    const xNum = typeof x === "number";
    const yNum = typeof y === "number";
    if (xNum && yNum) return (x as number) - (y as number);
    if (xNum) return -1; // numeric identifiers have lower precedence than strings
    if (yNum) return 1;
    return (x as string) < (y as string) ? -1 : 1;
  }

  return pa.prerelease.length - pb.prerelease.length;
}

/** The three release levels a version can be incremented by. */
export type ReleaseLevel = "major" | "minor" | "patch";

/**
 * Increments a version by one release level, returning the new version string.
 *
 * The rules match `npm version` / node-semver's `inc`, and the pre-release cases
 * are the only interesting part: incrementing a pre-release does not bump the
 * core past the release it is a pre-release OF, it RELEASES it. So a `patch` on
 * "1.2.3-rc.1" is "1.2.3" (the release the rc was leading up to), not "1.2.4" —
 * bumping to 1.2.4 would skip the 1.2.3 release the author was clearly working
 * toward. The same logic applies to `minor` when the pre-release already sits on
 * a fresh minor (x.y.0-*), and to `major` on a fresh major (x.0.0-*).
 *
 * Throws on an unparseable input — a caller incrementing a version has one it
 * read from a manifest it already validated, and bumping garbage should be loud.
 */
export function bumpSemver(version: string, level: ReleaseLevel): string {
  const p = parseSemver(version);
  if (!p) throw new Error(`Not a semantic version: "${version}".`);

  const pre = p.prerelease.length > 0;

  switch (level) {
    case "patch":
      // A pre-release releases to its own core; a release moves to the next patch.
      return pre ? `${p.major}.${p.minor}.${p.patch}` : `${p.major}.${p.minor}.${p.patch + 1}`;
    case "minor":
      // "1.2.0-rc" is already headed for 1.2.0; only a real 1.2.x climbs to 1.3.0.
      return pre && p.patch === 0 ? `${p.major}.${p.minor}.0` : `${p.major}.${p.minor + 1}.0`;
    case "major":
      // Same idea one level up: "2.0.0-rc" releases to 2.0.0, "2.1.3" goes to 3.0.0.
      return pre && p.minor === 0 && p.patch === 0
        ? `${p.major}.0.0`
        : `${p.major + 1}.0.0`;
  }
}

/**
 * The highest version in a list by precedence, or null if the list is empty.
 *
 * Unparseable entries are skipped rather than thrown on: this runs over rows
 * already in the database, and one bad legacy row should not blind the caller to
 * every good one. A caller that needs "all of these are valid" checks that
 * separately.
 */
export function maxSemver(versions: string[]): string | null {
  let best: string | null = null;
  for (const v of versions) {
    if (!parseSemver(v)) continue;
    if (best === null || compareSemver(v, best) > 0) best = v;
  }
  return best;
}
