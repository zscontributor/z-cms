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
/**
 * The commerce plugin has no signed package, because it has no bundle: it is a
 * `runtime: "core"` first-party plugin whose logic is the core CommerceModule (see
 * apps/cms-api/src/commerce/commerce-plugin.ts, the runtime source of its key). It
 * is registered here directly so a site gets it INSTALLED-but-OFF like every other
 * built-in, and turning it on is what makes that site a shop.
 *
 * This manifest must stay in step with COMMERCE_PLUGIN_MANIFEST in cms-api. It is
 * duplicated rather than imported because a seed in the database package cannot
 * reach into an app; the shape is small and changes rarely.
 */
const COMMERCE_MANIFEST = {
  id: "vn.zsoft.commerce",
  name: "Commerce",
  version: "1.0.0",
  description:
    "The storefront: a cart, COD checkout and orders. Activate it on a site to turn " +
    "that site into a shop; leave it off and the site has no commerce at all.",
  author: { name: "Z-SOFT" },
  engine: ">=0.1.0",
  runtime: "core",
  permissions: [] as string[],
  capabilities: ["commerce.checkout"],
  permissionsProvided: [
    {
      key: "order:read",
      description:
        "Read the shop's orders — customer names, contact details and delivery addresses.",
      defaultRoles: ["EDITOR", "ADMIN", "OWNER"],
    },
    {
      key: "order:manage",
      description: "Move an order along: confirm, fulfil, cancel or refund it.",
      defaultRoles: ["ADMIN", "OWNER"],
    },
    {
      key: "commerce:configure",
      description: "Configure the storefront: currency, shipping and payment methods.",
      defaultRoles: ["ADMIN", "OWNER"],
    },
  ],
};

async function registerCommercePlugin(db: ReturnType<typeof getSystemDb>): Promise<void> {
  const plugin = await db.plugin.upsert({
    where: { key: COMMERCE_MANIFEST.id },
    update: { name: COMMERCE_MANIFEST.name, description: COMMERCE_MANIFEST.description, isCore: true, scope: "SITE" as never },
    create: {
      key: COMMERCE_MANIFEST.id,
      name: COMMERCE_MANIFEST.name,
      description: COMMERCE_MANIFEST.description,
      publisher: COMMERCE_MANIFEST.author.name,
      isCore: true,
      scope: "SITE" as never,
    },
  });

  await db.pluginVersion.upsert({
    where: { pluginId_version: { pluginId: plugin.id, version: COMMERCE_MANIFEST.version } },
    update: {
      manifest: COMMERCE_MANIFEST as never,
      permissions: COMMERCE_MANIFEST.permissions,
      // Codeless: no bundle, no signature. plugin-runtime never loads it — a
      // core-runtime plugin is skipped by the sandbox dispatch entirely.
      origin: "BUILTIN",
      bundleUrl: null,
      checksum: null,
      publisherSignature: null,
      marketplaceSignature: null,
    },
    create: {
      pluginId: plugin.id,
      version: COMMERCE_MANIFEST.version,
      engine: COMMERCE_MANIFEST.engine,
      manifest: COMMERCE_MANIFEST as never,
      permissions: COMMERCE_MANIFEST.permissions,
      origin: "BUILTIN",
    },
  });

  console.log(`  ${COMMERCE_MANIFEST.id}@${COMMERCE_MANIFEST.version} — core-runtime (no bundle), provides: order:read, order:manage, commerce:configure`);
}

async function main() {
  const db = getSystemDb();
  const root = path.resolve(__dirname, "../../../plugins");

  // Codeless first-party plugins first — they have no package on disk to loop over.
  await registerCommercePlugin(db);

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

    // A `.not-builtin` marker means this plugin is PRIVATE and marketplace-distributed,
    // signed with a publisher key (not the first-party key) and installed from the
    // registry — never registered as a built-in. Skip it, exactly as seed-themes does,
    // so its publisher-signed .zcms does not fail verifyFirstParty here.
    if (fs.existsSync(path.join(pkgDir, ".not-builtin"))) {
      console.log(`  skip ${dir.name} — .not-builtin (marketplace-distributed, installed from the registry)`);
      continue;
    }

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
        scope?: string;
      };

      // A built-in may declare ORG reach to activate tenant-wide; the default is
      // per-site. Unlike `isCore` (authority), scope is reach, so a package naming
      // it is not an escalation — it still consents at whichever tier it installs.
      const scope = String(manifest.scope).toLowerCase() === "org" ? "ORG" : "SITE";

      const plugin = await db.plugin.upsert({
        where: { key: manifest.id },
        update: {
          name: manifest.name,
          description: manifest.description ?? null,
          isCore: true,
          scope: scope as never,
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
          scope: scope as never,
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
