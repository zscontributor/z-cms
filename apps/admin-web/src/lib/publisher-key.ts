/**
 * The author's marketplace identity, handled entirely in the browser.
 *
 * `signChecksum` on the server signs a SHA-256 hex string and nothing else — 64
 * bytes. That is small enough to sign here, which is what lets the Theme Editor
 * replace `zcms keygen` + `zcms pack` with a button while keeping the promise the
 * CLI makes on its own help screen: *your private key never leaves this machine*.
 *
 * The key is stored on the server, but as CIPHERTEXT THE SERVER CANNOT OPEN: it is
 * sealed under a key derived from a passphrase that never leaves this module. That
 * is the difference between "encrypted at rest" (which cms-api could still read,
 * because cms-api would hold the env key) and this. It exists because a key that
 * lived only in one browser is lost the day somebody clears their site data.
 *
 * The rules this module keeps:
 *   - The passphrase is never sent anywhere, never stored, never logged.
 *   - An unwrapped key is imported NON-EXTRACTABLE. Script on this page can ask it
 *     for a signature; it cannot walk away with the identity.
 *   - A wrong passphrase FAILS. AES-GCM's tag makes that automatic — without it, a
 *     wrong passphrase would yield garbage that might import, and the author would
 *     sign with a key nobody has heard of.
 */

/**
 * OWASP's floor for PBKDF2-SHA256. Measured at ~76ms — imperceptible for something
 * done a few times a month, which is what signing is.
 *
 * It is NOT the load-bearing control. PBKDF2 is friendly to a GPU, so a stolen blob
 * is an offline guessing problem whose cost is set by the PASSPHRASE. Iterations
 * raise the floor; the passphrase decides whether there is a ceiling. See
 * `assessPassphrase`.
 */
export const KDF_ITERATIONS = 600_000;
export const KDF_NAME = "PBKDF2-SHA256";

export interface WrappedKey {
  publicKeyPem: string;
  wrappedPrivateKey: string;
  kdfSalt: string;
  kdfIv: string;
  kdf: string;
  kdfIterations: number;
}

export class PublisherKeyError extends Error {}

/**
 * Ed25519 in WebCrypto is recent. Detected rather than assumed, because the failure
 * without a check is a thrown DOMException at the moment somebody presses Sign —
 * which reads as "the button is broken", not "your browser cannot do this".
 */
export async function supportsEd25519(): Promise<boolean> {
  if (typeof crypto === "undefined" || !crypto.subtle) return false;
  try {
    await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]);
    return true;
  } catch {
    return false;
  }
}

const b64 = {
  encode(buf: ArrayBuffer): string {
    return btoa(String.fromCharCode(...new Uint8Array(buf)));
  },
  decode(s: string): Uint8Array {
    return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  },
};

function pemFromSpki(spki: ArrayBuffer): string {
  const body = b64.encode(spki).match(/.{1,64}/g)!.join("\n");
  return `-----BEGIN PUBLIC KEY-----\n${body}\n-----END PUBLIC KEY-----\n`;
}

/** Strips the armour off any PEM. Tolerates CRLF and stray whitespace. */
function derFromPem(pem: string): Uint8Array {
  return b64.decode(pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""));
}

async function deriveKek(passphrase: string, salt: Uint8Array, iterations: number) {
  const base = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as BufferSource, iterations, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Seals a PKCS#8 key under the passphrase. The output is what the server stores. */
async function wrapPkcs8(
  pkcs8: ArrayBuffer,
  publicKeyPem: string,
  passphrase: string,
): Promise<WrappedKey> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const kek = await deriveKek(passphrase, salt, KDF_ITERATIONS);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, kek, pkcs8);

  return {
    publicKeyPem,
    wrappedPrivateKey: b64.encode(ciphertext),
    kdfSalt: b64.encode(salt.buffer as ArrayBuffer),
    kdfIv: b64.encode(iv.buffer as ArrayBuffer),
    kdf: KDF_NAME,
    kdfIterations: KDF_ITERATIONS,
  };
}

/**
 * Makes a new identity.
 *
 * The key is generated extractable — it has to be, to be wrapped — and the
 * plaintext exists only for the few lines it takes to seal it. What is kept is the
 * ciphertext; what is handed back for signing is a non-extractable import.
 */
export async function createPublisherKey(passphrase: string): Promise<WrappedKey> {
  assertStrongPassphrase(passphrase);
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;

  const pkcs8 = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
  const publicKeyPem = pemFromSpki(await crypto.subtle.exportKey("spki", pair.publicKey));
  return wrapPkcs8(pkcs8, publicKeyPem, passphrase);
}

/**
 * Adopts a key made by `zcms keygen`.
 *
 * The upgrade path, and it matters: somebody whose public key is already registered
 * at the marketplace must keep that identity. Forcing a new key would force a key
 * rotation, and a rotated key lands PENDING behind a staff review.
 */
export async function importPublisherKey(
  privateKeyPem: string,
  passphrase: string,
): Promise<WrappedKey> {
  assertStrongPassphrase(passphrase);

  if (!/BEGIN (?:PRIVATE|ENCRYPTED PRIVATE) KEY/.test(privateKeyPem)) {
    throw new PublisherKeyError(
      "That is not a private key in PEM form. It should be the file containing 'BEGIN PRIVATE KEY' — publisher-private.pem, not publisher-public.pem.",
    );
  }
  if (/ENCRYPTED PRIVATE KEY/.test(privateKeyPem)) {
    throw new PublisherKeyError(
      "That key is itself passphrase-protected. Decrypt it first: openssl pkcs8 -topk8 -nocrypt -in key.pem -out plain.pem",
    );
  }

  let priv: CryptoKey;
  try {
    priv = await crypto.subtle.importKey(
      "pkcs8",
      derFromPem(privateKeyPem) as BufferSource,
      { name: "Ed25519" },
      // Extractable, because it must be wrapped. It is re-imported
      // non-extractable for every signature after this.
      true,
      ["sign"],
    );
  } catch (err) {
    throw new PublisherKeyError(
      `That key could not be read as an Ed25519 private key: ${(err as Error).message}`,
    );
  }

  const pkcs8 = await crypto.subtle.exportKey("pkcs8", priv);
  return wrapPkcs8(pkcs8, await publicPemFromPrivate(pkcs8), passphrase);
}

/**
 * The public half, derived from the private one.
 *
 * WebCrypto will not export a public key from a private CryptoKey, so it goes via
 * JWK: for Ed25519 the JWK carries both halves (`d` and `x`), and dropping `d`
 * leaves a public key that imports cleanly. The alternative — asking the author to
 * paste publisher-public.pem as well — is a second file to get wrong, and getting
 * it wrong would register an identity whose signatures never verify.
 */
async function publicPemFromPrivate(pkcs8: ArrayBuffer): Promise<string> {
  const priv = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, true, ["sign"]);
  const jwk = (await crypto.subtle.exportKey("jwk", priv)) as JsonWebKey & { d?: string };
  delete jwk.d;
  jwk.key_ops = ["verify"];

  const pub = await crypto.subtle.importKey("jwk", jwk, { name: "Ed25519" }, true, ["verify"]);
  return pemFromSpki(await crypto.subtle.exportKey("spki", pub));
}

/**
 * Opens the stored blob and signs the checksum.
 *
 * The passphrase is taken as an argument and dropped when this returns — it is not
 * cached, because a cached passphrase is a passphrase that outlives the tab it was
 * typed into.
 */
export async function signChecksumWithVault(
  vault: WrappedKey,
  passphrase: string,
  checksum: string,
): Promise<string> {
  if (vault.kdf !== KDF_NAME) {
    throw new PublisherKeyError(`This key uses ${vault.kdf}, which this build cannot open.`);
  }

  let pkcs8: ArrayBuffer;
  try {
    const kek = await deriveKek(passphrase, b64.decode(vault.kdfSalt), vault.kdfIterations);
    pkcs8 = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: b64.decode(vault.kdfIv) as BufferSource },
      kek,
      b64.decode(vault.wrappedPrivateKey) as BufferSource,
    );
  } catch {
    // AES-GCM's tag failing IS the wrong-passphrase signal. There is no way to tell
    // it apart from a corrupted blob, and saying "wrong passphrase" is right far
    // more often than it is wrong.
    throw new PublisherKeyError("Wrong passphrase.");
  }

  // Non-extractable from here on: this page can sign, it cannot copy the key out.
  const priv = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("Ed25519", priv, new TextEncoder().encode(checksum));
  return b64.encode(sig);
}

/**
 * The control that actually decides whether a stolen blob is openable.
 *
 * Everything else in this module is arithmetic; this is the part a person can get
 * wrong. A leaked row plus "Acme2024!" is an afternoon on a GPU. A leaked row plus
 * five random words is not a thing anyone finishes.
 *
 * Length, not character classes: "P@ssw0rd!" satisfies every class rule ever
 * written and is on every list. Long passphrases are what survive.
 */
export function assessPassphrase(passphrase: string): { ok: boolean; message?: string } {
  const trimmed = passphrase.trim();
  if (trimmed.length < 12) {
    return { ok: false, message: "Too short — use at least 12 characters." };
  }
  if (/^[a-z]+$/i.test(trimmed) && trimmed.length < 20) {
    return { ok: false, message: "One word is guessable. Use several unrelated words." };
  }
  if (trimmed.length < 20) {
    return { ok: true, message: "Acceptable. Four or five unrelated words would be stronger." };
  }
  return { ok: true };
}

function assertStrongPassphrase(passphrase: string): void {
  const verdict = assessPassphrase(passphrase);
  if (!verdict.ok) throw new PublisherKeyError(verdict.message ?? "That passphrase is too weak.");
}
