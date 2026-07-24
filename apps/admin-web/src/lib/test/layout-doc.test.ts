import { describe, expect, it } from "vitest";
import type { LayoutDocument, LayoutNode } from "@zcmsorg/schemas";
import { LayoutDocumentSchema } from "@zcmsorg/schemas";
import {
  bindingNeedsNewSlot,
  canContain,
  cloneWithNewIds,
  collectionBudget,
  createWidget,
  duplicateNode,
  insertNode,
  locate,
  moveNode,
  removeNode,
  setBinding,
  setProps,
} from "../layout-doc";

/**
 * Tree surgery is where a layout editor actually breaks: an off-by-one on a move
 * within the same parent, a drop that detaches a subtree into nowhere, a duplicate
 * that shares ids with its original. None of those throw — they just quietly
 * produce a document that is not the one on screen.
 */

function widget(id: string, type = "layout/heading"): LayoutNode {
  return { id, kind: "widget", widgetType: type, props: {} };
}
function column(id: string, children: LayoutNode[] = []): LayoutNode {
  return { id, kind: "column", props: {}, children };
}
function row(id: string, children: LayoutNode[] = []): LayoutNode {
  return { id, kind: "row", props: {}, children };
}
function section(id: string, children: LayoutNode[] = []): LayoutNode {
  return { id, kind: "section", props: {}, children };
}

function tree(): LayoutNode[] {
  return [
    section("s1", [
      row("r1", [
        column("c1", [widget("w1"), widget("w2"), widget("w3")]),
        column("c2", [widget("w4")]),
      ]),
    ]),
  ];
}

describe("canContain", () => {
  it("allows the section>row>column>widget chain", () => {
    expect(canContain("section", "row")).toBe(true);
    expect(canContain("row", "column")).toBe(true);
    expect(canContain("column", "widget")).toBe(true);
  });

  it("refuses everything else", () => {
    expect(canContain("section", "widget")).toBe(false);
    expect(canContain("column", "column")).toBe(false);
    expect(canContain("widget", "widget")).toBe(false);
  });
});

describe("locate", () => {
  it("finds a nested node with its parent and index", () => {
    const found = locate(tree(), "w2");
    expect(found?.parent?.id).toBe("c1");
    expect(found?.index).toBe(1);
  });

  it("reports a root's parent as null", () => {
    expect(locate(tree(), "s1")?.parent).toBeNull();
  });

  it("returns null for a node that is not there", () => {
    expect(locate(tree(), "nope")).toBeNull();
  });
});

describe("purity", () => {
  it("does not mutate the input tree", () => {
    const original = tree();
    const snapshot = JSON.stringify(original);
    removeNode(original, "w1");
    setProps(original, "w2", { text: "changed" });
    moveNode(original, "w1", "c2", 0);
    expect(JSON.stringify(original)).toBe(snapshot);
  });
});

describe("insertNode", () => {
  it("inserts a widget into a column", () => {
    const next = insertNode(tree(), "c2", 0, widget("new"));
    expect(locate(next, "new")?.parent?.id).toBe("c2");
    expect(locate(next, "new")?.index).toBe(0);
  });

  it("refuses a drop the containment rule forbids", () => {
    const before = tree();
    const after = insertNode(before, "s1", 0, widget("new"));
    // Unchanged by identity — the caller can tell the drop did not take.
    expect(after).toBe(before);
  });

  it("clamps an out-of-range index rather than leaving a hole", () => {
    const next = insertNode(tree(), "c2", 99, widget("new"));
    expect(locate(next, "new")?.index).toBe(1);
  });
});

describe("moveNode within the same parent", () => {
  it("moves a widget later and accounts for the hole it left", () => {
    // w1 (index 0) dropped at index 2 must land BETWEEN w2 and w3 — the naive
    // splice-in-at-2-after-removing-from-0 puts it after w3.
    const next = moveNode(tree(), "w1", "c1", 2);
    const ids = locate(next, "c1")!.node.children!.map((c) => c.id);
    expect(ids).toEqual(["w2", "w1", "w3"]);
  });

  it("moves a widget earlier", () => {
    const next = moveNode(tree(), "w3", "c1", 0);
    const ids = locate(next, "c1")!.node.children!.map((c) => c.id);
    expect(ids).toEqual(["w3", "w1", "w2"]);
  });

  it("keeps every child when a move is a no-op", () => {
    const next = moveNode(tree(), "w2", "c1", 1);
    const ids = locate(next, "c1")!.node.children!.map((c) => c.id);
    expect(ids).toEqual(["w1", "w2", "w3"]);
  });
});

describe("moveNode across parents", () => {
  it("moves a widget into another column", () => {
    const next = moveNode(tree(), "w1", "c2", 0);
    expect(locate(next, "w1")?.parent?.id).toBe("c2");
    expect(locate(next, "c1")!.node.children!.map((c) => c.id)).toEqual(["w2", "w3"]);
  });

  it("refuses a move the containment rule forbids", () => {
    const before = tree();
    expect(moveNode(before, "w1", "s1", 0)).toBe(before);
  });

  it("refuses to drop a node into itself", () => {
    const before = tree();
    expect(moveNode(before, "r1", "r1", 0)).toBe(before);
  });

  it("refuses to drop a node into its own descendant", () => {
    // Dragging r1 into c1 (which r1 contains) would detach the whole subtree and
    // leak it out of the document. The UI can express this: c1's drop target is
    // still on screen while r1 is being dragged.
    const before = tree();
    expect(moveNode(before, "r1", "c1", 0)).toBe(before);
  });

  it("does not lose the node when the target is missing", () => {
    const before = tree();
    expect(moveNode(before, "w1", "ghost", 0)).toBe(before);
  });
});

describe("duplicateNode", () => {
  it("inserts the copy right after the original", () => {
    const next = duplicateNode(tree(), "w1");
    const ids = locate(next, "c1")!.node.children!.map((c) => c.id);
    expect(ids).toHaveLength(4);
    expect(ids[0]).toBe("w1");
    expect(ids[1]).not.toBe("w1");
  });

  it("gives every node in the copied subtree a fresh id", () => {
    const next = duplicateNode(tree(), "r1");
    const copy = locate(next, "s1")!.node.children![1]!;
    const ids = new Set<string>();
    const walk = (n: LayoutNode) => {
      ids.add(n.id);
      (n.children ?? []).forEach(walk);
    };
    walk(copy);
    // A copy that shared ids with the original would make `locate` find the wrong
    // one, and every later edit would hit whichever came first.
    for (const original of ["r1", "c1", "c2", "w1", "w2", "w3", "w4"]) {
      expect(ids.has(original)).toBe(false);
    }
  });

  it("keeps props and bindings on the copy", () => {
    const source: LayoutNode[] = [
      section("s", [
        row("r", [
          column("c", [
            {
              id: "w",
              kind: "widget",
              widgetType: "dynamic/post-list",
              props: { layout: "grid" },
              binding: { source: "collection", contentType: "post", limit: 6, sort: "newest" },
            },
          ]),
        ]),
      ]),
    ];
    const copy = cloneWithNewIds(locate(source, "w")!.node);
    expect(copy.props).toEqual({ layout: "grid" });
    expect(copy.binding).toEqual({
      source: "collection",
      contentType: "post",
      limit: 6,
      sort: "newest",
    });
  });
});

describe("setBinding", () => {
  const withBinding = (): LayoutNode[] => [
    section("s", [
      row("r", [
        column("c", [
          {
            id: "w",
            kind: "widget",
            widgetType: "dynamic/post-list",
            props: {},
            binding: { source: "collection", contentType: "post", limit: 6, sort: "newest" },
          },
        ]),
      ]),
    ]),
  ];

  it("deletes the key when the binding is cleared", () => {
    const next = setBinding(withBinding(), "w", undefined);
    expect("binding" in locate(next, "w")!.node).toBe(false);
  });

  it("replaces an existing binding", () => {
    const next = setBinding(withBinding(), "w", {
      source: "collection",
      contentType: "product",
      limit: 3,
      sort: "title",
    });
    expect(locate(next, "w")!.node.binding).toMatchObject({ contentType: "product", limit: 3 });
  });
});

describe("createWidget", () => {
  it("starts a widget with its catalogue defaults", () => {
    const node = createWidget("layout/heading");
    expect(node.kind).toBe("widget");
    expect(node.props).toMatchObject({ text: "Heading", level: "2" });
  });
});

describe("collection budget", () => {
  function docWithLists(...types: string[]): LayoutDocument {
    return LayoutDocumentSchema.parse({
      version: 1,
      tokens: {},
      templates: {
        page: [
          section("s", [
            row("r", [
              column(
                "c",
                types.map((type, i) => ({
                  id: `w${i}`,
                  kind: "widget",
                  widgetType: "dynamic/post-list",
                  props: {},
                  binding: { source: "collection", contentType: type, limit: 6, sort: "newest" },
                })),
              ),
            ]),
          ]),
        ],
      },
    });
  }

  it("counts distinct queries, not widgets", () => {
    const budget = collectionBudget(docWithLists("post", "post", "post"));
    expect(budget.used).toBe(1);
    expect(budget.full).toBe(false);
  });

  it("reports full at the cap", () => {
    const budget = collectionBudget(
      docWithLists("a", "b", "c", "d", "e", "f", "g", "h"),
    );
    expect(budget.used).toBe(8);
    expect(budget.full).toBe(true);
  });

  it("a binding matching an existing query needs no new slot", () => {
    const doc = docWithLists("post");
    expect(
      bindingNeedsNewSlot(doc, {
        source: "collection",
        contentType: "post",
        limit: 6,
        sort: "newest",
      }),
    ).toBe(false);
  });

  it("a binding asking a new question needs a slot", () => {
    const doc = docWithLists("post");
    expect(
      bindingNeedsNewSlot(doc, {
        source: "collection",
        contentType: "post",
        limit: 3,
        sort: "newest",
      }),
    ).toBe(true);
  });

  it("a current binding never costs a slot", () => {
    expect(bindingNeedsNewSlot(docWithLists("post"), { source: "current", field: "title" })).toBe(
      false,
    );
  });
});
