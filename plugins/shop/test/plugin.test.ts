import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  validateAdminContribution,
  validatePluginTableSchemas,
  type PluginManifest,
} from "@zcmsorg/plugin-sdk";
import { validateProvidedPermissions } from "@zcmsorg/schemas";

/**
 * The manifest is the contract every gate reads — install validation, the table
 * DDL, the admin registry, the permission resolver. These assert plugin.json stays
 * valid against the very functions cms-api runs at install, so a typo cannot ship
 * a plugin that refuses to install or silently loses a screen.
 */
const manifest = JSON.parse(
  readFileSync(join(__dirname, "..", "plugin.json"), "utf8"),
) as PluginManifest;

describe("Shop Manager manifest", () => {
  it("requests data:own — it owns tables and seeds them through ctx.db", () => {
    expect(manifest.permissions).toContain("data:own");
  });

  it("declares tables the install gate accepts (own prefix, valid columns)", () => {
    expect(validatePluginTableSchemas(manifest.id, manifest.database?.tables)).toEqual([]);
  });

  it("provides permissions the install gate accepts from a first-party plugin", () => {
    expect(validateProvidedPermissions(manifest.id, true, manifest.permissionsProvided)).toEqual([]);
  });

  it("declares admin screens whose every reference resolves to its own tables", () => {
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
});
