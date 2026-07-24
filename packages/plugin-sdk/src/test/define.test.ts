import { describe, expect, it, vi } from "vitest";
import { definePlugin, resolvePluginSettings } from "../define";
import type { Plugin } from "../define";
import type { PluginManifest, PluginSettingsSchema } from "../manifest";

/**
 * `definePlugin` is the identity function: a plugin's SHAPE is enforced by
 * TypeScript, and its MANIFEST (permissions, id) is validated by the marketplace
 * scanner on the built artifact, not here. So these tests pin the runtime contract
 * that exists — the plugin comes back exactly as written, and its handler map is
 * not silently rewritten.
 *
 * `resolvePluginSettings` runs against a stored JSONB blob written by an older
 * build of the plugin, which is where the real behaviour (and the real risk) is.
 */

const MANIFEST: PluginManifest = {
  id: "vn.zsoft.plugin.seo",
  name: "SEO",
  version: "1.0.0",
  author: { name: "Z-SOFT" },
  engine: ">=0.1.0",
  permissions: ["content:read"],
};

const SCHEMA: PluginSettingsSchema = {
  type: "object",
  properties: {
    apiKey: { type: "string", default: "" },
    maxItems: { type: "number", default: 50 },
    enabled: { type: "boolean", default: true },
  },
};

describe("definePlugin", () => {
  it("hands a valid plugin back untouched", () => {
    const plugin: Plugin = { manifest: MANIFEST };

    expect(definePlugin(plugin)).toBe(plugin);
  });

  it("preserves the exact handler map so the runtime dispatches what the author wrote", () => {
    // The runtime reads `plugin.actions["content.published"]` by key. A wrapper
    // that reordered or wrapped these would break dispatch or double-fire.
    const onPublish = vi.fn();
    const plugin = definePlugin({
      manifest: MANIFEST,
      actions: { "content.published": onPublish },
    });

    expect(plugin.actions?.["content.published"]).toBe(onPublish);
  });

  it("keeps the manifest identical, so what the marketplace approved is what runs", () => {
    expect(definePlugin({ manifest: MANIFEST }).manifest).toEqual(MANIFEST);
  });
});

describe("resolvePluginSettings", () => {
  it("fills every declared setting from its default when nothing is stored", () => {
    // A plugin activated but never configured has no settings row. Its handlers
    // read `settings.maxItems` with no guard, so an unfilled default is a crash.
    expect(resolvePluginSettings(SCHEMA, null)).toEqual({
      apiKey: "",
      maxItems: 50,
      enabled: true,
    });
  });

  it("prefers a stored value over the default", () => {
    expect(resolvePluginSettings(SCHEMA, { apiKey: "secret" })).toMatchObject({
      apiKey: "secret",
      maxItems: 50,
    });
  });

  it("fills in an option a plugin upgrade added that the stored blob predates", () => {
    // The reason it merges at read time: a plugin can add a setting without a
    // migration over every site's row.
    const storedBeforeUpgrade = { apiKey: "k" };

    expect(resolvePluginSettings(SCHEMA, storedBeforeUpgrade)).toEqual({
      apiKey: "k",
      maxItems: 50,
      enabled: true,
    });
  });

  it("treats a stored null as unset and uses the default", () => {
    expect(resolvePluginSettings(SCHEMA, { maxItems: null })).toMatchObject({ maxItems: 50 });
  });

  it("keeps a falsy value the site deliberately chose", () => {
    // `false`/`0`/"" are real answers. A `||` default here would flip `enabled`
    // back on for every site that turned the plugin's feature off.
    const settings = resolvePluginSettings(SCHEMA, { enabled: false, maxItems: 0, apiKey: "" });

    expect(settings).toMatchObject({ enabled: false, maxItems: 0, apiKey: "" });
  });

  it("drops stored keys the plugin's schema does not declare", () => {
    // Leftover keys from a removed option must not reach the plugin as settings.
    expect(resolvePluginSettings(SCHEMA, { removedOption: "x" })).not.toHaveProperty(
      "removedOption",
    );
  });

  it("returns an empty object when the plugin declares no settings schema", () => {
    // A plugin with no settings is valid; the merge must not throw on `undefined`.
    expect(resolvePluginSettings(undefined, { anything: 1 })).toEqual({});
  });

  it("does not let a stored __proto__ key poison Object.prototype", () => {
    // ATTACK: settings are JSON written to the DB by anyone with plugin:configure.
    // A "__proto__" payload must not walk the prototype chain of the render
    // process. The merge only copies KEYS THE SCHEMA DECLARES, which is what
    // makes this safe — assert it stays safe.
    const polluted = JSON.parse('{"__proto__":{"pwned":true}}') as Record<string, unknown>;

    resolvePluginSettings(SCHEMA, polluted);

    expect(({} as Record<string, unknown>).pwned).toBeUndefined();
  });
});
