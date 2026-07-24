import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Symmetric encryption for the secrets the database has no choice but to hold.
 *
 * Most secrets can be hashed — a password is only ever compared, never read back.
 * A few cannot: a TOTP shared secret has to be recomputed on every login, and an
 * SMTP password has to be presented to the mail server. Those are the ones this
 * exists for, and they are exactly the ones a database dump would otherwise hand
 * over intact.
 *
 * AES-256-GCM: authenticated, so a tampered ciphertext fails loudly instead of
 * decrypting to a different plaintext. The IV is random per encryption and stored
 * next to the ciphertext — it is not secret, it only has to be unique.
 *
 * Format: `v1.<iv>.<tag>.<ciphertext>`, all base64url. The version prefix is there
 * so a future key rotation or cipher change can be *told apart* from this one
 * rather than guessed at from the length.
 *
 * The key lives in the environment, never in the database. That is the entire
 * premise: an attacker with a dump and no key has ciphertext, and an attacker with
 * both has already owned the host.
 */

const CIPHER = "aes-256-gcm";
const IV_BYTES = 12;

const toPart = (value: string | Buffer): string =>
  typeof value === "string" ? value : value.toString("base64url");

const fromPart = (value: string): Buffer => Buffer.from(value, "base64url");

/**
 * 32 bytes, from base64 or hex. Anything else is a misconfiguration, loudly —
 * a short key that silently worked would be the worst outcome available.
 */
export function readKey(raw: string | undefined, envName: string): Buffer {
  if (!raw) throw new MissingEncryptionKeyError(envName);

  const key = /^[0-9a-f]{64}$/i.test(raw)
    ? Buffer.from(raw, "hex")
    : Buffer.from(raw, "base64");

  if (key.length !== 32) {
    throw new Error(
      `${envName} must decode to 32 bytes, got ${key.length}. ` +
        "Give it 32 random bytes as base64 or hex.",
    );
  }
  return key;
}

export class MissingEncryptionKeyError extends Error {
  constructor(envName: string) {
    super(
      `${envName} is not set. This secret is stored encrypted, so the API refuses ` +
        "to handle it without a key. Generate one with:\n\n" +
        "    node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"\n\n" +
        "Set it once and keep it: rotating this key makes everything encrypted " +
        "under the old one undecryptable.",
    );
    this.name = "MissingEncryptionKeyError";
  }
}

export function encryptSecret(secret: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(CIPHER, key, iv);
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return ["v1", iv, tag, ciphertext].map(toPart).join(".");
}

export function decryptSecret(stored: string, key: Buffer): string {
  const [version, iv, tag, ciphertext] = stored.split(".");
  if (version !== "v1") {
    throw new Error(`Unknown encrypted secret format "${version}".`);
  }

  const decipher = createDecipheriv(CIPHER, key, fromPart(iv));
  decipher.setAuthTag(fromPart(tag));

  // Throws if the tag does not match — which is the point: a tampered or
  // wrong-key ciphertext must fail, not decrypt into a secret that lets nobody in
  // and no one understand why.
  return Buffer.concat([decipher.update(fromPart(ciphertext)), decipher.final()]).toString(
    "utf8",
  );
}
