import { definePlugin, type PluginContext } from "@zcmsorg/plugin-sdk";

/**
 * Customers (CRM) — the reference plugin for building a small business app on
 * Z-CMS, and the end-to-end test of the plugin framework's newer capabilities.
 *
 * Like Shop Manager it OWNS A TABLE and ships no admin code: it declares one
 * `customers` table and one CRUD screen in the manifest, and core renders the
 * list/form. What it demonstrates beyond Shop Manager is everything a real app
 * needs from that declaration —
 *
 *   - every label (menu, screen, columns, fields, and each `stage` choice) is a
 *     `{ en, vi, ja }` map, so the whole screen speaks the reader's language;
 *   - the form exercises the richer field types core now renders for a plugin:
 *     a labelled `select`, a `number`, a `date`, a `textarea`, a `media` picker;
 *   - the column types (`numeric`, `timestamptz`, `uuid`) are coerced from the
 *     form and validated against the schema before a write.
 *
 * A developer can copy this directory, rename the id and table, reshape the
 * columns, and have an HR directory, an asset register or a ticket queue — same
 * mechanism, no core changes. There is no SQL and no database handle here: `ctx.db`
 * is a sandboxed, parameterised RPC scoped to this plugin's own table and site.
 */

const CUSTOMERS = "p_vn_zsoft_plugin_crm__customers";

/**
 * Insert `rows` only if this site's table is still empty. `setup()` re-runs on
 * every activation, so seeding must be idempotent, and `ctx.db.select` is already
 * scoped to this site — "empty" means "this site has not been seeded".
 */
async function seedIfEmpty(
  ctx: PluginContext,
  table: string,
  rows: Record<string, unknown>[],
): Promise<number> {
  const existing = await ctx.db.select(table, { limit: 1 });
  if (existing.length > 0) return 0;
  for (const row of rows) await ctx.db.insert(table, row);
  return rows.length;
}

export default definePlugin({
  manifest: {
    id: "vn.zsoft.plugin.crm",
    name: "Customers (CRM)",
    version: "0.1.0",
    author: { name: "Z-SOFT Co., Ltd" },
    engine: ">=0.1.0",
    permissions: ["data:own"],
    capabilities: ["crm.management"],
  },

  setup: async (ctx) => {
    const seeded = await seedIfEmpty(ctx, CUSTOMERS, [
      {
        name: "Anh Minh",
        email: "minh@example.com",
        stage: "customer",
        deal_value: 1200,
        notes: "Repeat buyer — prefers express shipping.",
        last_contacted: "2026-07-20T02:00:00.000Z",
      },
      {
        name: "Bảo Châu",
        email: "chau@example.com",
        stage: "qualified",
        deal_value: 450,
        notes: "Asked for a bulk quote.",
        last_contacted: "2026-07-24T09:30:00.000Z",
      },
      {
        name: "Công ty Lá Xanh",
        email: "hello@laxanh.example",
        stage: "lead",
        deal_value: null,
        notes: "Inbound from the contact form.",
        last_contacted: null,
      },
    ]);

    ctx.log.info(`Customers (CRM) ready on "${ctx.site.name}": seeded ${seeded} customers.`);
  },
});
