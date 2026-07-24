import { describe, expect, it } from "vitest";
import { catalog } from "../catalog";
import { NAMESPACES, SUPPORTED_LOCALES } from "../locales";
import { createTranslator, resolveMessages } from "../translator";

/**
 * `src/catalog.ts` is generated: it wires the per-namespace JSON files into one
 * object. These tests do not re-check the JSON — `scripts/check-locales.ts` owns
 * that — they check the shape the translator relies on, and that the generated
 * wiring matches the generated locale list.
 */

describe("catalog", () => {
  it("has an entry for every supported locale", () => {
    // A locale advertised in LOCALES but missing from the catalogue would resolve
    // to nothing and render raw keys for every user who selects it.
    for (const code of SUPPORTED_LOCALES) {
      expect(catalog[code]).toBeDefined();
    }
  });

  it("keys the base locale's messages under every declared namespace", () => {
    // The base locale is the fallback for all the others; a namespace missing
    // here is a namespace no locale can fall back on.
    for (const ns of NAMESPACES) {
      expect(catalog.en?.[ns]).toBeDefined();
    }
  });

  it("stores each namespace as a nested object of strings, not a flat blob", () => {
    // The translator walks dotted keys through nested objects. A namespace that
    // arrived as a JSON string or array would break every lookup under it.
    for (const [code, messages] of Object.entries(catalog)) {
      for (const [ns, value] of Object.entries(messages)) {
        expect(
          value !== null && typeof value === "object" && !Array.isArray(value),
          `${code}.${ns} should be a nested object`,
        ).toBe(true);
      }
    }
  });

  it("resolves a real key through the real Vietnamese catalogue", () => {
    // End-to-end over the shipped data: proves the generated wiring and the
    // translator agree, not just that the object has the right shape.
    const t = createTranslator(catalog, "vi");

    expect(typeof t("common.save")).toBe("string");
    expect(t("common.save")).not.toBe("common.save");
  });

  it("produces a resolved payload for a real locale with English folded in", () => {
    // `messagesFor` ships this to the browser. Every base-locale namespace must
    // survive the merge, or a Vietnamese user loses whatever `vi` left untranslated.
    const merged = resolveMessages(catalog, "vi");

    for (const ns of NAMESPACES) {
      expect(merged[ns]).toBeDefined();
    }
  });
});
