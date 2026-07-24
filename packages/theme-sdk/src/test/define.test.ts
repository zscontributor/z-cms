import { describe, expect, it } from "vitest";
import { defineTheme, resolveThemeSettings } from "../define";
import type { Theme, ThemeSettingsSchema } from "../types";

/**
 * `defineTheme` is the identity function on purpose — the validation is TypeScript's
 * (a theme that omits `manifest` or `templates.page` does not compile) plus the
 * manifest check the marketplace scanner runs on the built package. These tests
 * therefore pin the runtime contract that actually exists: a theme comes back
 * exactly as it was written, with nothing added, removed, or reordered.
 *
 * `resolveThemeSettings` is where the real risk lives: it runs on every render,
 * against a JSONB blob that was written by an older version of the theme.
 */

const SCHEMA: ThemeSettingsSchema = {
  type: "object",
  properties: {
    primaryColor: { type: "string", format: "color", default: "#FA5600" },
    postsPerPage: { type: "number", default: 10 },
    showAuthor: { type: "boolean", default: true },
  },
};

const THEME: Theme = {
  manifest: {
    id: "vn.zsoft.theme.default",
    name: "Default",
    version: "1.0.0",
    author: { name: "Z-SOFT" },
    engine: ">=0.1.0",
    templates: ["page"],
    menuLocations: [{ key: "primary", name: "Primary" }],
    settingsSchema: SCHEMA,
  },
  Layout: () => null,
  templates: { page: () => null },
  blocks: {},
};

describe("defineTheme", () => {
  it("hands a valid theme back untouched", () => {
    expect(defineTheme(THEME)).toBe(THEME);
  });

  it("does not invent templates a theme did not declare", () => {
    // The runtime feature-detects on `templates.archive` and falls back to a 404
    // when it is absent. A wrapper that helpfully filled in stubs would turn a
    // missing template into a blank page instead of an honest not-found.
    const defined = defineTheme(THEME);

    expect(defined.templates.archive).toBeUndefined();
    expect(Object.keys(defined.templates)).toEqual(["page"]);
  });

  it("keeps the manifest identical, so what the marketplace scanned is what runs", () => {
    expect(defineTheme(THEME).manifest).toEqual(THEME.manifest);
  });
});

describe("resolveThemeSettings", () => {
  it("fills every declared setting from the schema default when nothing is stored", () => {
    // A site that has never opened the theme's settings form has no row at all.
    // Templates read `settings.primaryColor` with no null check, so an unfilled
    // default is a blank page, not a missing colour.
    expect(resolveThemeSettings(SCHEMA, null)).toEqual({
      primaryColor: "#FA5600",
      postsPerPage: 10,
      showAuthor: true,
    });
  });

  it("prefers the value the site stored over the theme's default", () => {
    const settings = resolveThemeSettings(SCHEMA, { primaryColor: "#000000" });

    expect(settings).toMatchObject({ primaryColor: "#000000", postsPerPage: 10 });
  });

  it("fills in an option added by a theme upgrade that the stored blob predates", () => {
    // THE REASON THIS FUNCTION EXISTS. Settings are a partial JSONB blob written
    // by whichever version of the theme was installed when the admin last saved.
    // Merging at read time means a theme can add an option without a migration
    // over every site's settings row.
    const storedBeforeUpgrade = { primaryColor: "#123456" };

    const settings = resolveThemeSettings(SCHEMA, storedBeforeUpgrade);

    expect(settings).toEqual({
      primaryColor: "#123456",
      postsPerPage: 10,
      showAuthor: true,
    });
  });

  it("treats a stored null as 'not set' and falls back to the default", () => {
    // JSONB round-trips an unset field as null, not undefined.
    const settings = resolveThemeSettings(SCHEMA, { postsPerPage: null });

    expect(settings).toMatchObject({ postsPerPage: 10 });
  });

  it("keeps a falsy value the site deliberately chose", () => {
    // `false` and `0` are real answers. A `||` instead of an undefined check here
    // would silently switch the author byline back on for every site that turned
    // it off — the classic falsy-default bug.
    const settings = resolveThemeSettings(SCHEMA, { showAuthor: false, postsPerPage: 0 });

    expect(settings).toMatchObject({ showAuthor: false, postsPerPage: 0 });
  });

  it("drops stored keys the theme's schema does not declare", () => {
    // The blob may still hold options from a theme the site used to run, or from
    // an option this theme removed. A template must only ever see what the
    // current schema declares.
    const settings = resolveThemeSettings(SCHEMA, { fromAnOldTheme: "leftover" });

    expect(settings).not.toHaveProperty("fromAnOldTheme");
  });

  it("does not let a stored key overwrite Object.prototype", () => {
    // ATTACK: settings arrive as JSON from the database, and a plugin with
    // `site:update` writes them. A "__proto__" key must not reach the prototype
    // chain — it would poison every object in the render process.
    const polluted = JSON.parse('{"__proto__": {"polluted": true}}') as Record<
      string,
      unknown
    >;

    const settings = resolveThemeSettings(SCHEMA, polluted);

    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(settings).not.toHaveProperty("polluted");
  });

  it("returns an empty object for a schema that declares no properties", () => {
    const settings = resolveThemeSettings({ type: "object", properties: {} }, { any: "thing" });

    expect(settings).toEqual({});
  });
});
