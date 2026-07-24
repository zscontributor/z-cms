import { describe, expect, it } from "vitest";
import {
  type ThemeSettingsSchema,
  normalizeThemeSchema,
  resolveThemeValues,
} from "../theme-schema";

describe("normalizeThemeSchema", () => {
  it("returns nothing for a null schema", () => {
    expect(normalizeThemeSchema(null)).toEqual([]);
  });

  it("derives a control kind from format and type", () => {
    const schema: ThemeSettingsSchema = {
      type: "object",
      properties: {
        brand: { type: "string", format: "color", title: "Brand" },
        posts: { type: "integer" },
        dark: { type: "boolean" },
        blurb: { type: "string", format: "textarea" },
      },
    };
    const controls = normalizeThemeSchema(schema);
    const byKey = Object.fromEntries(controls.map((c) => [c.key, c.kind]));
    expect(byKey.brand).toBe("color");
    expect(byKey.posts).toBe("number"); // integer collapses to the number control
    expect(byKey.dark).toBe("boolean");
    expect(byKey.blurb).toBe("textarea");
  });

  it("treats a property with an enum as a select regardless of its type", () => {
    const controls = normalizeThemeSchema({
      properties: { layout: { type: "string", enum: ["grid", "list"] } },
    });
    expect(controls[0]!.kind).toBe("enum");
    expect(controls[0]!.options).toEqual(["grid", "list"]);
  });

  it("degrades an unknown type to a text control instead of an empty form", () => {
    // The whole promise of this file: a theme can add a setting with a type the
    // admin has never seen, and it still renders as *something* editable.
    const controls = normalizeThemeSchema({ properties: { x: { type: "quantum" } } });
    expect(controls[0]!.kind).toBe("text");
  });

  it("tolerates a bare key map that is not wrapped in `properties`", () => {
    const controls = normalizeThemeSchema({ accent: { type: "string", format: "color" } });
    expect(controls.map((c) => c.key)).toEqual(["accent"]);
    expect(controls[0]!.kind).toBe("color");
  });

  it("marks a control required only when the schema lists its key", () => {
    const controls = normalizeThemeSchema({
      properties: { a: { type: "string" }, b: { type: "string" } },
      required: ["a"],
    });
    const byKey = Object.fromEntries(controls.map((c) => [c.key, c.required]));
    expect(byKey.a).toBe(true);
    expect(byKey.b).toBe(false);
  });

  it("falls back to the key as the label when no title is given", () => {
    const controls = normalizeThemeSchema({ properties: { accentColor: { type: "string" } } });
    expect(controls[0]!.label).toBe("accentColor");
  });
});

describe("resolveThemeValues", () => {
  const controls = normalizeThemeSchema({
    properties: {
      brand: { type: "string", default: "#000" },
      layout: { type: "string", default: "grid" },
    },
  });

  it("uses the stored value when set and the default when not", () => {
    const values = resolveThemeValues(controls, { brand: "#f00" });
    expect(values.brand).toBe("#f00"); // stored wins
    expect(values.layout).toBe("grid"); // default fills the gap
  });

  it("keeps a stored key the current schema no longer declares", () => {
    // A theme downgrade must not silently destroy a value the newer schema had —
    // re-upgrading should find it still there.
    const values = resolveThemeValues(controls, { removedSetting: "keep-me" });
    expect(values.removedSetting).toBe("keep-me");
  });
});
