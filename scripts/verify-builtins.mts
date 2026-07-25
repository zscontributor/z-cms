import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openPackage, verifyFirstParty } from "@zcmsorg/package";

/**
 * Guards the invariant that the content-pack outage broke: every built-in `.zcms`
 * that ships in an image is signed with the FIRST-PARTY key the runtimes pin.
 *
 *   tsx scripts/verify-builtins.mts
 *
 * The runtimes discover built-ins by scanning `plugins/*` and `themes/*` and
 * first-party-verify every `.zcms` they find there. A package that fails that check
 * does not just fail to load itself — for plugins it is loaded WITHOUT a version, so
 * the scan verifies every candidate before matching an id, and one bad package throws
 * and blocks EVERY genuine built-in. That is precisely how a marketplace package
 * (`content-pack`, publisher-signed, not first-party-signed) that leaked into the
 * built-in `/plugins` took down the AI assistant.
 *
 * The marker that keeps such a package OUT of the built-in set is `.not-builtin`,
 * honoured by `sign-builtins.mts`, the `seed-*` steps and both Docker build stages.
 * This check is the tripwire for the day one of those consumers is missed, or a
 * genuine built-in is signed with the wrong key:
 *
 *   - a directory WITHOUT `.not-builtin` is a built-in: its `.zcms` MUST verify
 *     against `keys/zsoft-publisher.pub.pem`, and it must actually HAVE one;
 *   - a directory WITH `.not-builtin` is marketplace-distributed: it is exempt, and
 *     reported as skipped so a stray marker cannot silently drop a real built-in.
 *
 * Run in CI (`pnpm verify`) against the committed `.zcms` artefacts, so a bad package
 * fails the build instead of the AI assistant.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");

const PUB = process.env.ZCMS_PUBLISHER_PUB ?? path.join(REPO, "keys/zsoft-publisher.pub.pem");
if (!fs.existsSync(PUB)) {
  console.error(`\nNo first-party public key at ${PUB} to verify built-ins against.\n`);
  process.exit(1);
}
const firstPartyPublicKey = fs.readFileSync(PUB, "utf8");

const KINDS = [
  { dir: "plugins", manifest: "plugin.json" },
  { dir: "themes", manifest: "theme.json" },
] as const;

const failures: string[] = [];
let verified = 0;
let skipped = 0;

for (const kind of KINDS) {
  const root = path.join(REPO, kind.dir);
  if (!fs.existsSync(root)) continue;

  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    const rel = `${kind.dir}/${entry.name}`;

    // Not a package directory at all — no manifest, nothing to ship.
    if (!fs.existsSync(path.join(dir, kind.manifest))) continue;

    const zcms = fs.readdirSync(dir).filter((file) => file.endsWith(".zcms"));

    // Marketplace-distributed: exempt from the first-party requirement, but reported
    // so a `.not-builtin` marker dropped onto a real built-in is visible, not silent.
    if (fs.existsSync(path.join(dir, ".not-builtin"))) {
      skipped++;
      console.log(`  skip ${rel} — .not-builtin (marketplace-distributed)`);
      continue;
    }

    if (zcms.length === 0) {
      failures.push(`${rel}: built-in has no signed .zcms — run: pnpm sign:${kind.dir}`);
      continue;
    }

    for (const file of zcms) {
      const full = path.join(dir, file);
      try {
        const { envelope, payload } = await openPackage(fs.readFileSync(full));
        // Throws on a checksum mismatch or a signature not made by the pinned key.
        verifyFirstParty(envelope, payload, firstPartyPublicKey);
        verified++;
        console.log(`  ok   ${rel}/${file} — ${envelope.manifest.id}@${envelope.manifest.version}`);
      } catch (err) {
        failures.push(
          `${rel}/${file}: ${(err as Error).message}\n` +
            `      A built-in must be first-party-signed. If this is a marketplace package, ` +
            `add a .not-builtin marker to ${rel}/ so it is not shipped as a built-in.`,
        );
      }
    }
  }
}

if (failures.length) {
  console.error(`\nBuilt-in verification FAILED:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}

console.log(
  `\nBuilt-in verification OK: ${verified} first-party package(s) verified, ${skipped} marketplace dir(s) skipped.`,
);
