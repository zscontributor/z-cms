import { createHash } from "node:crypto";
import { signChecksum, verifyChecksumSignature } from "./signing";
import type { PackageKind } from "./types";

/**
 * The revocation list: how a marketplace reaches code it has already handed out.
 *
 * `review(reject)` closes the door to new installs and does nothing about the
 * copies already running. Revoking on the marketplace's own instance moves that
 * instance's sites and purges that instance's runtimes — and does nothing about
 * the thousand OTHER instances that installed the package last month. Without
 * this file, a kill switch only kills code on the machine that pulled the lever.
 *
 * Every delisting-only plugin directory has exactly this hole: a plugin closed for
 * a critical vulnerability is removed from the catalogue, and the sites that
 * already installed it keep serving it, silently, forever. The only channel that
 * reaches an installed site is the update check — which is why this is modelled on
 * the update check and not on the delisting.
 *
 * The difference is that those update channels are unsigned (their trust is "we
 * fetched it over TLS from the right-looking host"), and a revocation list that an
 * attacker can forge is worse than none at all: it is a remote uninstall button
 * for anyone who can answer a DNS query. So the list is signed by the marketplace
 * and verified against the key each instance has **pinned in its own config** —
 * the same key, and the same argument, as the packages themselves.
 */
export interface Revocation {
  kind: PackageKind;
  key: string;
  version: string;
  reason: string;
  /** When the marketplace pulled it. */
  revokedAt: string;
}

export interface RevocationList {
  /**
   * When this snapshot was generated.
   *
   * A consumer keeps the newest `issuedAt` it has accepted and refuses anything
   * older, so a captured-and-replayed old list cannot roll an instance back to a
   * time before a revocation existed.
   */
  issuedAt: string;
  /** Every revoked version the marketplace knows about. A full snapshot, not a delta. */
  revoked: Revocation[];
}

export interface SignedRevocationList extends RevocationList {
  /** SHA-256 of the canonical form. Advisory: a consumer MUST recompute it. */
  digest: string;
  /** Ed25519 by the marketplace, over the digest. */
  signature: string;
}

/**
 * The bytes that get signed.
 *
 * Two instances must derive the same digest from the same list, so the encoding
 * cannot depend on the order a database happened to return rows in, or on how a
 * JSON serialiser felt about key order. Entries are sorted and fields are written
 * positionally — a canonical form, for the same reason packing zeroes mtimes.
 */
function canonical(list: RevocationList): string {
  const rows = [...list.revoked]
    .sort(
      (a, b) =>
        a.kind.localeCompare(b.kind) ||
        a.key.localeCompare(b.key) ||
        a.version.localeCompare(b.version),
    )
    .map((r) => [r.kind, r.key, r.version, r.revokedAt, r.reason]);
  return JSON.stringify({ issuedAt: list.issuedAt, revoked: rows });
}

export function revocationDigest(list: RevocationList): string {
  return createHash("sha256").update(canonical(list), "utf8").digest("hex");
}

export function signRevocationList(
  list: RevocationList,
  marketplacePrivateKeyPem: string,
): SignedRevocationList {
  const digest = revocationDigest(list);
  return { ...list, digest, signature: signChecksum(digest, marketplacePrivateKeyPem) };
}

export class RevocationError extends Error {}

/**
 * Checks a list the way a consumer must: assume every field in it is hostile.
 *
 * The digest carried in the document is **recomputed, never trusted** — the same
 * rule the package pipeline follows for the payload checksum. Trusting the
 * attached digest would mean an attacker signs a digest of their choosing and
 * ships whatever list they like beside it.
 *
 * `notOlderThan` is the rollback defence. Enforcement is additive — nothing here
 * ever un-revokes, by design — so a replayed old list cannot resurrect pulled
 * code. It is still refused: an instance that keeps accepting last month's
 * snapshot is an instance that will never hear about tomorrow's revocation, and
 * that silence is what an attacker who can hold the connection open is buying.
 */
export function verifyRevocationList(
  doc: unknown,
  marketplacePublicKeyPem: string,
  notOlderThan?: Date,
): RevocationList {
  if (!doc || typeof doc !== "object") {
    throw new RevocationError("The revocation list is not an object.");
  }
  const candidate = doc as Partial<SignedRevocationList>;

  if (typeof candidate.issuedAt !== "string" || !Array.isArray(candidate.revoked)) {
    throw new RevocationError("The revocation list is malformed.");
  }
  if (typeof candidate.signature !== "string" || candidate.signature.length === 0) {
    throw new RevocationError("The revocation list is not signed.");
  }

  const issuedAt = new Date(candidate.issuedAt);
  if (Number.isNaN(issuedAt.getTime())) {
    throw new RevocationError("The revocation list has no valid issue date.");
  }

  const revoked: Revocation[] = candidate.revoked.map((row, index) => {
    const r = row as Partial<Revocation>;
    if (
      (r.kind !== "theme" && r.kind !== "plugin") ||
      typeof r.key !== "string" ||
      typeof r.version !== "string" ||
      typeof r.revokedAt !== "string"
    ) {
      throw new RevocationError(`Revocation #${index} is malformed.`);
    }
    return {
      kind: r.kind,
      key: r.key,
      version: r.version,
      revokedAt: r.revokedAt,
      reason: typeof r.reason === "string" ? r.reason : "",
    };
  });

  const list: RevocationList = { issuedAt: candidate.issuedAt, revoked };

  // Recomputed from the content — the `digest` field on the wire is decoration.
  const digest = revocationDigest(list);
  if (!verifyChecksumSignature(digest, candidate.signature, marketplacePublicKeyPem)) {
    throw new RevocationError(
      "The revocation list was not signed by the marketplace this instance pins.",
    );
  }

  if (notOlderThan && issuedAt < notOlderThan) {
    throw new RevocationError(
      `The revocation list is a rollback: it was issued ${issuedAt.toISOString()}, ` +
        `older than the ${notOlderThan.toISOString()} snapshot already accepted.`,
    );
  }

  return list;
}
