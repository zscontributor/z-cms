/**
 * The Z-CMS package format.
 *
 * A `.zcms` file is a gzipped tar containing exactly what a theme or plugin
 * needs to run — its manifest, its built bundle, its assets — and nothing else.
 * No source, no node_modules, no install scripts. A package is data, not a
 * program that runs on install.
 *
 * Signatures travel with it, and they answer different questions:
 *
 *   publisher signature   — "who wrote this?"        (the author's private key)
 *   marketplace signature — "did we let this in?"    (Z-SOFT's private key)
 *   operator signature    — "did THIS instance's operator vouch for this?"
 *                                                     (the operator's private key)
 *
 * The runtimes verify a signature against a public key pinned in their own config —
 * not one fetched from the API. That is what preserves the property we already had
 * when bundles lived on disk: a compromised cms-api cannot make a runtime execute
 * code, because it cannot forge the signature. WHICH key is pinned depends on how
 * the package reached the runtime, and that route is decided by the caller, never
 * read off the envelope — see `verifyPackage`, `verifyFirstParty`, `verifyOperator`.
 *
 * The three signatures are mutually exclusive in practice: a built-in is signed by
 * the first party, a marketplace package is counter-signed by the marketplace, and
 * an operator sideload is signed by the operator. A package presenting the wrong
 * signature for the track it arrives on is refused, not retried against another key.
 */

export type PackageKind = "theme" | "plugin";

/**
 * Which pinned key a downloaded package is verified against — the trust route.
 *
 * The distinction exists so that a caller MUST name the route it is on, at the call
 * site, rather than have the loader guess from what the envelope happens to contain.
 * A marketplace package is checked against the marketplace key; an operator sideload
 * against the operator key. There is no fallback from one to the other: a package
 * that fails its route's check is refused, never retried against the other key.
 * (Built-ins take neither route — they are verified separately by `verifyFirstParty`
 * before they are ever downloaded.)
 */
export type PackageTrust = "marketplace" | "operator";

export interface PackageManifest {
  /** Reverse-DNS id, e.g. "vn.zsoft.theme.corporate". */
  id: string;
  name: string;
  version: string;
  kind: PackageKind;
  description?: string;
  author: { name: string; url?: string };
  engine: string;
  /** Entry file inside the package, relative to its root. */
  entry: string;
  [key: string]: unknown;
}

/**
 * The signed envelope. Note what is signed: the DIGEST of the archive, not the
 * archive itself — so verification is cheap and the bytes can be streamed to
 * storage while the signature is checked.
 */
export interface PackageEnvelope {
  /** SHA-256 of the tar.gz payload, hex. */
  checksum: string;
  manifest: PackageManifest;
  /** Ed25519 signature over `checksum`, base64. */
  publisherSignature: string;
  /** Publisher's Ed25519 public key, SPKI PEM. */
  publisherKey: string;
  /** Added by the marketplace on acceptance. Absent until then. */
  marketplaceSignature?: string;
  /**
   * Added when an operator sideloads a package into their own instance — either by
   * signing it offline (`zcms pack --operator-key`) or by having cms-api sign it on
   * their behalf. Ed25519 over `checksum`, base64. Absent on marketplace and
   * first-party packages; a package never carries both this and a marketplace
   * signature, because the two describe different, non-overlapping trust routes.
   */
  operatorSignature?: string;
}

export interface SignedPackage {
  envelope: PackageEnvelope;
  /** The tar.gz bytes. */
  payload: Buffer;
}

export class PackageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PackageError";
  }
}
