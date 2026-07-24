import { describe, expect, it } from "vitest";
import { webcrypto } from "node:crypto";
import type { webcrypto as WebCryptoTypes } from "node:crypto";
import { generateKeyPair, signChecksum, verifyChecksumSignature } from "../signing";

/**
 * A publisher's private key does not have to live on a server.
 *
 * `signChecksum` signs the SHA-256 hex string — 64 bytes — and nothing else. That
 * is small enough for a BROWSER to sign, which is what lets the Theme Editor
 * replace `zcms keygen` + `zcms pack` with a button while keeping the promise the
 * CLI makes: the private key never leaves the author's machine.
 *
 * The whole design rests on one property: a signature produced the way a browser
 * produces it must verify with the Node code the marketplace runs. These tests pin
 * that property. If they ever fail, the editor's signing path is broken and the
 * only honest answer is to go back to the CLI — so they are not decoration.
 *
 * `webcrypto` here is not a stand-in for a browser. It IS the same WebCrypto API,
 * the same algorithm identifier and the same byte formats a browser uses; what is
 * being checked is the INTEROP between that API and Node's `sign`/`verify`, which
 * is exactly what would break.
 */

const subtle = webcrypto.subtle;
const enc = new TextEncoder();

/*
 * `as unknown as CryptoKeyPair` below: Node's overload for generateKey resolves to
 * CryptoKey for this algorithm's argument shape, but Ed25519 is asymmetric and it
 * returns a pair at run time (the tests below read .privateKey and pass). The cast
 * is over a types gap, not over a behavioural assumption.
 */

/** A realistic checksum: what sha256() returns for a payload. */
const CHECKSUM = "a3f1".padEnd(64, "0");

function pemFromSpki(spki: ArrayBuffer): string {
  const b64 = Buffer.from(spki).toString("base64");
  return `-----BEGIN PUBLIC KEY-----\n${b64.match(/.{1,64}/g)!.join("\n")}\n-----END PUBLIC KEY-----\n`;
}

/** Exactly what the editor does: sign the checksum string with WebCrypto. */
async function signInBrowser(
  checksum: string,
  key: WebCryptoTypes.CryptoKey,
): Promise<string> {
  return Buffer.from(await subtle.sign("Ed25519", key, enc.encode(checksum))).toString("base64");
}

describe("a browser-made signature verifies with the platform's own verifier", () => {
  it("round-trips through verifyChecksumSignature", async () => {
    const pair = (await subtle.generateKey({ name: "Ed25519" }, true, [
      "sign",
      "verify",
    ])) as unknown as WebCryptoTypes.CryptoKeyPair;
    const signature = await signInBrowser(CHECKSUM, pair.privateKey);
    const pem = pemFromSpki(await subtle.exportKey("spki", pair.publicKey));

    expect(verifyChecksumSignature(CHECKSUM, signature, pem)).toBe(true);
  });

  it("produces a 64-byte Ed25519 signature, like Node does", async () => {
    const pair = (await subtle.generateKey({ name: "Ed25519" }, true, [
      "sign",
      "verify",
    ])) as unknown as WebCryptoTypes.CryptoKeyPair;
    const signature = await signInBrowser(CHECKSUM, pair.privateKey);
    expect(Buffer.from(signature, "base64")).toHaveLength(64);
  });

  it("rejects a browser signature over a DIFFERENT checksum", async () => {
    // The signature is over the digest, and the digest is the identity of the
    // bytes. Swapping the payload after signing must not survive.
    const pair = (await subtle.generateKey({ name: "Ed25519" }, true, [
      "sign",
      "verify",
    ])) as unknown as WebCryptoTypes.CryptoKeyPair;
    const signature = await signInBrowser(CHECKSUM, pair.privateKey);
    const pem = pemFromSpki(await subtle.exportKey("spki", pair.publicKey));

    expect(verifyChecksumSignature("b".repeat(64), signature, pem)).toBe(false);
  });

  it("rejects a browser signature checked against someone else's key", async () => {
    const mine = (await subtle.generateKey({ name: "Ed25519" }, true, [
      "sign",
      "verify",
    ])) as unknown as WebCryptoTypes.CryptoKeyPair;
    const theirs = (await subtle.generateKey({ name: "Ed25519" }, true, [
      "sign",
      "verify",
    ])) as unknown as WebCryptoTypes.CryptoKeyPair;
    const signature = await signInBrowser(CHECKSUM, mine.privateKey);
    const theirPem = pemFromSpki(await subtle.exportKey("spki", theirs.publicKey));

    expect(verifyChecksumSignature(CHECKSUM, signature, theirPem)).toBe(false);
  });
});

describe("a key made by `zcms keygen` can move into a browser", () => {
  /**
   * The upgrade path. Somebody who already ran `zcms keygen` — and whose public
   * key is already registered at the marketplace — must be able to keep that
   * identity when they switch to the editor. A design that forced a new key would
   * force a key rotation, and rotated keys land PENDING behind a staff review.
   */
  it("imports the CLI's PKCS#8 PEM and signs compatibly with it", async () => {
    const cli = generateKeyPair();
    const der = Buffer.from(cli.privateKey.replace(/-----[^-]+-----|\s/g, ""), "base64");

    const imported = await subtle.importKey("pkcs8", der, { name: "Ed25519" }, false, ["sign"]);
    const browserSig = await signInBrowser(CHECKSUM, imported);

    // Same key, same checksum: the browser and the CLI must produce a signature
    // the same public key verifies. (Ed25519 is deterministic, so they are in fact
    // byte-identical — but what matters is that both verify.)
    expect(verifyChecksumSignature(CHECKSUM, browserSig, cli.publicKey)).toBe(true);
    expect(browserSig).toBe(signChecksum(CHECKSUM, cli.privateKey));
  });

  it("imports as non-extractable, so script on the page cannot steal it", async () => {
    const cli = generateKeyPair();
    const der = Buffer.from(cli.privateKey.replace(/-----[^-]+-----|\s/g, ""), "base64");
    const imported = await subtle.importKey("pkcs8", der, { name: "Ed25519" }, false, ["sign"]);

    expect(imported.extractable).toBe(false);
    // The point of `extractable: false`: XSS on the admin can ASK for a signature,
    // but it cannot walk away with the identity. Those are very different bad days.
    await expect(subtle.exportKey("pkcs8", imported)).rejects.toThrow();
  });
});

describe("a passphrase-wrapped key survives a lost browser", () => {
  /**
   * The key is stored as ciphertext the server cannot open: PBKDF2 over a
   * passphrase that never leaves the browser, AES-GCM around the PKCS#8 bytes.
   * cms-api holds 64 opaque bytes; compromising it yields an offline guessing
   * problem, not a key.
   */
  const ITERATIONS = 600_000;

  async function kek(passphrase: string, salt: Uint8Array): Promise<WebCryptoTypes.CryptoKey> {
    const base = await subtle.importKey("raw", enc.encode(passphrase), "PBKDF2", false, [
      "deriveKey",
    ]);
    return subtle.deriveKey(
      { name: "PBKDF2", salt, iterations: ITERATIONS, hash: "SHA-256" },
      base,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
  }

  async function wrap(passphrase: string) {
    const pair = (await subtle.generateKey({ name: "Ed25519" }, true, [
      "sign",
      "verify",
    ])) as unknown as WebCryptoTypes.CryptoKeyPair;
    const pkcs8 = await subtle.exportKey("pkcs8", pair.privateKey);
    const salt = webcrypto.getRandomValues(new Uint8Array(16));
    const iv = webcrypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await subtle.encrypt(
      { name: "AES-GCM", iv },
      await kek(passphrase, salt),
      pkcs8,
    );
    const pem = pemFromSpki(await subtle.exportKey("spki", pair.publicKey));
    return { ciphertext, salt, iv, pem };
  }

  it("recovers the identity on another machine from the passphrase alone", async () => {
    const { ciphertext, salt, iv, pem } = await wrap("correct horse battery staple");

    // A different browser: it has the stored blob and nothing else.
    const plain = await subtle.decrypt(
      { name: "AES-GCM", iv },
      await kek("correct horse battery staple", salt),
      ciphertext,
    );
    const recovered = await subtle.importKey("pkcs8", plain, { name: "Ed25519" }, false, ["sign"]);

    expect(recovered.extractable).toBe(false);
    expect(verifyChecksumSignature(CHECKSUM, await signInBrowser(CHECKSUM, recovered), pem)).toBe(
      true,
    );
  });

  it("refuses a wrong passphrase instead of producing a broken key", async () => {
    const { ciphertext, salt, iv } = await wrap("the real passphrase");
    // AES-GCM's tag is what makes this fail CLOSED. Without authentication, a wrong
    // passphrase would yield garbage bytes that importKey might accept, and the
    // author would sign with a key nobody has ever heard of — a package rejected
    // at the marketplace for a reason nothing on screen could explain.
    await expect(
      subtle.decrypt({ name: "AES-GCM", iv }, await kek("wrong", salt), ciphertext),
    ).rejects.toThrow();
  });
});
