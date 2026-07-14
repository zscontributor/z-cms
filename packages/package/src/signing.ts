import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as edSign,
  verify as edVerify,
} from "node:crypto";
import { PackageError, type PackageEnvelope } from "./types";

/**
 * Ed25519, not RSA: small keys, small signatures, no parameter choices to get
 * wrong. Node signs Ed25519 with `sign(null, ...)` — the algorithm has its own
 * hashing built in, so passing a digest name here would be an error, not a
 * hardening.
 */

export interface KeyPair {
  /** PKCS#8 PEM. Keep this secret. */
  privateKey: string;
  /** SPKI PEM. Safe to publish; this is what verifiers pin. */
  publicKey: string;
}

export function generateKeyPair(): KeyPair {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

export function sha256(payload: Buffer): string {
  return createHash("sha256").update(payload).digest("hex");
}

/** Signs the archive's digest. The digest IS the identity of the bytes. */
export function signChecksum(checksum: string, privateKeyPem: string): string {
  try {
    const key = createPrivateKey(privateKeyPem);
    return edSign(null, Buffer.from(checksum, "utf8"), key).toString("base64");
  } catch (err) {
    throw new PackageError(`Could not sign the package: ${(err as Error).message}`);
  }
}

export function verifyChecksumSignature(
  checksum: string,
  signature: string,
  publicKeyPem: string,
): boolean {
  try {
    const key = createPublicKey(publicKeyPem);
    return edVerify(
      null,
      Buffer.from(checksum, "utf8"),
      key,
      Buffer.from(signature, "base64"),
    );
  } catch {
    // A malformed key or signature is a failed verification, not a crash. This
    // input came from a stranger.
    return false;
  }
}

/**
 * The gate every runtime passes a package through before executing a byte of it.
 *
 * Order matters, and it is the opposite of the convenient one:
 *
 *   1. hash the bytes we actually have
 *   2. check they match the checksum in the envelope
 *   3. check the MARKETPLACE signed that checksum, with a key we already trusted
 *
 * Step 3 uses a public key pinned in the runtime's own config, never one that
 * travelled with the package or came back from an API. Otherwise an attacker who
 * can serve a package can also serve the key that vouches for it, and the whole
 * exercise verifies nothing.
 */
export function verifyPackage(
  envelope: PackageEnvelope,
  payload: Buffer,
  marketplacePublicKeyPem: string,
): void {
  const actual = sha256(payload);
  if (actual !== envelope.checksum) {
    throw new PackageError(
      `Checksum mismatch — the package has been modified.\n  declared: ${envelope.checksum}\n  actual  : ${actual}`,
    );
  }

  if (!envelope.marketplaceSignature) {
    throw new PackageError(
      "Package has not been signed by the marketplace. A runtime only runs reviewed packages.",
    );
  }

  const ok = verifyChecksumSignature(
    envelope.checksum,
    envelope.marketplaceSignature,
    marketplacePublicKeyPem,
  );

  if (!ok) {
    throw new PackageError(
      "Invalid marketplace signature. This package was not released by Z-CMS.",
    );
  }
}

/**
 * The gate a BUILT-IN package passes through: signed by a publisher we pinned.
 *
 * Built-ins do not go through the marketplace — they ship inside the image, so
 * there is no counter-signature and no review queue to wait on. That used to mean
 * they were simply *trusted*: the runtime read `dist/index.js` off the volume and
 * ran it. Which is fine right up until the volume is not what you thought it was —
 * a bad image layer, a mounted host path, a compromised CI step, an operator with
 * a text editor. The code that runs first-party is the code with the most
 * privilege, and it was the only code nobody checked.
 *
 * So it is checked, against a key pinned in this process's config. The difference
 * from `verifyPublisher` below is the whole point: that one verifies against
 * `envelope.publisherKey`, the key that *travelled inside the package*, which is
 * exactly what the marketplace must do (it looks the key up in its own registry
 * afterwards). Here there is no registry to look anything up in, so trusting the
 * package's own key would be trusting the attacker's own key. The pinned key is
 * the only key.
 */
export function verifyFirstParty(
  envelope: PackageEnvelope,
  payload: Buffer,
  pinnedPublisherKeyPem: string,
): void {
  if (!pinnedPublisherKeyPem) {
    throw new PackageError(
      "No first-party public key is pinned — refusing to run an unverified built-in package.",
    );
  }

  const actual = sha256(payload);
  if (actual !== envelope.checksum) {
    throw new PackageError(
      `Checksum mismatch — the built-in package has been modified.\n  declared: ${envelope.checksum}\n  actual  : ${actual}`,
    );
  }

  // Deliberately NOT envelope.publisherKey. A package that carries the key that
  // vouches for it vouches for nothing.
  const ok = verifyChecksumSignature(
    envelope.checksum,
    envelope.publisherSignature,
    pinnedPublisherKeyPem,
  );

  if (!ok) {
    throw new PackageError(
      "Invalid first-party signature. This built-in package was not published by the operator of this instance.",
    );
  }
}

/**
 * The gate a SIDELOADED package passes through: signed by this instance's operator.
 *
 * A self-hosted operator who cannot — or will not — reach the marketplace still
 * needs a way to run code they wrote themselves. So there is a third trust anchor,
 * pinned in the runtime's own config exactly like the first-party key: the operator
 * key. A package the operator signed (offline with `zcms pack --operator-key`, or by
 * cms-api on their behalf) carries `operatorSignature`, and this checks it against
 * the pinned operator public key.
 *
 * It is a near-exact mirror of `verifyFirstParty`, and the symmetry is the point:
 * both answer "did the holder of a key I pinned sign these exact bytes?", neither
 * trusts anything that travelled inside the package. The ONLY differences are which
 * field carries the signature (`operatorSignature`, not `publisherSignature`) and
 * which pinned key checks it. Keeping them as two functions rather than one
 * parameterised call is deliberate: the caller must state, at the call site, which
 * trust anchor it is invoking — the routing decision is not allowed to hide inside a
 * variable, and it is never read from the envelope. A package with only a
 * marketplace signature reaching this function fails, and must: it arrived on the
 * wrong track.
 */
export function verifyOperator(
  envelope: PackageEnvelope,
  payload: Buffer,
  pinnedOperatorKeyPem: string,
): void {
  if (!pinnedOperatorKeyPem) {
    throw new PackageError(
      "No operator public key is pinned — refusing to run an unverified sideloaded package.",
    );
  }

  const actual = sha256(payload);
  if (actual !== envelope.checksum) {
    throw new PackageError(
      `Checksum mismatch — the sideloaded package has been modified.\n  declared: ${envelope.checksum}\n  actual  : ${actual}`,
    );
  }

  if (!envelope.operatorSignature) {
    throw new PackageError(
      "This package carries no operator signature. It did not arrive by the sideload route and will not be run as one.",
    );
  }

  // Deliberately NOT envelope.publisherKey — same reasoning as verifyFirstParty.
  const ok = verifyChecksumSignature(
    envelope.checksum,
    envelope.operatorSignature,
    pinnedOperatorKeyPem,
  );

  if (!ok) {
    throw new PackageError(
      "Invalid operator signature. This sideloaded package was not signed by the operator of this instance.",
    );
  }
}

/** What the marketplace does on accept: verify the author, then vouch for it. */
export function verifyPublisher(envelope: PackageEnvelope, payload: Buffer): void {
  const actual = sha256(payload);
  if (actual !== envelope.checksum) {
    throw new PackageError("Checksum does not match the package contents.");
  }

  const ok = verifyChecksumSignature(
    envelope.checksum,
    envelope.publisherSignature,
    envelope.publisherKey,
  );

  if (!ok) {
    throw new PackageError("Invalid publisher signature.");
  }
}
