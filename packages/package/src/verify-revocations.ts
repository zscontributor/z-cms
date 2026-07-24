import { generateKeyPair } from "./signing";
import {
  revocationDigest,
  signRevocationList,
  verifyRevocationList,
  type RevocationList,
  type SignedRevocationList,
} from "./revocations";

/**
 * Attacks the revocation channel.
 *
 * This is the only mechanism that reaches a package which is already installed
 * and already executing on a customer's site — and it is therefore a remote
 * uninstall button. If a stranger can forge the list, they can disable every
 * plugin on every Z-CMS instance in the world from a coffee shop. If a stranger
 * can *suppress* or *rewind* it, a package we know is malicious keeps running.
 *
 * Both directions are attacks, and both are checked here.
 */

let failures = 0;

function check(name: string, passed: boolean, detail: string) {
  console.log(`  ${passed ? "PASS" : "FAIL"}  ${name}\n        ${detail}`);
  if (!passed) failures++;
}

/** True when verification threw — i.e. the list was refused. */
function refused(fn: () => unknown): { refused: boolean; why: string } {
  try {
    fn();
    return { refused: false, why: "it was ACCEPTED" };
  } catch (err) {
    return { refused: true, why: (err as Error).message.split("\n")[0] ?? "" };
  }
}

function main(): void {
  console.log("\nRevocation list — attacking the kill switch\n");

  const marketplace = generateKeyPair();
  const attacker = generateKeyPair();

  const list: RevocationList = {
    issuedAt: "2026-07-12T10:00:00.000Z",
    revoked: [
      {
        kind: "plugin",
        key: "vn.zsoft.plugin.analytics",
        version: "0.1.0",
        reason: "Exfiltrated visitor data to a third party.",
        revokedAt: "2026-07-12T09:55:00.000Z",
      },
      {
        kind: "theme",
        key: "vn.zsoft.theme.aurora",
        version: "1.0.1",
        reason: "Bundled a backdoored dependency.",
        revokedAt: "2026-07-11T22:00:00.000Z",
      },
    ],
  };

  const signed = signRevocationList(list, marketplace.privateKey);

  // 1. The happy path. Without this the rest is theatre: a kill switch that
  //    refuses every list is a kill switch that never fires.
  {
    const r = refused(() => verifyRevocationList(signed, marketplace.publicKey));
    check(
      "a genuine list from the pinned marketplace verifies",
      !r.refused,
      r.refused ? `REGRESSION — refused a valid list: ${r.why}` : "accepted, 2 revocations",
    );
  }

  // 2. Forgery. An attacker who can answer for marketplace.z-cms.org — DNS
  //    hijack, a mis-issued certificate, a compromised mirror — signs a list of
  //    their own. Verification uses the key the instance PINNED, not one that
  //    travelled with the document, so their signature is worthless.
  {
    const forged = signRevocationList(list, attacker.privateKey);
    const r = refused(() => verifyRevocationList(forged, marketplace.publicKey));
    check(
      "a list signed by a foreign key is refused",
      r.refused,
      r.refused ? r.why : "A STRANGER CAN DISABLE PLUGINS ON EVERY INSTANCE",
    );
  }

  // 3. Tampering. The document is signed, so an attacker cannot edit it — but
  //    only if the digest is RECOMPUTED from the content. Here they append a
  //    revocation and leave the original digest and signature in place: both
  //    still "match" each other perfectly. Trusting the attached digest is the
  //    entire bug, and it is the same one the package pipeline refuses to make
  //    with the payload checksum.
  {
    const tampered: SignedRevocationList = {
      ...signed,
      revoked: [
        ...signed.revoked,
        {
          kind: "plugin",
          key: "vn.zsoft.plugin.seo",
          version: "1.0.0",
          reason: "(injected by an attacker to disable a competitor)",
          revokedAt: "2026-07-12T09:59:00.000Z",
        },
      ],
    };
    const r = refused(() => verifyRevocationList(tampered, marketplace.publicKey));
    check(
      "an entry appended after signing is refused",
      r.refused,
      r.refused ? r.why : "THE DIGEST IN THE DOCUMENT WAS TRUSTED — anything can be injected",
    );
  }

  // 4. Removal is tampering too, and it is the attack that MATTERS: suppressing
  //    one entry is how you keep your own malicious plugin alive on every site
  //    that already installed it.
  {
    const gutted: SignedRevocationList = { ...signed, revoked: [signed.revoked[1] as never] };
    const r = refused(() => verifyRevocationList(gutted, marketplace.publicKey));
    check(
      "an entry REMOVED after signing is refused",
      r.refused,
      r.refused ? r.why : "AN ATTACKER CAN UN-REVOKE THEIR OWN PLUGIN",
    );
  }

  // 5. Rollback. The attacker cannot forge a list, so they replay a real one —
  //    captured last month, before their package was pulled. Every signature on
  //    it is genuine. The defence is not cryptographic, it is a clock: an
  //    instance refuses a list older than the newest it has already accepted.
  {
    const older: RevocationList = { issuedAt: "2026-06-01T00:00:00.000Z", revoked: [] };
    const replayed = signRevocationList(older, marketplace.privateKey);
    const r = refused(() =>
      verifyRevocationList(replayed, marketplace.publicKey, new Date(signed.issuedAt)),
    );
    check(
      "a genuinely-signed but STALE list is refused as a rollback",
      r.refused,
      r.refused ? r.why : "A REPLAYED OLD LIST ROLLS THE INSTANCE BACK TO BEFORE THE REVOCATION",
    );
  }

  // 6. An unsigned list is not a list. Stated separately because "no signature"
  //    is the field an attacker omits, and code that reads `sig ?? ""` and then
  //    compares happily accepts it.
  {
    const unsigned = { issuedAt: signed.issuedAt, revoked: signed.revoked, digest: signed.digest };
    const r = refused(() => verifyRevocationList(unsigned, marketplace.publicKey));
    check(
      "an unsigned list is refused",
      r.refused,
      r.refused ? r.why : "AN UNSIGNED LIST WAS ACCEPTED",
    );
  }

  // 7. The digest must depend on the ISSUE DATE, not only on the entries.
  //    Otherwise a signature over an empty list is valid forever and can be
  //    replayed with any timestamp the attacker likes — which defeats check 5.
  {
    const a = revocationDigest({ issuedAt: "2026-07-12T10:00:00.000Z", revoked: [] });
    const b = revocationDigest({ issuedAt: "2026-06-01T00:00:00.000Z", revoked: [] });
    check(
      "the issue date is inside the signed digest",
      a !== b,
      a !== b
        ? "re-dating a list invalidates its signature"
        : "THE TIMESTAMP IS NOT SIGNED — a captured list can be re-dated at will",
    );
  }

  // 8. Canonicalisation. Two instances must derive the same digest from the same
  //    facts, or a list signed by the marketplace fails to verify at the consumer
  //    for no reason but row order — and a kill switch that intermittently fails
  //    to verify is one an operator learns to ignore.
  {
    const shuffled: RevocationList = {
      issuedAt: list.issuedAt,
      revoked: [...list.revoked].reverse(),
    };
    const same = revocationDigest(list) === revocationDigest(shuffled);
    const r = refused(() =>
      verifyRevocationList(
        { ...shuffled, digest: signed.digest, signature: signed.signature },
        marketplace.publicKey,
      ),
    );
    check(
      "row order does not change the digest (canonical form)",
      same && !r.refused,
      same && !r.refused
        ? "the same facts in any order verify against the same signature"
        : "ORDER-DEPENDENT DIGEST — the list would fail to verify at random",
    );
  }

  console.log(
    failures === 0
      ? "\nAll revocation checks passed — the kill switch cannot be forged, edited, or rewound.\n"
      : `\n${failures} REVOCATION CHECK(S) FAILED — the kill switch is not trustworthy.\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main();
