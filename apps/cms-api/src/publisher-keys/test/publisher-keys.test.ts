import { describe, expect, it } from "vitest";
import { BadRequestException } from "@nestjs/common";
import { generateKeyPairSync } from "node:crypto";
import {
  MIN_KDF_ITERATIONS,
  SUPPORTED_KDFS,
  assertEd25519PublicKey,
} from "../publisher-keys.module";

/**
 * The vault holds an author's marketplace identity, and the one thing this module
 * actually decides is whether a PEM is the right half of a keypair.
 *
 * That decision is worth a suite of its own. `zcms keygen` writes two files whose
 * names differ by one word, this endpoint is labelled "your key", and the failure
 * mode of getting it wrong is not a validation error — it is a signing key sitting
 * in a database in the clear, with nothing on screen to say so.
 */

function ed25519() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

describe("assertEd25519PublicKey", () => {
  it("accepts the public key `zcms keygen` writes", () => {
    expect(() => assertEd25519PublicKey(ed25519().publicKeyPem)).not.toThrow();
  });

  it("catches a PRIVATE key and says it is burned", () => {
    // The whole reason this function exists. Somebody will paste the wrong file,
    // and "invalid PEM" would send them looking for a formatting mistake instead of
    // rotating the key they just leaked into a form.
    const { privateKeyPem } = ed25519();
    expect(() => assertEd25519PublicKey(privateKeyPem)).toThrow(BadRequestException);
    expect(() => assertEd25519PublicKey(privateKeyPem)).toThrow(/PRIVATE key/);
    expect(() => assertEd25519PublicKey(privateKeyPem)).toThrow(/burned/);
  });

  it("checks for a private key BEFORE checking the shape", () => {
    // Order matters: a private PEM also fails "is this a public key", and if that
    // ran first the person would be told the wrong thing about the worse mistake.
    // Even a CORRUPT private key must be reported as a leaked private key — by the
    // time it reaches a form, it has already been in a browser.
    //
    // Derived from a real key at run time rather than written as a literal: a PEM
    // header for a private key, spelled out in source, trips the secret scanner —
    // and the right fix is not to teach it to ignore that header in test files,
    // because a test file is exactly where a real key would hide.
    const corrupt = ed25519().privateKeyPem.replace(/\n[A-Za-z0-9+/=\n]+\n/, "\nnot-base64\n");
    expect(() => assertEd25519PublicKey(corrupt)).toThrow(/PRIVATE key/);
  });

  it("rejects a key that is not a public key at all", () => {
    expect(() => assertEd25519PublicKey("hello")).toThrow(/not a public key/);
  });

  it("rejects a public key of the wrong algorithm, naming it", () => {
    // The platform signs with Ed25519 and nothing else. An RSA key would store
    // fine and fail at the far end of a build, on a screen that could not say why.
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = rsa.publicKey.export({ type: "spki", format: "pem" }).toString();
    expect(() => assertEd25519PublicKey(pem)).toThrow(/Ed25519/);
    expect(() => assertEd25519PublicKey(pem)).toThrow(/rsa/);
  });

  it("rejects an unreadable public key rather than storing it", () => {
    expect(() =>
      assertEd25519PublicKey("-----BEGIN PUBLIC KEY-----\nnope\n-----END PUBLIC KEY-----"),
    ).toThrow(BadRequestException);
  });
});

describe("key derivation floor", () => {
  it("knows only the KDF the browser actually uses", () => {
    expect(SUPPORTED_KDFS.has("PBKDF2-SHA256")).toBe(true);
    // A vault claiming a KDF this build cannot run would be a blob nobody can open.
    expect(SUPPORTED_KDFS.has("scrypt")).toBe(false);
    expect(SUPPORTED_KDFS.has("none")).toBe(false);
  });

  it("sets a floor high enough that the wrapping is not decorative", () => {
    // The floor stops a client asking for `iterations: 1`. It is NOT the real
    // control — a stolen row is an offline guessing problem whose cost is set by
    // the passphrase, and that is enforced in the browser. This only stops the
    // wrapping being theatre.
    expect(MIN_KDF_ITERATIONS).toBeGreaterThanOrEqual(100_000);
  });
});
