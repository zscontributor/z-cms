import { describe, expect, it } from "vitest";
import { createPublicKey, generateKeyPairSync, verify as edVerify } from "node:crypto";
import {
  KDF_ITERATIONS,
  PublisherKeyError,
  assessPassphrase,
  createPublisherKey,
  importPublisherKey,
  signChecksumWithVault,
} from "../publisher-key";

/**
 * This module holds the author's marketplace identity. The tests that matter are
 * the ones about what it REFUSES, and the one that proves a signature made here is
 * a signature the platform accepts — because if that ever stops being true, the
 * editor's Sign button is a lie and the CLI is the only honest path.
 *
 * `verifyEd25519` below is deliberately Node's own crypto, not WebCrypto: it is the
 * same call `verifyChecksumSignature` makes in @zcmsorg/package, which is what the
 * marketplace runs. Checking a browser signature with a browser verifier would
 * prove only that this module agrees with itself.
 */

const PASSPHRASE = "correct horse battery staple";
const CHECKSUM = "a3f1".padEnd(64, "0");

function verifyEd25519(checksum: string, signatureB64: string, publicKeyPem: string): boolean {
  return edVerify(
    null,
    Buffer.from(checksum, "utf8"),
    createPublicKey(publicKeyPem),
    Buffer.from(signatureB64, "base64"),
  );
}

describe("createPublisherKey", () => {
  it("produces a vault whose signature the platform's verifier accepts", async () => {
    const vault = await createPublisherKey(PASSPHRASE);
    const signature = await signChecksumWithVault(vault, PASSPHRASE, CHECKSUM);
    expect(verifyEd25519(CHECKSUM, signature, vault.publicKeyPem)).toBe(true);
  });

  it("records the KDF parameters so an old blob still opens later", async () => {
    // The cost per guess has to rise over time. A stored parameter is what lets a
    // key wrapped today still open after the default moves.
    const vault = await createPublisherKey(PASSPHRASE);
    expect(vault.kdf).toBe("PBKDF2-SHA256");
    expect(vault.kdfIterations).toBe(KDF_ITERATIONS);
  });

  it("uses a fresh salt and IV for every key", async () => {
    const a = await createPublisherKey(PASSPHRASE);
    const b = await createPublisherKey(PASSPHRASE);
    // Same passphrase, different salt → different derived key → a precomputed
    // table against one vault is worthless against the other.
    expect(a.kdfSalt).not.toBe(b.kdfSalt);
    expect(a.kdfIv).not.toBe(b.kdfIv);
    expect(a.wrappedPrivateKey).not.toBe(b.wrappedPrivateKey);
  });

  it("stores no plaintext key material", async () => {
    const vault = await createPublisherKey(PASSPHRASE);
    const blob = JSON.stringify(vault);
    // What goes to the server must be openable by nobody there.
    expect(blob).not.toContain("PRIVATE KEY");
    expect(blob).not.toContain(PASSPHRASE);
  });

  it("refuses a weak passphrase instead of wrapping under it", async () => {
    await expect(createPublisherKey("hunter2")).rejects.toThrow(PublisherKeyError);
  });
});

describe("signChecksumWithVault", () => {
  it("recovers the identity from the blob and the passphrase alone", async () => {
    const vault = await createPublisherKey(PASSPHRASE);
    // Simulates another machine: it has the stored blob and nothing else — no
    // IndexedDB, no file. This is the whole reason the vault exists.
    const roundTripped = JSON.parse(JSON.stringify(vault));
    const signature = await signChecksumWithVault(roundTripped, PASSPHRASE, CHECKSUM);
    expect(verifyEd25519(CHECKSUM, signature, vault.publicKeyPem)).toBe(true);
  });

  it("says 'wrong passphrase' rather than producing a broken signature", async () => {
    const vault = await createPublisherKey(PASSPHRASE);
    // AES-GCM's tag is what makes this fail closed. Unauthenticated, a wrong
    // passphrase would yield garbage that might import — and the author would sign
    // with a key nobody has heard of, and learn about it from a rejection days later.
    await expect(signChecksumWithVault(vault, "not the passphrase", CHECKSUM)).rejects.toThrow(
      /Wrong passphrase/,
    );
  });

  it("refuses a vault wrapped with a KDF this build does not know", async () => {
    const vault = await createPublisherKey(PASSPHRASE);
    await expect(
      signChecksumWithVault({ ...vault, kdf: "scrypt" }, PASSPHRASE, CHECKSUM),
    ).rejects.toThrow(/cannot open/);
  });

  it("signs the checksum it was given, and nothing else", async () => {
    const vault = await createPublisherKey(PASSPHRASE);
    const signature = await signChecksumWithVault(vault, PASSPHRASE, CHECKSUM);
    // The digest IS the identity of the bytes: a signature that verified against a
    // different checksum would let the payload be swapped after signing.
    expect(verifyEd25519("b".repeat(64), signature, vault.publicKeyPem)).toBe(false);
  });
});

describe("importPublisherKey — the `zcms keygen` upgrade path", () => {
  function cliKeypair() {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    return {
      privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    };
  }

  it("keeps the identity a marketplace already knows", async () => {
    const cli = cliKeypair();
    const vault = await importPublisherKey(cli.privateKeyPem, PASSPHRASE);

    // The derived public key must be the SAME one already registered upstream —
    // otherwise adopting the editor would silently force a key rotation, and a
    // rotated key lands PENDING behind a staff review.
    expect(vault.publicKeyPem.replace(/\s/g, "")).toBe(cli.publicKeyPem.replace(/\s/g, ""));

    const signature = await signChecksumWithVault(vault, PASSPHRASE, CHECKSUM);
    expect(verifyEd25519(CHECKSUM, signature, cli.publicKeyPem)).toBe(true);
  });

  it("names the mistake when handed the PUBLIC key by accident", async () => {
    // `zcms keygen` writes two files whose names differ by one word. Somebody will
    // paste the wrong one, and "invalid key" would send them looking in the wrong
    // place.
    const cli = cliKeypair();
    await expect(importPublisherKey(cli.publicKeyPem, PASSPHRASE)).rejects.toThrow(
      /publisher-private\.pem/,
    );
  });

  it("explains how to decrypt an already-encrypted key rather than failing opaquely", async () => {
    const encrypted =
      "-----BEGIN ENCRYPTED PRIVATE KEY-----\nMIIB\n-----END ENCRYPTED PRIVATE KEY-----\n";
    await expect(importPublisherKey(encrypted, PASSPHRASE)).rejects.toThrow(/openssl/);
  });

  it("rejects a non-Ed25519 key", async () => {
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = rsa.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    await expect(importPublisherKey(pem, PASSPHRASE)).rejects.toThrow(PublisherKeyError);
  });
});

describe("assessPassphrase", () => {
  it("rejects short passphrases", () => {
    expect(assessPassphrase("short").ok).toBe(false);
  });

  it("rejects a single long-ish word", () => {
    expect(assessPassphrase("antidisestablish").ok).toBe(false);
  });

  it("accepts several unrelated words without nagging", () => {
    expect(assessPassphrase("correct horse battery staple")).toEqual({ ok: true });
  });

  it("accepts but nudges a merely-adequate passphrase", () => {
    const verdict = assessPassphrase("blue tree 91 lamp");
    expect(verdict.ok).toBe(true);
    expect(verdict.message).toBeDefined();
  });

  it("does not mistake character classes for strength", () => {
    // "P@ssw0rd!" satisfies every class rule ever written and is on every list.
    // Length is what survives; this must not pass on punctuation alone.
    expect(assessPassphrase("P@ssw0rd!").ok).toBe(false);
  });
});
