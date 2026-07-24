import { describe, expect, it } from "vitest";
import {
  BlockDocumentSchema,
  BlockSchema,
  BlockTypeSchema,
  CORE_BLOCK_TYPES,
  MAX_BLOCK_DEPTH,
  type Block,
} from "../blocks";

/**
 * The block document is what the editor POSTs and what every theme renders. It is
 * stored as raw JSON, so this schema is the ONLY thing standing between a hostile
 * request body and a blob that a theme will later interpolate into a page.
 */

const NUL = String.fromCharCode(0);

/** A tree `depth` levels deep, with one leaf at the bottom. */
function nest(depth: number): Block {
  let node: Block = { id: "leaf", type: "core/cta", props: {} };
  for (let i = 0; i < depth; i++) {
    node = { id: `n${i}`, type: "core/hero", props: {}, children: [node] };
  }
  return node;
}

describe("BlockTypeSchema", () => {
  it("accepts a namespaced type", () => {
    expect(BlockTypeSchema.parse("core/hero")).toBe("core/hero");
  });

  it("accepts a plugin-namespaced type with hyphens on both sides", () => {
    expect(BlockTypeSchema.parse("zsoft/contact-form")).toBe("zsoft/contact-form");
  });

  it("rejects a type with no namespace", () => {
    // The namespace is what stops a plugin from shadowing "core/hero" and taking
    // over the rendering of every homepage on the site.
    expect(BlockTypeSchema.safeParse("hero").success).toBe(false);
  });

  it("rejects a type with more than one segment", () => {
    expect(BlockTypeSchema.safeParse("core/hero/big").success).toBe(false);
  });

  it("rejects a type containing a path traversal", () => {
    // Block types get used to look up a component/template by name. A type that
    // can carry "../" is a type that can reach outside the registry.
    expect(BlockTypeSchema.safeParse("../../etc/passwd").success).toBe(false);
  });

  it("rejects a type with a leading slash", () => {
    expect(BlockTypeSchema.safeParse("/core/hero").success).toBe(false);
  });

  it("rejects an uppercase type", () => {
    // Case-insensitive collision: "Core/Hero" must not become a second identity
    // for a core block in stored JSON.
    expect(BlockTypeSchema.safeParse("Core/Hero").success).toBe(false);
  });

  it("rejects a type containing a NUL byte", () => {
    // A NUL truncates the string in a C-backed consumer (filesystem, some DB
    // drivers), so "core/hero\0../../evil" could be checked as one value and used
    // as another.
    expect(BlockTypeSchema.safeParse(`core/hero${NUL}evil`).success).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(BlockTypeSchema.safeParse("").success).toBe(false);
  });

  it("rejects a non-string type", () => {
    expect(BlockTypeSchema.safeParse(42).success).toBe(false);
  });
});

describe("BlockSchema", () => {
  it("defaults props to an empty object when it is omitted", () => {
    // Themes read `block.props.x` without guarding. If props could arrive as
    // undefined, every theme would crash on a block the editor saved without one.
    const parsed = BlockSchema.parse({ id: "a", type: "core/hero" });

    expect(parsed.props).toEqual({});
  });

  it("keeps arbitrary props, because core does not own the per-type schema", () => {
    // Documented contract: props are opaque to core; the type registry validates
    // them at runtime. This test exists so nobody "tightens" it without noticing
    // they have just broken every third-party block.
    const parsed = BlockSchema.parse({
      id: "a",
      type: "zsoft/contact-form",
      props: { fields: ["email"], nested: { deep: true } },
    });

    expect(parsed.props).toEqual({ fields: ["email"], nested: { deep: true } });
  });

  it("strips unknown keys instead of passing them through", () => {
    // MASS-ASSIGNMENT GUARD. Blocks are persisted as JSON straight from this parse.
    // An attacker adding an extra key must not have it survive into the stored
    // document, where a theme or a later migration might read it back as trusted.
    const parsed = BlockSchema.parse({
      id: "a",
      type: "core/hero",
      props: {},
      isAdmin: true,
      __proto__: { polluted: true },
    });

    expect(parsed).toEqual({ id: "a", type: "core/hero", props: {} });
    expect("isAdmin" in parsed).toBe(false);
  });

  it("rejects a block with an unknown-shaped type", () => {
    expect(BlockSchema.safeParse({ id: "a", type: "not a type", props: {} }).success).toBe(
      false,
    );
  });

  it("reports the issue path of a bad type so the editor can point at the block", () => {
    const result = BlockSchema.safeParse({ id: "a", type: "bogus", props: {} });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.path).toEqual(["type"]);
  });

  it("rejects a block with an empty id", () => {
    // The id is what the editor uses to address a block for a move or a delete.
    // An empty one makes two blocks indistinguishable.
    expect(BlockSchema.safeParse({ id: "", type: "core/hero", props: {} }).success).toBe(
      false,
    );
  });

  it("rejects a block with no id at all", () => {
    expect(BlockSchema.safeParse({ type: "core/hero", props: {} }).success).toBe(false);
  });

  it("rejects props that are an array rather than an object", () => {
    expect(
      BlockSchema.safeParse({ id: "a", type: "core/hero", props: ["x"] }).success,
    ).toBe(false);
  });

  it("rejects props that are null", () => {
    // null is not undefined: it does not trigger the default, it fails the type.
    expect(BlockSchema.safeParse({ id: "a", type: "core/hero", props: null }).success).toBe(
      false,
    );
  });

  it("parses a nested tree and preserves its children", () => {
    const parsed = BlockSchema.parse({
      id: "root",
      type: "core/features",
      props: {},
      children: [{ id: "child", type: "core/cta", props: { label: "Go" } }],
    });

    expect(parsed.children?.[0]?.props).toEqual({ label: "Go" });
  });

  it("rejects a child with an invalid type, deep in the tree", () => {
    // Recursion that only validates the root is recursion an attacker hides inside.
    const result = BlockSchema.safeParse({
      id: "root",
      type: "core/features",
      props: {},
      children: [
        {
          id: "ok",
          type: "core/cta",
          props: {},
          children: [{ id: "evil", type: "javascript:alert(1)", props: {} }],
        },
      ],
    });

    expect(result.success).toBe(false);
  });

  it("reports the full path to an invalid grandchild", () => {
    const result = BlockSchema.safeParse({
      id: "root",
      type: "core/features",
      props: {},
      children: [{ id: "bad", type: "nope", props: {} }],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(["children", 0, "type"]);
    }
  });

  it("rejects children that are not blocks", () => {
    expect(
      BlockSchema.safeParse({
        id: "root",
        type: "core/hero",
        props: {},
        children: ["not-a-block"],
      }).success,
    ).toBe(false);
  });

  it("rejects children given as an object instead of an array", () => {
    expect(
      BlockSchema.safeParse({
        id: "root",
        type: "core/hero",
        props: {},
        children: { id: "x", type: "core/cta", props: {} },
      }).success,
    ).toBe(false);
  });

  it("accepts a block with no children key, since children are optional", () => {
    const parsed = BlockSchema.parse({ id: "a", type: "core/hero", props: {} });

    expect(parsed.children).toBeUndefined();
  });
});

describe("BlockDocumentSchema", () => {
  it("defaults nothing but accepts an empty document", () => {
    // A page with no blocks is a legitimate page (it may render from `data` alone).
    expect(BlockDocumentSchema.parse([])).toEqual([]);
  });

  it("rejects a document that is an object rather than an array", () => {
    expect(BlockDocumentSchema.safeParse({ id: "a", type: "core/hero" }).success).toBe(
      false,
    );
  });

  it("rejects a document that is null", () => {
    expect(BlockDocumentSchema.safeParse(null).success).toBe(false);
  });

  it("rejects the whole document when a single block is malformed", () => {
    // Partial acceptance would persist a document the renderer cannot walk.
    const result = BlockDocumentSchema.safeParse([
      { id: "good", type: "core/hero", props: {} },
      { id: "bad", type: "no-namespace", props: {} },
    ]);

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.path).toEqual([1, "type"]);
  });

  it("accepts a tree nested up to the depth limit", () => {
    // A tree exactly at the cap is legitimate and must still parse.
    const result = BlockDocumentSchema.safeParse([nest(MAX_BLOCK_DEPTH - 1)]);

    expect(result.success).toBe(true);
  });

  it("rejects a tree nested past the depth limit without overflowing the stack", () => {
    // THE ATTACK: a CreateContent body nested thousands deep. Before the cap this
    // overflowed the JS stack with a RangeError that safeParse re-threw rather than
    // reporting — an uncaught-exception DoS. The iterative pre-check turns it into
    // an ordinary validation failure, so this must return success:false, not throw.
    const result = BlockDocumentSchema.safeParse([nest(5000)]);

    expect(result.success).toBe(false);
  });

  it("still validates the leaf of a deeply nested tree", () => {
    // The attack: bury one bad block deep and hope the validator got bored. Within
    // the depth cap, every level is still checked — the leaf's bad type is caught.
    let node: Block = { id: "leaf", type: "not valid", props: {} };
    for (let i = 0; i < MAX_BLOCK_DEPTH - 2; i++) {
      node = { id: `n${i}`, type: "core/hero", props: {}, children: [node] };
    }

    expect(BlockDocumentSchema.safeParse([node]).success).toBe(false);
  });
});

describe("CORE_BLOCK_TYPES", () => {
  it("lists only types that BlockTypeSchema itself accepts", () => {
    // A core block type that its own schema rejects would be unsaveable — the kind
    // of thing a typo in this list would cause and no other test would catch.
    for (const type of CORE_BLOCK_TYPES) {
      expect(BlockTypeSchema.safeParse(type).success).toBe(true);
    }
  });

  it("namespaces every core block under core/", () => {
    for (const type of CORE_BLOCK_TYPES) {
      expect(type.startsWith("core/")).toBe(true);
    }
  });

  it("contains no duplicates, so a registry keyed by type cannot lose one", () => {
    expect(new Set(CORE_BLOCK_TYPES).size).toBe(CORE_BLOCK_TYPES.length);
  });
});
