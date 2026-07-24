import fs from "node:fs";
import path from "node:path";
import { config as loadEnv } from "dotenv";

loadEnv({ path: path.resolve(__dirname, "../../../.env"), quiet: true });

import { getSystemDb, disconnectDb } from "../src/clients";

/**
 * Registers a publisher and an ACTIVE public key the marketplace will verify
 * package submissions against.
 *
 * This stands in for the publisher-account flow: sign up, prove who you are,
 * upload a public key, and have it verified. The key is the credential: from here
 * on, "is this package really from them?" is a signature check against an ACTIVE
 * PublisherKey row, not a judgement call per upload.
 *
 *   tsx prisma/register-publisher.ts <slug> <name> <public-key.pem>
 */
async function main() {
  const [slug, name, keyPath] = process.argv.slice(2);

  if (!slug || !name || !keyPath) {
    console.error("Usage: register-publisher <slug> <name> <public-key.pem>");
    process.exitCode = 1;
    return;
  }

  const publicKey = fs.readFileSync(keyPath, "utf8").trim();
  const db = getSystemDb();

  const publisher = await db.publisher.upsert({
    where: { slug },
    update: { name, verified: true },
    create: { slug, name, verified: true },
  });

  const existingKey = await db.publisherKey.findUnique({ where: { publicKey } });
  if (existingKey && existingKey.publisherId !== publisher.id) {
    throw new Error("That public key is already registered to another publisher.");
  }

  const key = existingKey
    ? await db.publisherKey.update({
        where: { id: existingKey.id },
        data: {
          status: "ACTIVE",
          label: "Registered key",
          verifiedAt: new Date(),
          retiredAt: null,
          revokedAt: null,
          revokeReason: null,
        },
      })
    : await db.publisherKey.create({
        data: {
          publisherId: publisher.id,
          publicKey,
          status: "ACTIVE",
          label: "Registered key",
          verifiedAt: new Date(),
        },
      });

  console.log(`Publisher "${publisher.name}" (${publisher.slug}) registered.`);
  console.log(`  key id: ${key.id}`);
  console.log(`  public key: ${publicKey.split("\n")[1]?.slice(0, 32)}…`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(disconnectDb);
