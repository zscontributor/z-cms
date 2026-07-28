import { definePlugin, type PluginContext } from "@zcmsorg/plugin-sdk";

/**
 * Product Catalog — the reference for a PUBLIC, filterable plugin.
 *
 * Unlike the CRM sample (whose customers are back-office), a product catalogue is
 * meant to be seen, so this plugin is the honest place to demonstrate the
 * plugin-query pattern end to end:
 *
 *   - it OWNS a `products` table and renders admin CRUD from the manifest, exactly
 *     like the CRM sample;
 *   - it provides the `catalog.search` capability and implements the fixed public
 *     `query` call, so a theme's filter form (search box, category, price, in-stock)
 *     drives a live `ctx.db.select` — using the where operators — and gets rows back
 *     with no page reload;
 *   - the `query` handler returns only public-safe fields. There is no cost price
 *     here; if there were, it would never be in what `query` returns.
 *
 * A theme wires the storefront up with the runtime widget contract — a
 * `<form data-zc-query="catalog.search">` and a `<template data-zc-query-item>`;
 * see the plugin handbook, "Data tables and admin screens → Expose a filtered list
 * to a theme".
 */

const PRODUCTS = "p_vn_zsoft_plugin_catalog__products";

interface ProductRow {
  name: string;
  slug: string;
  category: string;
  cost?: number | string | null;
  price: number | string;
  sale_price?: number | string | null;
  discount_percent?: number | string | null;
  in_stock: boolean;
  featured?: boolean;
  image?: string | null;
}

/**
 * One public-safe product, as the storefront widget renders it. `cost` (giá nhập)
 * is deliberately ABSENT — it is stored on the row and editable in the admin, but a
 * public query must never return it.
 */
interface CatalogItem {
  name: string;
  slug: string;
  category: string;
  price: number;
  effectivePrice: number;
  onSale: boolean;
  inStock: boolean;
  url: string;
}

function num(value: unknown): number {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : 0;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * The price a customer actually pays: a percentage discount wins when set, else an
 * absolute promo price below the list price, else the list price. Both discount
 * forms are supported; the percentage takes priority when both are present.
 */
function effectivePrice(base: number, salePrice: number | null, percent: number | null): number {
  if (percent !== null && percent > 0 && percent <= 100) return round2(base * (1 - percent / 100));
  if (salePrice !== null && salePrice >= 0 && salePrice < base) return salePrice;
  return base;
}

/** A finite number, or null — for the optional cost/sale/percent columns. */
function optNum(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

/** Insert `rows` only if this site's table is still empty (idempotent seed). */
async function seedIfEmpty(
  ctx: PluginContext,
  rows: Record<string, unknown>[],
): Promise<number> {
  const existing = await ctx.db.select(PRODUCTS, { limit: 1 });
  if (existing.length > 0) return 0;
  for (const row of rows) await ctx.db.insert(PRODUCTS, row);
  return rows.length;
}

export default definePlugin({
  manifest: {
    id: "vn.zsoft.plugin.catalog",
    name: "Product Catalog",
    version: "0.1.0",
    author: { name: "Z-SOFT Co., Ltd" },
    engine: ">=0.1.0",
    permissions: ["data:own"],
    capabilities: ["catalog.search"],
  },

  setup: async (ctx) => {
    const seeded = await seedIfEmpty(ctx, [
      { name: "Glow Serum · Vitamin C 15%", slug: "glow-serum", category: "skincare", cost: 20, price: 48, discount_percent: 20, in_stock: true, featured: true },
      { name: "Quiet Milk Cleanser", slug: "quiet-milk-cleanser", category: "skincare", cost: 11, price: 26, in_stock: true },
      { name: "Velvet Lip Balm · Rosewood", slug: "velvet-lip-balm", category: "makeup", cost: 6, price: 18, sale_price: 14, in_stock: true },
      { name: "Amber Veil Eau de Parfum", slug: "amber-veil-edp", category: "fragrance", cost: 40, price: 92, in_stock: false, featured: true },
      { name: "Soft Cloud Body Cream", slug: "soft-cloud-body-cream", category: "body", cost: 15, price: 34, in_stock: true },
    ]);
    ctx.log.info(`Product Catalog ready on "${ctx.site.name}": seeded ${seeded} products.`);
  },

  calls: {
    /**
     * The public query, reached at
     * `/plugin-query/catalog.search?q=serum&category=skincare&inStock=true&maxPrice=50`.
     *
     * It maps the visitor's filter to a `ctx.db.select` — equality for `category`,
     * a case-insensitive `contains` for the search box, a `gte` for a minimum price
     * — and refines the upper price bound in-handler (a `where` holds one condition
     * per column, so a range with both bounds is expressed here, not in SQL). It
     * returns only public fields.
     */
    query: async ({ params }, ctx) => {
      const p = params as Record<string, string>;
      const where: Record<string, unknown> = {};

      if (p.category) where.category = p.category;
      if (p.q) where.name = { op: "contains", value: p.q };
      if (p.inStock === "true" || p.inStock === "1") where.in_stock = true;
      if (p.minPrice) where.price = { op: "gte", value: num(p.minPrice) };

      const rows = (await ctx.db.select(PRODUCTS, {
        where,
        orderBy: { column: "name", direction: "asc" },
        limit: 60,
      })) as ProductRow[];

      const maxPrice = p.maxPrice ? num(p.maxPrice) : null;
      const items: CatalogItem[] = rows
        .map((row) => {
          const price = num(row.price);
          const eff = effectivePrice(price, optNum(row.sale_price), optNum(row.discount_percent));
          return {
            name: row.name,
            slug: row.slug,
            category: row.category,
            price,
            effectivePrice: eff,
            onSale: eff < price,
            inStock: row.in_stock === true,
            url: `/shop/${row.slug}`,
            // NOTE: `row.cost` (giá nhập) is intentionally never included here.
          };
        })
        // The upper bound is on what the customer actually pays.
        .filter((item) => maxPrice === null || item.effectivePrice <= maxPrice);

      return { items };
    },
  },
});
