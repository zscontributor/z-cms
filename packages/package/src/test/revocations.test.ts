import { describe, expect, it } from "vitest";
import {
  RevocationError,
  revocationDigest,
  signRevocationList,
  verifyRevocationList,
  type RevocationList,
  type SignedRevocationList,
} from "../revocations";
import { generateKeyPair } from "../signing";

/**
 * The revocation list is the kill switch. Two failure modes, both fatal:
 *
 *   - it does not reach an instance  → revoked, vulnerable code keeps serving;
 *   - anyone can forge one           → a remote uninstall button for the internet.
 *
 * So verification is FAIL-CLOSED on the document itself: an unsigned, forged,
 * malformed or replayed list is not "an empty list" — it is an error the caller
 * must see and decide about. Every test below pins one half of that bargain.
 */

const marketplace = generateKeyPair();

const LIST: RevocationList = {
  issuedAt: "2026-07-01T00:00:00.000Z",
  revoked: [
    {
      kind: "plugin",
      key: "vn.zsoft.plugin.seo",
      version: "1.2.3",
      reason: "Remote code execution in the sitemap handler.",
      revokedAt: "2026-06-30T12:00:00.000Z",
    },
    {
      kind: "theme",
      key: "vn.zsoft.theme.corporate",
      version: "2.0.0",
      reason: "Stored XSS in the header widget.",
      revokedAt: "2026-06-29T09:00:00.000Z",
    },
  ],
};

describe("revocationDigest", () => {
  it("is stable for the same list", () => {
    expect(revocationDigest(LIST)).toBe(revocationDigest(LIST));
  });

  it("ignores the order the marketplace database happened to return rows in", () => {
    // Two instances must derive the same digest from the same set of revocations.
    // If row order changed the digest, a re-signed identical list would look like
    // a different one and consumers would start rejecting genuine snapshots.
    const shuffled: RevocationList = { ...LIST, revoked: [...LIST.revoked].reverse() };

    expect(revocationDigest(shuffled)).toBe(revocationDigest(LIST));
  });

  it("changes when a revocation is removed", () => {
    // The un-revoke attack: quietly drop an entry. The digest must move, so the
    // signature over it stops verifying.
    const shortened: RevocationList = { ...LIST, revoked: [LIST.revoked[0]!] };

    expect(revocationDigest(shortened)).not.toBe(revocationDigest(LIST));
  });

  it("changes when a revoked version is altered", () => {
    const tweaked: RevocationList = {
      ...LIST,
      revoked: [{ ...LIST.revoked[0]!, version: "1.2.4" }],
    };

    expect(revocationDigest(tweaked)).not.toBe(
      revocationDigest({ ...LIST, revoked: [LIST.revoked[0]!] }),
    );
  });

  it("changes when the issue date changes, so a snapshot cannot be back-dated", () => {
    expect(revocationDigest({ ...LIST, issuedAt: "2020-01-01T00:00:00.000Z" })).not.toBe(
      revocationDigest(LIST),
    );
  });

  it("covers the reason text, so a revocation cannot be silently reworded", () => {
    const reworded: RevocationList = {
      ...LIST,
      revoked: [{ ...LIST.revoked[0]!, reason: "Nothing to see here." }, LIST.revoked[1]!],
    };

    expect(revocationDigest(reworded)).not.toBe(revocationDigest(LIST));
  });
});

describe("signRevocationList", () => {
  it("produces a list a consumer pinning the marketplace key accepts", () => {
    const signed = signRevocationList(LIST, marketplace.privateKey);

    expect(() => verifyRevocationList(signed, marketplace.publicKey)).not.toThrow();
  });

  it("attaches the digest of the canonical form", () => {
    const signed = signRevocationList(LIST, marketplace.privateKey);

    expect(signed.digest).toBe(revocationDigest(LIST));
  });

  it("keeps every revocation it was given", () => {
    expect(signRevocationList(LIST, marketplace.privateKey).revoked).toEqual(LIST.revoked);
  });
});

describe("verifyRevocationList", () => {
  const signed = () => signRevocationList(LIST, marketplace.privateKey);

  it("returns the revocations of a list the pinned marketplace signed", () => {
    const list = verifyRevocationList(signed(), marketplace.publicKey);

    expect(list.issuedAt).toBe(LIST.issuedAt);
    expect(list.revoked).toHaveLength(2);
    expect(list.revoked[0]!.key).toBe("vn.zsoft.plugin.seo");
  });

  it("rejects a list signed by a key this instance does not pin", () => {
    // THE ATTACK THIS MODULE EXISTS FOR: anyone who can answer for the update
    // endpoint — DNS, a proxy, a compromised mirror — would otherwise own a
    // remote uninstall button for every plugin on every instance.
    const attacker = generateKeyPair();
    const forged = signRevocationList(
      { issuedAt: LIST.issuedAt, revoked: [] },
      attacker.privateKey,
    );

    expect(() => verifyRevocationList(forged, marketplace.publicKey)).toThrow(
      /not signed by the marketplace this instance pins/,
    );
  });

  it("rejects a list whose revocations were edited after it was signed", () => {
    // The un-revoke: strip the entry that kills your plugin and keep the genuine
    // signature. The digest is recomputed from the content, so the theft shows.
    const tampered: SignedRevocationList = { ...signed(), revoked: [LIST.revoked[1]!] };

    expect(() => verifyRevocationList(tampered, marketplace.publicKey)).toThrow(
      RevocationError,
    );
  });

  it("rejects a list with an extra revocation smuggled in after signing", () => {
    // The inverse attack: add a revocation for a competitor's plugin and let every
    // instance disable it for you.
    const tampered: SignedRevocationList = {
      ...signed(),
      revoked: [
        ...LIST.revoked,
        {
          kind: "plugin",
          key: "vn.competitor.plugin.forms",
          version: "3.0.0",
          reason: "Fabricated.",
          revokedAt: "2026-07-01T00:00:00.000Z",
        },
      ],
    };

    expect(() => verifyRevocationList(tampered, marketplace.publicKey)).toThrow(
      /not signed by the marketplace this instance pins/,
    );
  });

  it("recomputes the digest instead of trusting the one on the wire", () => {
    // If the attached digest were trusted, an attacker would sign a digest of
    // their choosing and ship whatever list they liked beside it.
    const attacker = generateKeyPair();

    const spliced: SignedRevocationList = {
      // A genuine digest, and a signature that really does cover it — but made
      // by the attacker's key, over a list whose `revoked` is then emptied on the
      // wire. The digest is a decoration; verification must recompute it.
      ...signRevocationList(LIST, attacker.privateKey),
      revoked: [],
    };

    expect(() => verifyRevocationList(spliced, marketplace.publicKey)).toThrow(
      RevocationError,
    );
  });

  it("rejects a list that carries no signature at all", () => {
    // An unsigned list must never be treated as "no revocations". Silence and an
    // empty list are the same thing to a naive consumer, and one of them is a lie.
    const { signature: _signature, ...unsigned } = signed();

    expect(() => verifyRevocationList(unsigned, marketplace.publicKey)).toThrow(
      /not signed/,
    );
  });

  it("rejects a list whose signature is an empty string", () => {
    expect(() =>
      verifyRevocationList({ ...signed(), signature: "" }, marketplace.publicKey),
    ).toThrow(/not signed/);
  });

  it("rejects a signature that is not even base64", () => {
    // Garbage in the signature field must be a refusal, not a crash in the crypto
    // library — this input arrives from the network.
    expect(() =>
      verifyRevocationList({ ...signed(), signature: "!!!nonsense!!!" }, marketplace.publicKey),
    ).toThrow(RevocationError);
  });

  it("rejects a document that is not an object", () => {
    expect(() => verifyRevocationList("[]", marketplace.publicKey)).toThrow(
      /not an object/,
    );
  });

  it("rejects a null document", () => {
    expect(() => verifyRevocationList(null, marketplace.publicKey)).toThrow(
      /not an object/,
    );
  });

  it("rejects a document with no issue date", () => {
    const { issuedAt: _issuedAt, ...noDate } = signed();

    expect(() => verifyRevocationList(noDate, marketplace.publicKey)).toThrow(
      /malformed/,
    );
  });

  it("rejects a document whose revoked field is not an array", () => {
    expect(() =>
      verifyRevocationList({ ...signed(), revoked: "all of them" }, marketplace.publicKey),
    ).toThrow(/malformed/);
  });

  it("rejects a document whose issue date is not a date", () => {
    const list = signRevocationList(
      { ...LIST, issuedAt: "the day before yesterday" },
      marketplace.privateKey,
    );

    expect(() => verifyRevocationList(list, marketplace.publicKey)).toThrow(
      /no valid issue date/,
    );
  });

  it("rejects a revocation whose kind is neither theme nor plugin", () => {
    const list = signRevocationList(
      {
        issuedAt: LIST.issuedAt,
        revoked: [{ ...LIST.revoked[0]!, kind: "core" as never }],
      },
      marketplace.privateKey,
    );

    expect(() => verifyRevocationList(list, marketplace.publicKey)).toThrow(
      /Revocation #0 is malformed/,
    );
  });

  it("rejects a revocation with no version, which would name nothing to kill", () => {
    const list = signRevocationList(
      {
        issuedAt: LIST.issuedAt,
        revoked: [{ ...LIST.revoked[0]!, version: undefined as never }],
      },
      marketplace.privateKey,
    );

    expect(() => verifyRevocationList(list, marketplace.publicKey)).toThrow(
      /Revocation #0 is malformed/,
    );
  });

  it("accepts a revocation whose reason is an empty string, preserving it", () => {
    // An empty reason is untidy, not hostile — refusing the whole list over it
    // would disarm the kill switch to enforce a documentation standard.
    const list = signRevocationList(
      {
        issuedAt: LIST.issuedAt,
        revoked: [{ ...LIST.revoked[0]!, reason: "" }],
      },
      marketplace.privateKey,
    );

    expect(verifyRevocationList(list, marketplace.publicKey).revoked[0]!.reason).toBe("");
  });

  it("rejects a snapshot older than the newest one already accepted", () => {
    // ATTACK: replay. Hold the connection open and keep serving last month's list,
    // and the instance never hears about this month's revocation. Refusing the
    // rollback is what turns that silence into a visible error.
    const old = signRevocationList(
      { ...LIST, issuedAt: "2026-01-01T00:00:00.000Z" },
      marketplace.privateKey,
    );

    expect(() =>
      verifyRevocationList(old, marketplace.publicKey, new Date("2026-07-01T00:00:00.000Z")),
    ).toThrow(/rollback/);
  });

  it("accepts a snapshot issued at the same moment as the one already accepted", () => {
    // Re-fetching the current list must not be mistaken for a rollback.
    expect(() =>
      verifyRevocationList(signed(), marketplace.publicKey, new Date(LIST.issuedAt)),
    ).not.toThrow();
  });

  it("accepts a snapshot newer than the one already accepted", () => {
    const fresh = signRevocationList(
      { ...LIST, issuedAt: "2026-08-01T00:00:00.000Z" },
      marketplace.privateKey,
    );

    expect(() =>
      verifyRevocationList(fresh, marketplace.publicKey, new Date(LIST.issuedAt)),
    ).not.toThrow();
  });

  it("accepts a genuine empty list — nothing revoked is a legitimate answer", () => {
    const empty = signRevocationList(
      { issuedAt: LIST.issuedAt, revoked: [] },
      marketplace.privateKey,
    );

    expect(verifyRevocationList(empty, marketplace.publicKey).revoked).toEqual([]);
  });

  it("throws RevocationError, so a caller can tell a refused list from a crash", () => {
    // The consumer's fail-open/fail-closed decision hangs on this distinction: it
    // can only be made deliberately if the refusal has a type.
    expect(() => verifyRevocationList({}, marketplace.publicKey)).toThrow(RevocationError);
  });
});
