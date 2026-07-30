import { describe, expect, it } from "vitest";
import { canOwnPluginTables } from "../plugin-data-trust";

describe("canOwnPluginTables", () => {
  it("accepts pinned built-ins and reviewed marketplace packages", () => {
    expect(canOwnPluginTables("BUILTIN")).toBe(true);
    expect(canOwnPluginTables("MARKETPLACE")).toBe(true);
  });

  it("refuses sideloads and missing origin data", () => {
    expect(canOwnPluginTables("SIDELOAD")).toBe(false);
    expect(canOwnPluginTables(null)).toBe(false);
    expect(canOwnPluginTables(undefined)).toBe(false);
  });
});
