import { describe, expect, it } from "vitest";
import { LayoutTreeSchema } from "@zcmsorg/schemas";
import { LAYOUT_PATTERNS } from "../layout-templates";

/**
 * A starter pattern is inserted as-is into a document that then goes to the server
 * and is signed, so every pattern MUST be a well-formed, in-fence tree. These tests
 * are the guard: a pattern that breaks containment, names an unknown widget, or sets
 * an out-of-range style would otherwise only fail when a user clicked it.
 */
describe("LAYOUT_PATTERNS", () => {
  for (const pattern of LAYOUT_PATTERNS) {
    it(`"${pattern.key}" builds a tree that passes the schema fence`, () => {
      const result = LayoutTreeSchema.safeParse(pattern.build());
      expect(result.success, JSON.stringify((result as { error?: unknown }).error)).toBe(true);
    });
  }

  it("mints fresh ids each build, so inserting one twice makes two sections", () => {
    const a = LAYOUT_PATTERNS[0]!.build();
    const b = LAYOUT_PATTERNS[0]!.build();
    const ids = (nodes: typeof a): string[] =>
      nodes.flatMap((n) => [n.id, ...ids(n.children ?? [])]);
    const overlap = ids(a).filter((id) => ids(b).includes(id));
    expect(overlap).toEqual([]);
  });
});
