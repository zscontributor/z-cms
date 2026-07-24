import { describe, expect, it } from "vitest";
import plugin from "../src";

describe("Z SEO plugin package", () => {
  it("keeps its manifest identity, scope, and capability explicit", () => {
    expect(plugin.manifest).toMatchObject({
      id: "vn.zsoft.plugin.seo",
      permissions: ["content:read"],
      capabilities: ["seo.metadata"],
    });
  });
});
