import { definePlugin, type PluginContext } from "@zcmsorg/plugin-sdk";

/**
 * Shop Manager — the reference first-party plugin that OWNS TABLES.
 *
 * It is the worked example of everything a plugin can do on Z-CMS beyond reacting
 * to events: it declares its own relational tables (inventory, shipping, payment)
 * in the manifest, core creates them on activation, and this `setup()` seeds a
 * cosmetics-shop demo into them through `ctx.db` — the sandboxed, parameterised
 * tables API. The management screens are declared in the manifest too (see
 * `admin`), so core renders the list/edit UI and this plugin ships no admin code.
 *
 * There is no SQL anywhere in here, and no database handle: `ctx.db` is an RPC to
 * the host, which builds the query, checks the table is one this plugin declared,
 * and stamps the site and tenant from the plugin's token. A community plugin could
 * not own these tables at all — that is a first-party privilege — but everything
 * it does with them, it does through exactly this API.
 */

interface ShopSettings {
  storeName: string;
  lowStockThreshold: number;
}

const INVENTORY = "p_vn_zsoft_plugin_shop__inventory";
const SHIPPING = "p_vn_zsoft_plugin_shop__shipping";
const PAYMENT = "p_vn_zsoft_plugin_shop__payment";

/**
 * Insert `rows` only if the table has none for this site yet. `setup()` re-runs on
 * every activation, so seeding must be idempotent — and `ctx.db.select` is already
 * scoped to this site, so "empty" means "this site has not been seeded", not "no
 * one anywhere has".
 */
async function seedIfEmpty(
  ctx: PluginContext<ShopSettings>,
  table: string,
  rows: Record<string, unknown>[],
): Promise<number> {
  const existing = await ctx.db.select(table, { limit: 1 });
  if (existing.length > 0) return 0;
  for (const row of rows) await ctx.db.insert(table, row);
  return rows.length;
}

export default definePlugin<ShopSettings>({
  manifest: {
    id: "vn.zsoft.plugin.shop",
    name: "Shop Manager",
    version: "0.1.0",
    author: { name: "Z-SOFT Co., Ltd" },
    engine: ">=0.1.0",
    permissions: ["data:own"],
    capabilities: ["shop.management"],
  },

  setup: async (ctx) => {
    const reorder = Number(ctx.settings.lowStockThreshold) || 20;

    const inventory = await seedIfEmpty(ctx, INVENTORY, [
      { sku: "LUM-SER-30", product: "Glow Serum · Vitamin C 15%", stock: 120, warehouse: "HCM-01", reorder_level: reorder, cost: 20, price: 48, discount_percent: 20 },
      { sku: "LUM-CLN-150", product: "Quiet Milk Cleanser", stock: 80, warehouse: "HCM-01", reorder_level: reorder, cost: 11, price: 26 },
      { sku: "LUM-LIP-05", product: "Velvet Lip Balm · Rosewood", stock: 200, warehouse: "HN-02", reorder_level: reorder, cost: 6, price: 18, sale_price: 14 },
    ]);

    const shipping = await seedIfEmpty(ctx, SHIPPING, [
      { method: "Standard", zone: "Domestic", rate: 5, eta_days: 3, enabled: true },
      { method: "Express", zone: "Domestic", rate: 12, eta_days: 1, enabled: true },
      { method: "International", zone: "Worldwide", rate: 25, eta_days: 10, enabled: false },
    ]);

    const payment = await seedIfEmpty(ctx, PAYMENT, [
      { method: "Cash on delivery", kind: "Cash on delivery", instructions: "Pay the courier when your order arrives.", enabled: true },
      { method: "Bank transfer", kind: "Bank transfer", instructions: "Transfer to Lumière · VCB 0123456789, then reply with your order number.", enabled: true },
      { method: "Momo wallet", kind: "E-wallet", instructions: "Scan the QR at checkout to pay with Momo.", enabled: false },
    ]);

    ctx.log.info(
      `Shop Manager ready on "${ctx.site.name}": seeded ${inventory} inventory, ` +
        `${shipping} shipping and ${payment} payment rows.`,
    );
  },
});
