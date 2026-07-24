import { describe, expect, it } from "vitest";
import {
  LAYOUT_DOCUMENT_VERSION,
  LayoutDocumentSchema,
  LayoutTreeSchema,
  MAX_LAYOUT_DEPTH,
  MAX_THEME_COLLECTIONS,
  collectDocumentCollections,
  collectionNameFor,
  exceedsCollectionBudget,
  type LayoutDocument,
  type LayoutNode,
} from "../layout";

/**
 * The LayoutDocument is the fence: everything a non-programmer draws becomes data
 * the code generator emits verbatim into a package the platform then signs. So the
 * tests here are less "does it parse a happy tree" and more "does it refuse the
 * shapes that would otherwise reach a signed artifact".
 */

function widget(id: string, type: string, extra: Partial<LayoutNode> = {}): LayoutNode {
  return { id, kind: "widget", widgetType: type, props: {}, ...extra };
}

function column(id: string, children: LayoutNode[]): LayoutNode {
  return { id, kind: "column", props: {}, children };
}

function row(id: string, children: LayoutNode[]): LayoutNode {
  return { id, kind: "row", props: {}, children };
}

function section(id: string, children: LayoutNode[]): LayoutNode {
  return { id, kind: "section", props: {}, children };
}

/** A minimal well-formed tree: section > row > column > widget. */
function wellFormedTree(): LayoutNode[] {
  return [section("s1", [row("r1", [column("c1", [widget("w1", "layout/heading")])])])];
}

function doc(templates: Partial<LayoutDocument["templates"]> = {}): unknown {
  return {
    version: LAYOUT_DOCUMENT_VERSION,
    tokens: {},
    templates: { page: wellFormedTree(), ...templates },
  };
}

describe("LayoutTreeSchema containment", () => {
  it("accepts section>row>column>widget", () => {
    expect(LayoutTreeSchema.safeParse(wellFormedTree()).success).toBe(true);
  });

  it("rejects a column nested directly in a section", () => {
    const bad = [section("s1", [column("c1", [])])];
    expect(LayoutTreeSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a widget that carries children", () => {
    const bad = [
      section("s1", [row("r1", [column("c1", [widget("w1", "layout/heading", {
        children: [widget("w2", "layout/heading")],
      })])])]),
    ];
    expect(LayoutTreeSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a widget with no widgetType", () => {
    const bad = [
      section("s1", [row("r1", [column("c1", [{ id: "w1", kind: "widget", props: {} }])])]),
    ];
    expect(LayoutTreeSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a container that carries a widgetType", () => {
    const bad = [{ id: "s1", kind: "section", widgetType: "layout/heading", props: {} }];
    expect(LayoutTreeSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a malformed widget type", () => {
    const bad = [
      section("s1", [row("r1", [column("c1", [widget("w1", "NotANamespace")])])]),
    ];
    expect(LayoutTreeSchema.safeParse(bad).success).toBe(false);
  });
});

describe("LayoutTreeSchema depth guard", () => {
  it("rejects a tree deeper than the limit without throwing", () => {
    // Build MAX+2 nested sections — over the limit — and confirm safeParse returns
    // a failure rather than overflowing the stack (which safeParse would rethrow).
    let node: LayoutNode = widget("leaf", "layout/heading");
    node = column("c", [node]);
    for (let i = 0; i < MAX_LAYOUT_DEPTH + 2; i++) {
      node = section(`s${i}`, [row(`r${i}`, [node])]);
    }
    const result = LayoutTreeSchema.safeParse([node]);
    expect(result.success).toBe(false);
  });
});

describe("LayoutDocumentSchema", () => {
  it("requires the page template", () => {
    const bad = { version: LAYOUT_DOCUMENT_VERSION, tokens: {}, templates: {} };
    expect(LayoutDocumentSchema.safeParse(bad).success).toBe(false);
  });

  it("accepts a document with only page", () => {
    expect(LayoutDocumentSchema.safeParse(doc()).success).toBe(true);
  });

  it("defaults tokens to an empty object", () => {
    const parsed = LayoutDocumentSchema.parse({
      version: LAYOUT_DOCUMENT_VERSION,
      templates: { page: wellFormedTree() },
    });
    expect(parsed.tokens).toEqual({});
  });

  it("rejects an unknown token", () => {
    const bad = {
      version: LAYOUT_DOCUMENT_VERSION,
      tokens: { colorPrimary: "#000", nonsense: 1 },
      templates: { page: wellFormedTree() },
    };
    expect(LayoutDocumentSchema.safeParse(bad).success).toBe(false);
  });
});

describe("collection extraction", () => {
  function listWidget(id: string, contentType: string, limit?: number): LayoutNode {
    return widget(id, "dynamic/post-list", {
      binding: { source: "collection", contentType, limit },
    });
  }

  function docWith(...widgets: LayoutNode[]): LayoutDocument {
    return LayoutDocumentSchema.parse({
      version: LAYOUT_DOCUMENT_VERSION,
      tokens: {},
      templates: {
        page: [section("s", [row("r", [column("c", widgets)])])],
      },
    });
  }

  it("names a query deterministically from its shape", () => {
    expect(collectionNameFor({ contentType: "post", limit: 6, sort: "newest" })).toBe(
      "post_6_newest",
    );
  });

  it("deduplicates identical queries to one collection", () => {
    const parsed = docWith(listWidget("a", "post", 6), listWidget("b", "post", 6));
    const collections = collectDocumentCollections(parsed);
    expect(Object.keys(collections)).toHaveLength(1);
    expect(collections["post_6_newest"]).toEqual({
      contentType: "post",
      limit: 6,
      sort: "newest",
    });
  });

  it("keeps distinct queries apart", () => {
    const parsed = docWith(listWidget("a", "post", 6), listWidget("b", "product", 3));
    expect(Object.keys(collectDocumentCollections(parsed))).toHaveLength(2);
  });

  it("flags a document over the collection budget", () => {
    const many = Array.from({ length: MAX_THEME_COLLECTIONS + 1 }, (_, i) =>
      listWidget(`w${i}`, `type${i}`, 6),
    );
    expect(exceedsCollectionBudget(docWith(...many))).toBe(true);
  });

  it("does not flag a document at the budget", () => {
    const atLimit = Array.from({ length: MAX_THEME_COLLECTIONS }, (_, i) =>
      listWidget(`w${i}`, `type${i}`, 6),
    );
    expect(exceedsCollectionBudget(docWith(...atLimit))).toBe(false);
  });
});
