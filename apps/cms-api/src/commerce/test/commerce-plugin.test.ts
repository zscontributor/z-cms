import { describe, expect, it } from "vitest";
import { validateAdminContribution, validatePluginTableSchemas } from "@zcmsorg/plugin-sdk";
import { pluginPermissionGrants, validateProvidedPermissions } from "@zcmsorg/schemas";
import { COMMERCE_PLUGIN_KEY, COMMERCE_PLUGIN_MANIFEST } from "../commerce-plugin";

/**
 * The commerce plugin's manifest is what every gate on it reads — install
 * validation, the permission resolver, the render projector. If it drifts out of
 * what those accept, commerce silently stops installing or stops granting. These
 * assert it stays valid against the very functions the install path runs.
 */
describe("COMMERCE_PLUGIN_MANIFEST", () => {
  it("is a codeless first-party plugin", () => {
    expect(COMMERCE_PLUGIN_MANIFEST.id).toBe(COMMERCE_PLUGIN_KEY);
    expect(COMMERCE_PLUGIN_MANIFEST.runtime).toBe("core");
    // Requests no core scopes — it is core, it does not call the gateway.
    expect(COMMERCE_PLUGIN_MANIFEST.permissions).toEqual([]);
  });

  it("provides commerce.checkout, the capability its render projector is keyed to", () => {
    expect(COMMERCE_PLUGIN_MANIFEST.capabilities).toContain("commerce.checkout");
  });

  it("declares provided-permissions the install gate accepts from a first-party plugin", () => {
    const violations = validateProvidedPermissions(
      COMMERCE_PLUGIN_KEY,
      true, // isCore — bare keys like order:read are allowed only here
      COMMERCE_PLUGIN_MANIFEST.permissionsProvided,
    );
    expect(violations).toEqual([]);
  });

  it("owns no tables and contributes no admin resources", () => {
    expect(validatePluginTableSchemas(COMMERCE_PLUGIN_KEY, COMMERCE_PLUGIN_MANIFEST.database?.tables)).toEqual([]);
    expect(validateAdminContribution(COMMERCE_PLUGIN_MANIFEST.admin, undefined)).toEqual([]);
  });

  it("grants order:read to EDITOR but withholds order:manage", () => {
    const provided = COMMERCE_PLUGIN_MANIFEST.permissionsProvided ?? [];
    const editor = pluginPermissionGrants(["EDITOR"], provided);
    expect(editor).toContain("order:read");
    expect(editor).not.toContain("order:manage");
    expect(editor).not.toContain("commerce:configure");
  });

  it("grants an OWNER everything the shop needs, since a session carries one role", () => {
    // The reason defaultRoles lists OWNER explicitly: an OWNER membership resolves
    // to role "OWNER", not "ADMIN", so ADMIN-only grants would miss it otherwise.
    const owner = pluginPermissionGrants(["OWNER"], COMMERCE_PLUGIN_MANIFEST.permissionsProvided ?? []);
    expect(new Set(owner)).toEqual(new Set(["order:read", "order:manage", "commerce:configure"]));
  });

  it("grants a plain AUTHOR nothing — the shop is not theirs", () => {
    expect(pluginPermissionGrants(["AUTHOR"], COMMERCE_PLUGIN_MANIFEST.permissionsProvided ?? [])).toEqual([]);
  });
});
