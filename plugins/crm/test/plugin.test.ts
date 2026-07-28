import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  resolveLocalized,
  resolvePluginAdminResource,
  validateAdminContribution,
  validatePluginTableSchemas,
  type PluginManifest,
} from "@zcmsorg/plugin-sdk";
import { validateProvidedPermissions } from "@zcmsorg/schemas";

/**
 * The CRM manifest is the reference a developer copies, so it must pass every gate
 * cms-api runs at install — AND exercise the framework's newer surface: localized
 * labels and a labelled select. These assertions keep both true.
 */
const manifest = JSON.parse(
  readFileSync(join(__dirname, "..", "plugin.json"), "utf8"),
) as PluginManifest;

describe("Customers (CRM) manifest", () => {
  it("requests data:own — it owns a table and seeds it through ctx.db", () => {
    expect(manifest.permissions).toContain("data:own");
  });

  it("declares a table the install gate accepts (own prefix, valid columns)", () => {
    expect(validatePluginTableSchemas(manifest.id, manifest.database?.tables)).toEqual([]);
  });

  it("provides permissions the install gate accepts from a first-party plugin", () => {
    expect(validateProvidedPermissions(manifest.id, true, manifest.permissionsProvided)).toEqual([]);
  });

  it("declares admin screens whose every reference and label the gate accepts", () => {
    expect(validateAdminContribution(manifest.admin, manifest.database?.tables)).toEqual([]);
  });

  it("gates every admin resource with a permission it actually provides", () => {
    const provided = new Set((manifest.permissionsProvided ?? []).map((p) => p.key));
    for (const resource of manifest.admin?.resources ?? []) {
      expect(provided.has(resource.permissions.read)).toBe(true);
      if (resource.permissions.write) expect(provided.has(resource.permissions.write)).toBe(true);
    }
  });

  it("points every nav entry at a real resource and a provided permission", () => {
    const resourceKeys = new Set((manifest.admin?.resources ?? []).map((r) => r.key));
    const provided = new Set((manifest.permissionsProvided ?? []).map((p) => p.key));
    for (const item of manifest.admin?.nav ?? []) {
      expect(resourceKeys.has(item.resource)).toBe(true);
      expect(provided.has(item.permission)).toBe(true);
    }
  });

  it("localizes labels, resolving to the reader's language with English fallback", () => {
    const nav = manifest.admin?.nav?.[0];
    expect(resolveLocalized(nav?.label, "vi")).toBe("Khách hàng");
    expect(resolveLocalized(nav?.label, "ja")).toBe("顧客");
    // An unknown locale falls back to English, never to "[object Object]".
    expect(resolveLocalized(nav?.label, "fr")).toBe("Customers");
  });

  it("resolves a whole resource to plain strings and labelled options for one reader", () => {
    const resource = manifest.admin!.resources!.find((r) => r.key === "customers")!;
    const resolved = resolvePluginAdminResource(resource, "vi");

    expect(resolved.label).toBe("Khách hàng");
    expect(resolved.list.columns.map((c) => c.label)).toContain("Giai đoạn");

    const stage = resolved.form!.fields.find((f) => f.column === "stage")!;
    // The stored value stays stable across languages; only the label is translated.
    expect(stage.options).toEqual([
      { value: "lead", label: "Tiềm năng" },
      { value: "qualified", label: "Đủ điều kiện" },
      { value: "customer", label: "Khách hàng" },
      { value: "lost", label: "Đã mất" },
    ]);
  });
});
