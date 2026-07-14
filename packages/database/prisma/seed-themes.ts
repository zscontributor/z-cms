import fs from "node:fs";
import path from "node:path";
import { config as loadEnv } from "dotenv";

loadEnv({ path: path.resolve(__dirname, "../../../.env"), quiet: true });

import { openPackage, verifyFirstParty, type PackageManifest } from "@zcmsorg/package";
import { getSystemDb, disconnectDb } from "../src/clients";

/**
 * Registers the built-in themes in the catalogue — from their SIGNED packages.
 *
 * The manifest comes out of the `.zcms`, after `verifyFirstParty` has checked the
 * payload digest against the pinned first-party key. Reading `theme.json` off the
 * disk instead would put an unsigned manifest into the row that site-runtime resolves
 * a theme from, and a theme is not sandboxed: it renders in site-runtime's own
 * process. What lands in the database is what was signed, or nothing lands.
 *
 * This replaces a hand-copied theme block in seed.ts that had quietly drifted — it
 * claimed version 0.1.0 while the theme was on 1.2.0, and its manifest was a stale
 * transcription of the real one. A manifest maintained in two places is a manifest
 * maintained in neither.
 */
async function main() {
  const db = getSystemDb();
  const root = path.resolve(__dirname, "../../../themes");

  if (!fs.existsSync(root)) {
    console.log("No /themes directory.");
    return;
  }

  const pinned = (process.env.FIRST_PARTY_PUBLIC_KEY ?? "").replace(/\\n/g, "\n");
  if (!pinned) {
    throw new Error(
      "FIRST_PARTY_PUBLIC_KEY is not set. It is the key the built-in themes are " +
        "verified against; without it there is nothing to check them with, and an " +
        "unchecked theme runs unsandboxed inside site-runtime.",
    );
  }

  let seeded = 0;

  for (const dir of fs.readdirSync(root, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;

    const themeDir = path.join(root, dir.name);
    if (!fs.existsSync(path.join(themeDir, "theme.json"))) continue;

    const packages = fs.readdirSync(themeDir).filter((file) => file.endsWith(".zcms"));
    if (packages.length === 0) {
      throw new Error(
        `themes/${dir.name} has no signed package. Build it and run: pnpm sign:themes`,
      );
    }

    for (const file of packages) {
      const { envelope, payload } = await openPackage(
        fs.readFileSync(path.join(themeDir, file)),
      );
      verifyFirstParty(envelope, payload, pinned);

      const manifest = envelope.manifest as PackageManifest;

      const theme = await db.theme.upsert({
        where: { key: manifest.id },
        update: {
          name: manifest.name,
          description: manifest.description ?? null,
          // Set on UPDATE too, and that is not a detail. These four themes may already
          // exist as rows from an earlier marketplace install of the same key — and an
          // update branch that quietly left `isCore` alone would leave one of the
          // themes we ship marked as somebody else's. It is platform-controlled data
          // and this script is the platform.
          isCore: true,
        },
        create: {
          key: manifest.id,
          name: manifest.name,
          description: manifest.description ?? null,
          author: manifest.author.name,
          isCore: true,
        },
      });

      await db.themeVersion.upsert({
        where: { themeId_version: { themeId: theme.id, version: manifest.version } },
        update: {
          manifest: manifest as never,
          checksum: envelope.checksum,
          publisherSignature: envelope.publisherSignature,
          // Reset to BUILTIN, and null out the marketplace fields, for the same
          // reason. A row that already carried a bundleUrl and origin=MARKETPLACE
          // from an earlier install would otherwise keep them, and site-runtime would
          // send this key down the MARKETPLACE path — trying to download a theme that
          // is sitting on its own disk, verified against the wrong key. Two truths
          // about one theme is one truth too many.
          origin: "BUILTIN",
          bundleUrl: null,
          marketplaceSignature: null,
        },
        create: {
          themeId: theme.id,
          version: manifest.version,
          engine: manifest.engine,
          manifest: manifest as never,
          checksum: envelope.checksum,
          publisherSignature: envelope.publisherSignature,
          // BUILTIN, and no bundleUrl: this ships inside site-runtime and is verified
          // against the first-party key, not downloaded and not trusted-by-location.
          origin: "BUILTIN",
        },
      });

      console.log(`  ${manifest.id}@${manifest.version} — ${envelope.checksum.slice(0, 12)}`);
      seeded++;
    }
  }

  console.log(`\n${seeded} signed built-in theme(s) registered in the catalogue.`);
}

main()
  .catch((err) => {
    console.error(`\n${(err as Error).message}\n`);
    process.exitCode = 1;
  })
  .finally(disconnectDb);
