import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  resolvePluginAdminResource,
  validateAdminContribution,
  validatePluginTableSchemas,
  type PluginManifest,
} from "@zcmsorg/plugin-sdk";
import { validateProvidedPermissions } from "@zcmsorg/schemas";
import plugin from "../src/index";

const manifest = JSON.parse(
  readFileSync(join(__dirname, "..", "plugin.json"), "utf8"),
) as PluginManifest;

describe("Product Catalog manifest", () => {
  it("declares a table, provided permissions and admin screens the install gate accepts", () => {
    expect(validatePluginTableSchemas(manifest.id, manifest.database?.tables)).toEqual([]);
    expect(validateProvidedPermissions(manifest.id, true, manifest.permissionsProvided)).toEqual([]);
    expect(validateAdminContribution(manifest.admin, manifest.database?.tables)).toEqual([]);
  });

  it("provides the catalog.search capability the public query endpoint resolves", () => {
    expect(manifest.capabilities).toContain("catalog.search");
  });

  it("localizes the category options while keeping stable stored values", () => {
    const resource = manifest.admin!.resources!.find((r) => r.key === "products")!;
    const resolved = resolvePluginAdminResource(resource, "vi");
    const category = resolved.form!.fields.find((f) => f.column === "category")!;
    expect(category.options).toEqual([
      { value: "skincare", label: "Chăm sóc da" },
      { value: "makeup", label: "Trang điểm" },
      { value: "fragrance", label: "Nước hoa" },
      { value: "body", label: "Cơ thể" },
    ]);
  });
});

describe("Product Catalog query call", () => {
  const rows = [
    { name: "Glow Serum", slug: "glow-serum", category: "skincare", cost: 20, price: 48, discount_percent: 25, in_stock: true },
    { name: "Quiet Milk Cleanser", slug: "quiet-milk-cleanser", category: "skincare", cost: 11, price: 26, in_stock: true },
  ];

  function ctxWith(select: ReturnType<typeof vi.fn>) {
    return { db: { select } } as never;
  }

  it("maps the filter to a ctx.db.select with the where operators", async () => {
    const select = vi.fn().mockResolvedValue(rows);
    await plugin.calls!.query!(
      { params: { q: "milk", category: "skincare", inStock: "true", minPrice: "20" } },
      ctxWith(select),
    );

    const [table, options] = select.mock.calls[0]!;
    expect(table).toBe("p_vn_zsoft_plugin_catalog__products");
    expect(options.where).toEqual({
      category: "skincare",
      name: { op: "contains", value: "milk" },
      in_stock: true,
      price: { op: "gte", value: 20 },
    });
  });

  it("computes the effective price from the discount and never leaks cost", async () => {
    const select = vi.fn().mockResolvedValue([rows[0]]); // Glow Serum, 25% off
    const result = (await plugin.calls!.query!(
      { params: {} },
      ctxWith(select),
    )) as { items: Array<Record<string, unknown>> };

    expect(result.items[0]).toEqual({
      name: "Glow Serum",
      slug: "glow-serum",
      category: "skincare",
      price: 48,
      effectivePrice: 36, // 48 * (1 - 25/100)
      onSale: true,
      inStock: true,
      url: "/shop/glow-serum",
    });
    expect(result.items[0]).not.toHaveProperty("cost"); // giá nhập never public
  });

  it("refines the upper price bound against the effective (discounted) price", async () => {
    const select = vi.fn().mockResolvedValue(rows);
    const result = (await plugin.calls!.query!(
      { params: { maxPrice: "30" } },
      ctxWith(select),
    )) as { items: Array<Record<string, unknown>> };

    // Glow Serum lists at 48 but pays 36 (still > 30, excluded); Quiet Milk at 26 stays.
    expect(result.items.map((i) => i.slug)).toEqual(["quiet-milk-cleanser"]);
  });
});
