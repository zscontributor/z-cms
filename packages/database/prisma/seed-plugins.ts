import fs from "node:fs";
import path from "node:path";
import { config as loadEnv } from "dotenv";

loadEnv({ path: path.resolve(__dirname, "../../../.env"), quiet: true });

import { openPackage, verifyFirstParty, type PackageManifest } from "@zcmsorg/package";
import { getSystemDb, disconnectDb } from "../src/clients";

/**
 * Registers the built-in plugins in the catalogue — from their SIGNED packages.
 *
 * It used to read `plugins/<name>/plugin.json` straight off the disk. That was a
 * hole, and a quiet one: the manifest is what declares a plugin's permissions and
 * the hosts it may reach, so an unsigned manifest is an unsigned copy of the security
 * policy. The gateway enforces `network.hosts` by reading it back out of this row.
 * Anyone who could edit that JSON file could therefore widen zAI's allowlist —
 * `api.openai.com` becomes `attacker.example` — get an admin to consent to it on a
 * screen that faithfully displays what it was told, and never touch a byte of signed
 * code.
 *
 * So the manifest comes out of the `.zcms`, after `verifyFirstParty` has checked the
 * payload digest against the pinned first-party key. What lands in the database is
 * what was signed, or nothing lands at all.
 */
async function main() {
  const db = getSystemDb();
  const root = path.resolve(__dirname, "../../../plugins");

  if (!fs.existsSync(root)) {
    console.log("No /plugins directory.");
    return;
  }

  const pinned = (process.env.FIRST_PARTY_PUBLIC_KEY ?? "").replace(/\\n/g, "\n");
  if (!pinned) {
    throw new Error(
      "FIRST_PARTY_PUBLIC_KEY is not set. It is the key the built-in plugins are " +
        "verified against; without it there is nothing to check them with, and an " +
        "unchecked built-in is the one thing this seed must not write.",
    );
  }

  let seeded = 0;

  for (const dir of fs.readdirSync(root, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;

    const pkgDir = path.join(root, dir.name);
    const packages = fs.readdirSync(pkgDir).filter((file) => file.endsWith(".zcms"));

    if (packages.length === 0) {
      throw new Error(
        `plugins/${dir.name} has no signed package. Build it and run: pnpm sign:plugins`,
      );
    }

    for (const file of packages) {
      const { envelope, payload } = await openPackage(
        fs.readFileSync(path.join(pkgDir, file)),
      );
      verifyFirstParty(envelope, payload, pinned);

      const manifest = envelope.manifest as PackageManifest & {
        permissions?: string[];
        capabilities?: string[];
      };

      const plugin = await db.plugin.upsert({
        where: { key: manifest.id },
        update: {
          name: manifest.name,
          description: manifest.description ?? null,
          isCore: true,
        },
        create: {
          key: manifest.id,
          name: manifest.name,
          description: manifest.description ?? null,
          publisher: manifest.author.name,
          // Platform-controlled, and set only here. A manifest cannot claim it — the
          // admin content operator uses `isCore` as an identity check, so a
          // marketplace package that could set it would be a privilege escalation.
          isCore: true,
        },
      });

      await db.pluginVersion.upsert({
        where: { pluginId_version: { pluginId: plugin.id, version: manifest.version } },
        update: {
          manifest: manifest as never,
          permissions: manifest.permissions ?? [],
          checksum: envelope.checksum,
          publisherSignature: envelope.publisherSignature,
          // Reset to BUILTIN and drop any marketplace fields a prior install left, so
          // a re-seed cannot leave this key claiming two origins at once — which would
          // send plugin-runtime down the wrong verify path.
          origin: "BUILTIN",
          bundleUrl: null,
          marketplaceSignature: null,
        },
        create: {
          pluginId: plugin.id,
          version: manifest.version,
          engine: manifest.engine,
          manifest: manifest as never,
          permissions: manifest.permissions ?? [],
          // The digest the signature covers, recorded so the row can be tied back to
          // the artefact it came from.
          checksum: envelope.checksum,
          publisherSignature: envelope.publisherSignature,
          // BUILTIN, no bundleUrl: plugin-runtime reads it from PLUGIN_DIR and verifies
          // the .zcms against the first-party key, not whatever is on the volume.
          origin: "BUILTIN",
        },
      });

      const network = (manifest as { network?: { hosts?: string[] } }).network;
      console.log(
        `  ${manifest.id}@${manifest.version} — ` +
          `requests: ${manifest.permissions?.join(", ") || "(none)"}` +
          (network?.hosts?.length ? ` — reaches: ${network.hosts.join(", ")}` : ""),
      );
      seeded++;
    }
  }

  console.log(`\n${seeded} signed built-in plugin(s) registered in the catalogue.`);
  console.log(
    "A site gets them INSTALLED but switched OFF, with nothing granted " +
      "(see installCorePlugins). Turning one on is where the admin consents to the " +
      "permissions and the hosts above.",
  );
}

main()
  .catch((err) => {
    console.error(`\n${(err as Error).message}\n`);
    process.exitCode = 1;
  })
  .finally(disconnectDb);
