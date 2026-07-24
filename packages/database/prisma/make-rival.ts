import path from "node:path";
import { config as loadEnv } from "dotenv";

loadEnv({ path: path.resolve(__dirname, "../../../.env"), quiet: true });

import { getSystemDb, disconnectDb } from "../src/clients";

/**
 * Creates a second tenant with a site and a confidential page, so the API's
 * cross-tenant defences can be attacked from the outside rather than assumed.
 * Prints the rival site's id for the attacking request to aim at.
 */
async function main() {
  const db = getSystemDb();

  const tenant = await db.tenant.upsert({
    where: { slug: "rival" },
    update: {},
    create: { slug: "rival", name: "Rival Corp" },
  });

  const site = await db.site.upsert({
    where: { tenantId_slug: { tenantId: tenant.id, slug: "s" } },
    update: {},
    create: { tenantId: tenant.id, slug: "s", name: "Rival Site", status: "PUBLISHED" },
  });

  const type = await db.contentType.upsert({
    where: { siteId_key: { siteId: site.id, key: "page" } },
    update: {},
    create: {
      tenantId: tenant.id,
      siteId: site.id,
      key: "page",
      name: "Page",
      pluralName: "Pages",
    },
  });

  const existing = await db.content.findFirst({
    where: { siteId: site.id, locale: "vi", slug: "secret", demoThemeKey: null },
  });
  if (existing) {
    await db.content.update({ where: { id: existing.id }, data: {} });
  } else {
    await db.content.create({
      data: {
      tenantId: tenant.id,
      siteId: site.id,
      contentTypeId: type.id,
      locale: "vi",
      slug: "secret",
      title: "RIVAL CONFIDENTIAL",
      status: "PUBLISHED",
      },
    });
  }

  console.log(site.id);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(disconnectDb);
