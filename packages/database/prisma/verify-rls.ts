import path from "node:path";
import { config as loadEnv } from "dotenv";

loadEnv({ path: path.resolve(__dirname, "../../../.env"), quiet: true });

import { getSystemDb, getTenantDb, disconnectDb } from "../src/clients";
import { withTenant, db } from "../src/tenant-context";

/**
 * Proves tenant isolation actually holds at the database level.
 *
 * Each check runs a query that a careless developer could plausibly write —
 * `findMany()` with no tenant filter at all — and asserts the database still
 * refuses to hand over another tenant's rows. If any check fails, RLS is not
 * protecting us and the app is one forgotten `where` clause away from a leak.
 */

const system = getSystemDb();
let failures = 0;

function check(name: string, passed: boolean, detail: string) {
  console.log(`${passed ? "  PASS" : "  FAIL"}  ${name}\n        ${detail}`);
  if (!passed) failures++;
}

async function main() {
  // Two tenants, one page each. No app code will filter between them below.
  const a = await system.tenant.upsert({
    where: { slug: "rls-test-a" },
    update: {},
    create: { slug: "rls-test-a", name: "Tenant A" },
  });
  const b = await system.tenant.upsert({
    where: { slug: "rls-test-b" },
    update: {},
    create: { slug: "rls-test-b", name: "Tenant B" },
  });

  for (const [tenant, label] of [[a, "A"], [b, "B"]] as const) {
    const site = await system.site.upsert({
      where: { tenantId_slug: { tenantId: tenant.id, slug: "s" } },
      update: {},
      create: { tenantId: tenant.id, slug: "s", name: `Site ${label}` },
    });
    const type = await system.contentType.upsert({
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
    const existing = await system.content.findFirst({
      where: { siteId: site.id, locale: "vi", slug: "secret", demoThemeKey: null },
    });
    if (existing) {
      await system.content.update({ where: { id: existing.id }, data: {} });
    } else {
      await system.content.create({
        data: {
        tenantId: tenant.id,
        siteId: site.id,
        contentTypeId: type.id,
        locale: "vi",
        slug: "secret",
        title: `SECRET OF TENANT ${label}`,
        },
      });
    }
  }

  console.log("\nRLS verification\n");

  // 1. The unfiltered query every CMS eventually ships by accident.
  await withTenant(a.id, async () => {
    const rows = await db().content.findMany();
    const leaked = rows.filter((r) => r.tenantId !== a.id);
    check(
      "unfiltered findMany() inside tenant A",
      rows.length > 0 && leaked.length === 0,
      `saw ${rows.length} row(s), ${leaked.length} belonging to another tenant`,
    );
  });

  // 2. Explicitly asking for another tenant's row by primary key.
  const bSecret = await system.content.findFirst({
    where: { tenantId: b.id, slug: "secret" },
  });
  await withTenant(a.id, async () => {
    const row = await db().content.findUnique({ where: { id: bSecret!.id } });
    check(
      "findUnique() on tenant B's row id, from tenant A",
      row === null,
      row === null ? "returned null" : `LEAKED: "${row.title}"`,
    );
  });

  // 3. Writing a row stamped with someone else's tenant id. WITH CHECK should
  //    reject it, so a compromised or buggy service cannot plant data.
  await withTenant(a.id, async () => {
    const siteB = await system.site.findFirst({ where: { tenantId: b.id } });
    const typeB = await system.contentType.findFirst({ where: { tenantId: b.id } });
    let rejected = false;
    let note = "";
    try {
      await db().content.create({
        data: {
          tenantId: b.id,
          siteId: siteB!.id,
          contentTypeId: typeB!.id,
          locale: "vi",
          slug: "planted",
          title: "planted by tenant A",
        },
      });
      note = "INSERT SUCCEEDED — WITH CHECK is not enforcing";
    } catch (err) {
      rejected = true;
      note = `rejected: ${(err as Error).message.split("\n").find((l) => l.includes("policy")) ?? "row-level security policy"}`;
    }
    check("insert row stamped with tenant B, from tenant A", rejected, note);
  });

  // 4. No tenant context at all. Must fail closed (zero rows), never open.
  const raw = getTenantDb();
  const noCtx = await raw.content.findMany();
  check(
    "query with no tenant context set",
    noCtx.length === 0,
    noCtx.length === 0
      ? "returned 0 rows (fails closed)"
      : `LEAKED ${noCtx.length} row(s) across all tenants`,
  );

  // 5. The app role must not be able to switch RLS off.
  let cannotDisable = false;
  let disableNote = "";
  try {
    await raw.$executeRawUnsafe(`ALTER TABLE contents DISABLE ROW LEVEL SECURITY`);
    disableNote = "app role DISABLED RLS — it must not own the tables";
  } catch (err) {
    cannotDisable = true;
    disableNote = `denied: ${(err as Error).message.split("\n")[0]?.trim()}`;
  }
  check("app role tries to disable RLS", cannotDisable, disableNote);

  // 6. The regression guard. RLS is not automatic for new tables: a migration
  //    that adds one without a policy produces a table that works perfectly and
  //    silently returns every tenant's rows. Rather than trusting the next
  //    person to remember, assert it — any table carrying tenant_id must have
  //    row security enabled and a policy attached.
  const unprotected = await system.$queryRaw<{ table: string; reason: string }[]>`
    SELECT c.relname AS "table",
           CASE WHEN NOT c.relrowsecurity THEN 'RLS disabled'
                ELSE 'no policy' END AS reason
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id'
                       AND NOT a.attisdropped
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND (
        NOT c.relrowsecurity
        OR NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid)
      )
  `;
  check(
    "every table with tenant_id is protected by RLS",
    unprotected.length === 0,
    unprotected.length === 0
      ? "no unprotected tenant tables"
      : `UNPROTECTED: ${unprotected.map((r) => `${r.table} (${r.reason})`).join(", ")}`,
  );

  // Cleanup.
  await system.tenant.deleteMany({ where: { slug: { in: ["rls-test-a", "rls-test-b"] } } });

  console.log(
    failures === 0
      ? "\nAll RLS checks passed — tenant isolation is enforced by Postgres.\n"
      : `\n${failures} RLS CHECK(S) FAILED — tenant isolation is NOT safe.\n`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(disconnectDb);
