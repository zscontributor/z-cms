import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import {
  base32Decode,
  base32Encode,
  codeForStep,
  currentStep,
  decryptSecret,
  encryptSecret,
  generateSecret,
  otpauthUrl,
  readEncryptionKey,
  TotpKeyMissingError,
  verifyCode,
} from "../totp";

/**
 * A hand-rolled TOTP is only worth having if it is provably the same TOTP every
 * authenticator app implements — otherwise it is six digits that agree with
 * nothing. That is what the RFC vectors below are for: they are the contract with
 * Google Authenticator, 1Password and every other app a user will actually reach
 * for, and they are the reason this file exists.
 */

const KEY = randomBytes(32);

describe("base32", () => {
  it("round-trips arbitrary bytes", () => {
    for (let i = 0; i < 50; i++) {
      const bytes = randomBytes(1 + (i % 32));
      expect(base32Decode(base32Encode(bytes))).toEqual(bytes);
    }
  });

  it("accepts what a human actually pastes: lowercase, padding, spaces", () => {
    const canonical = base32Encode(Buffer.from("12345678901234567890"));

    expect(base32Decode(canonical.toLowerCase())).toEqual(base32Decode(canonical));
    expect(base32Decode(`${canonical}====`)).toEqual(base32Decode(canonical));
    expect(base32Decode(canonical.replace(/(.{4})/g, "$1 "))).toEqual(base32Decode(canonical));
  });

  it("refuses a character that is not base32", () => {
    expect(() => base32Decode("ABC1")).toThrow();
  });
});

describe("codeForStep — RFC 6238 test vectors", () => {
  /**
   * RFC 6238 Appendix B, the SHA-1 rows. The seed there is the ASCII string
   * "12345678901234567890" used directly as the HMAC key; authenticator apps take
   * it base32-encoded, which is the only translation done here.
   */
  const SECRET = base32Encode(Buffer.from("12345678901234567890", "ascii"));

  const VECTORS: [unixSeconds: number, code: string][] = [
    [59, "287082"],
    [1111111109, "081804"],
    [1111111111, "050471"],
    [1234567890, "005924"],
    [2000000000, "279037"],
    [20000000000, "353130"],
  ];

  it.each(VECTORS)("at t=%i produces %s", (seconds, expected) => {
    expect(codeForStep(SECRET, Math.floor(seconds / 30))).toBe(expected);
  });

  it("keeps the leading zero — a code is a string, not a number", () => {
    // "005924" as a number is 5924, and an authenticator showing 5924 would be
    // wrong. This is the bug the string type exists to prevent.
    const code = codeForStep(SECRET, Math.floor(1234567890 / 30));
    expect(code).toHaveLength(6);
    expect(code.startsWith("00")).toBe(true);
  });
});

describe("verifyCode", () => {
  const secret = generateSecret();
  const now = 1_700_000_000_000;
  const step = currentStep(now);

  it("accepts the current code and returns the step it matched", () => {
    expect(verifyCode(secret, codeForStep(secret, step), { at: now })).toBe(step);
  });

  it("tolerates one step of clock skew, either way", () => {
    expect(verifyCode(secret, codeForStep(secret, step - 1), { at: now })).toBe(step - 1);
    expect(verifyCode(secret, codeForStep(secret, step + 1), { at: now })).toBe(step + 1);
  });

  it("does not tolerate two", () => {
    // Every extra step of tolerance is another window an attacker gets to land a
    // guess in, and 90 seconds has never been the difference between a person
    // logging in and not.
    expect(verifyCode(secret, codeForStep(secret, step - 2), { at: now })).toBeNull();
    expect(verifyCode(secret, codeForStep(secret, step + 2), { at: now })).toBeNull();
  });

  it("rejects a wrong code", () => {
    const wrong = codeForStep(secret, step) === "000000" ? "111111" : "000000";
    expect(verifyCode(secret, wrong, { at: now })).toBeNull();
  });

  /**
   * The replay guard, and the reason verifyCode returns a step rather than a
   * boolean. A TOTP code is valid for its whole 30-second window — long enough to
   * be read over a shoulder and typed again — so a code that has been spent must
   * be dead even while it is still "correct".
   */
  it("refuses a code from a step that has already been spent", () => {
    const code = codeForStep(secret, step);

    expect(verifyCode(secret, code, { at: now, after: null })).toBe(step);
    expect(verifyCode(secret, code, { at: now, after: step })).toBeNull();
  });

  it("refuses codes from BEFORE the last spent step, not just the step itself", () => {
    // Accepting step-1 after step has been spent would make the skew window a
    // replay window: watch a code, wait for the user to log in, use it.
    const previous = codeForStep(secret, step - 1);
    expect(verifyCode(secret, previous, { at: now, after: step })).toBeNull();
  });
});

describe("otpauthUrl", () => {
  it("names the issuer twice, which is what makes the app label the entry", () => {
    const url = new URL(otpauthUrl("JBSWY3DPEHPK3PXP", "jane@acme.com", "Z-CMS"));

    // In `otpauth://totp/<label>` the "totp" is the AUTHORITY, not a path segment
    // — the type of the credential is the host. The label is the whole path.
    expect(url.protocol).toBe("otpauth:");
    expect(url.host).toBe("totp");
    expect(decodeURIComponent(url.pathname)).toBe("/Z-CMS:jane@acme.com");
    expect(url.searchParams.get("issuer")).toBe("Z-CMS");
    expect(url.searchParams.get("secret")).toBe("JBSWY3DPEHPK3PXP");
    expect(url.searchParams.get("digits")).toBe("6");
    expect(url.searchParams.get("period")).toBe("30");
  });
});

describe("secret encryption", () => {
  it("round-trips a secret", () => {
    const secret = generateSecret();
    expect(decryptSecret(encryptSecret(secret, KEY), KEY)).toBe(secret);
  });

  it("produces a different ciphertext every time — the IV is not reused", () => {
    // Two identical secrets encrypting to the same bytes would tell anyone with
    // the dump which users share an enrollment, and with GCM an IV reuse is not a
    // cosmetic problem: it breaks the cipher.
    const secret = generateSecret();
    const a = encryptSecret(secret, KEY);
    const b = encryptSecret(secret, KEY);

    expect(a).not.toBe(b);
    expect(decryptSecret(a, KEY)).toBe(decryptSecret(b, KEY));
  });

  it("refuses to decrypt a tampered ciphertext rather than returning a wrong secret", () => {
    // This is what GCM's auth tag buys, and why the cipher is authenticated: a
    // flipped bit must be an error, not a secret that silently lets nobody in.
    const stored = encryptSecret(generateSecret(), KEY);
    const [v, iv, tag, ct] = stored.split(".");
    const flipped = [v, iv, tag, `${ct.slice(0, -2)}${ct.slice(-2) === "AA" ? "AB" : "AA"}`].join(".");

    expect(() => decryptSecret(flipped, KEY)).toThrow();
  });

  it("refuses the wrong key", () => {
    const stored = encryptSecret(generateSecret(), KEY);
    expect(() => decryptSecret(stored, randomBytes(32))).toThrow();
  });

  it("never stores the secret in the clear", () => {
    const secret = generateSecret();
    expect(encryptSecret(secret, KEY)).not.toContain(secret);
  });
});

describe("readEncryptionKey", () => {
  it("accepts 32 bytes as base64 or as hex", () => {
    const bytes = randomBytes(32);
    expect(readEncryptionKey(bytes.toString("base64"))).toEqual(bytes);
    expect(readEncryptionKey(bytes.toString("hex"))).toEqual(bytes);
  });

  it("refuses a key of the wrong length instead of padding it into one", () => {
    expect(() => readEncryptionKey(randomBytes(16).toString("base64"))).toThrow(/32 bytes/);
  });

  it("tells the operator what to do when the key is missing", () => {
    // An unset key is a misconfiguration, and the one place it will be noticed is
    // the error. It has to be an instruction, not a stack trace.
    expect(() => readEncryptionKey(undefined)).toThrow(TotpKeyMissingError);
    expect(() => readEncryptionKey(undefined)).toThrow(/randomBytes\(32\)/);
  });
});
