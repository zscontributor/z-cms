import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { MissingEncryptionKeyError, readKey } from "../common/secret-box";

/**
 * TOTP (RFC 6238), and the encryption that keeps its secrets survivable.
 *
 * Written out rather than pulled in, for once with a real reason: the algorithm
 * is thirty lines of HMAC and a modulo, and the parts that actually decide
 * whether the feature is secure are not in the algorithm at all — they are the
 * replay window, the constant-time compare, and what happens to the secret at
 * rest. A dependency would hide the first two and have an opinion about none of
 * the third.
 */

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

/** 30 seconds, SHA-1, 6 digits: what every authenticator app actually implements. */
export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;

/**
 * How many steps either side of "now" are accepted.
 *
 * One. That is ±30 seconds, and it is there for clock skew between the phone and
 * the server, not for the user's convenience. Every extra step widens the window
 * an attacker has to land a guess in, and 90 seconds of tolerance has never been
 * the difference between a person logging in and not.
 */
const TOTP_WINDOW = 1;

/** 20 bytes = 160 bits, the size RFC 4226 specifies for the shared secret. */
const SECRET_BYTES = 20;

// ---------------------------------------------------------------------------
// Base32 (RFC 4648, unpadded) — the alphabet authenticator apps read
// ---------------------------------------------------------------------------

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";

  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += ALPHABET[(value << (5 - bits)) & 31];

  return output;
}

export function base32Decode(input: string): Buffer {
  // Padding and lowercase are both things a human pastes; neither is an error.
  const clean = input.replace(/=+$/, "").replace(/\s+/g, "").toUpperCase();

  let bits = 0;
  let value = 0;
  const bytes: number[] = [];

  for (const char of clean) {
    const index = ALPHABET.indexOf(char);
    if (index === -1) throw new Error(`"${char}" is not base32.`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  return Buffer.from(bytes);
}

// ---------------------------------------------------------------------------
// The algorithm
// ---------------------------------------------------------------------------

/** A fresh shared secret, in the base32 form an authenticator expects. */
export function generateSecret(): string {
  return base32Encode(randomBytes(SECRET_BYTES));
}

/** The time-step a given instant falls in. This is TOTP's entire notion of "now". */
export function currentStep(atMs: number = Date.now()): number {
  return Math.floor(atMs / 1000 / TOTP_STEP_SECONDS);
}

/**
 * HOTP (RFC 4226): HMAC-SHA1 the counter, then dynamically truncate.
 *
 * The truncation looks arbitrary and is not: the low nibble of the last byte
 * chooses where in the digest to read four bytes from, so the digits depend on
 * the whole HMAC rather than on a fixed slice of it.
 */
function hotp(secret: Buffer, counter: number): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));

  const digest = createHmac("sha1", secret).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    (digest[offset + 1] << 16) |
    (digest[offset + 2] << 8) |
    digest[offset + 3];

  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, "0");
}

/** The code for one step. Exported so tests can assert against RFC vectors. */
export function codeForStep(secretBase32: string, step: number): string {
  return hotp(base32Decode(secretBase32), step);
}

/**
 * Checks a code and returns the step it matched, or null.
 *
 * Returning the *step* rather than a boolean is what makes replay protection
 * possible: the caller records it and refuses anything at or below it next time.
 * A boolean would leave "which window did that come from?" unanswerable, and a
 * code stays valid for a whole window — long enough to be watched, repeated, or
 * replayed by anything sitting in the middle.
 *
 * `after` is the last step this user already spent. Passing it makes verification
 * strictly ascending.
 */
export function verifyCode(
  secretBase32: string,
  code: string,
  options: { at?: number; after?: number | null } = {},
): number | null {
  const now = currentStep(options.at);
  const floor = options.after ?? -1;

  for (let offset = -TOTP_WINDOW; offset <= TOTP_WINDOW; offset++) {
    const step = now + offset;
    if (step <= floor) continue;

    // Constant-time: a naive === leaks, one character at a time, how much of a
    // guess was right. Six digits is a small enough space that this matters.
    if (equalsInConstantTime(codeForStep(secretBase32, step), code)) return step;
  }

  return null;
}

export function equalsInConstantTime(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * The `otpauth://` URI a QR code encodes.
 *
 * The label carries the issuer twice — once as a prefix, once as a parameter —
 * because that is what the de-facto spec says and what makes the entry read
 * "Z-CMS (jane@acme.com)" rather than an unlabelled six digits among eleven other
 * unlabelled six digits.
 */
export function otpauthUrl(secret: string, account: string, issuer: string): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Encryption at rest
// ---------------------------------------------------------------------------

/**
 * A TOTP secret cannot be hashed — it has to be recomputed on every login — so
 * the database necessarily holds something that *is* the second factor. Left in
 * the clear, a leaked dump hands an attacker every second factor on the instance,
 * and 2FA's whole premise is that it survives a compromise of the credential
 * store. Encrypted under a key that lives in the environment, a dump on its own
 * is not enough.
 *
 * The cipher itself is in `common/secret-box` — the SMTP password needs the same
 * envelope, and two implementations of AES-GCM in one codebase is one too many.
 * Re-exported here because the auth code's dependency is on "a TOTP secret is
 * encrypted at rest", not on which module happens to hold the primitive.
 */
export { decryptSecret, encryptSecret } from "../common/secret-box";

export class TotpKeyMissingError extends MissingEncryptionKeyError {
  constructor() {
    super("TOTP_ENCRYPTION_KEY");
    this.name = "TotpKeyMissingError";
    this.message +=
      "\n\nFor two-factor specifically: rotating this key makes every enrolled " +
      "authenticator undecryptable, and every user has to enroll again.";
  }
}

/** 32 bytes, from base64 or hex. Anything else is a misconfiguration, loudly. */
export function readEncryptionKey(raw: string | undefined): Buffer {
  if (!raw) throw new TotpKeyMissingError();
  return readKey(raw, "TOTP_ENCRYPTION_KEY");
}
