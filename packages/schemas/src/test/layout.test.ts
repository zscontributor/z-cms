import { describe, expect, it } from "vitest";
import {
  CssColorSchema,
  CssUrlSchema,
  LAYOUT_DOCUMENT_VERSION,
  LayoutDocumentSchema,
  LayoutTreeSchema,
  MAX_LAYOUT_DEPTH,
  MAX_THEME_COLLECTIONS,
  NodeStyleSchema,
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

/**
 * Per-node style is the newest part of the fence: a value here lands in an inline
 * style the runtime renders verbatim, so the tests care most about what it REFUSES —
 * a colour that could carry a url(), a var(), or a second declaration, and any key
 * outside the closed set.
 */
describe("CssColorSchema", () => {
  it("accepts hex, rgb, hsl and the keyword set", () => {
    for (const ok of [
      "#fff",
      "#ffffff",
      "#ffffffff",
      "rgb(10, 20, 30)",
      "rgba(10, 20, 30, 0.5)",
      "hsl(210, 50%, 40%)",
      "hsla(210, 50%, 40%, 0.5)",
      "transparent",
      "currentColor",
    ]) {
      expect(CssColorSchema.safeParse(ok).success, ok).toBe(true);
    }
  });

  it("refuses anything that could smuggle CSS past the inline style", () => {
    for (const bad of [
      "url(http://evil.example/x.png)",
      "var(--secret)",
      "red; position: fixed",
      "#fff; } body {",
      "expression(alert(1))",
      "image-set('x')",
      "red", // a keyword outside the small allowlist
      "",
    ]) {
      expect(CssColorSchema.safeParse(bad).success, bad).toBe(false);
    }
  });
});

describe("CssUrlSchema", () => {
  it("accepts an https, protocol-relative or root-relative asset URL", () => {
    for (const ok of [
      "https://cdn.example/bg.jpg",
      "http://cdn.example/bg.mp4",
      "//cdn.example/bg.webm",
      "/uploads/2026/hero.jpg",
    ]) {
      expect(CssUrlSchema.safeParse(ok).success, ok).toBe(true);
    }
  });

  it("refuses anything that could break out of url() or a src attribute", () => {
    for (const bad of [
      'https://x/a.jpg") ; background: red', // closes the url()
      "https://x/a.jpg;color:red",
      "javascript:alert(1)",
      "data:image/svg+xml,<svg/>",
      "assets/bg.jpg", // relative without a leading slash
      "https://x/ a.jpg", // whitespace
      "",
    ]) {
      expect(CssUrlSchema.safeParse(bad).success, bad).toBe(false);
    }
  });
});

describe("NodeStyleSchema", () => {
  it("accepts background image and video with their knobs", () => {
    const style = {
      backgroundImage: "/uploads/hero.jpg",
      backgroundSize: "cover",
      backgroundPosition: "center",
      backgroundOverlay: "rgba(0, 0, 0, 0.4)",
      backgroundVideo: "https://cdn.example/loop.mp4",
    };
    expect(NodeStyleSchema.safeParse(style).success).toBe(true);
  });

  it("refuses a background image/video URL that fails the URL fence", () => {
    expect(NodeStyleSchema.safeParse({ backgroundImage: "javascript:alert(1)" }).success).toBe(false);
    expect(NodeStyleSchema.safeParse({ backgroundVideo: 'https://x") ; y' }).success).toBe(false);
    expect(NodeStyleSchema.safeParse({ backgroundSize: "50px" }).success).toBe(false);
  });

  it("accepts a fully-populated, in-range style", () => {
    const style = {
      textColor: "#111111",
      background: "rgb(240, 240, 240)",
      backgroundGradient: "ocean",
      paddingX: 24,
      paddingY: 48,
      borderRadius: 12,
      borderWidth: 2,
      borderStyle: "solid",
      borderColor: "#000000",
      boxShadow: "md",
      fontSize: 18,
      fontWeight: "600",
      textAlign: "center",
      lineHeight: 1.5,
      letterSpacing: 0.5,
      opacity: 0.9,
      minHeight: 320,
    };
    expect(NodeStyleSchema.safeParse(style).success).toBe(true);
  });

  it("rejects an unknown key (strict — no smuggling through the drawer)", () => {
    expect(NodeStyleSchema.safeParse({ position: "fixed" }).success).toBe(false);
    expect(NodeStyleSchema.safeParse({ background: "#fff", zIndex: 999 }).success).toBe(false);
  });

  it("rejects an out-of-range number and a bad enum", () => {
    expect(NodeStyleSchema.safeParse({ paddingX: 9999 }).success).toBe(false);
    expect(NodeStyleSchema.safeParse({ opacity: 5 }).success).toBe(false);
    expect(NodeStyleSchema.safeParse({ boxShadow: "huge" }).success).toBe(false);
    expect(NodeStyleSchema.safeParse({ background: "url(x)" }).success).toBe(false);
  });

  it("is optional — a document without any style still parses (v1 compatibility)", () => {
    expect(LayoutDocumentSchema.safeParse(doc()).success).toBe(true);
  });

  it("round-trips a widget node carrying a valid style, and refuses an invalid one", () => {
    const styled = wellFormedTree();
    // Reach the leaf widget and give it a style.
    const leaf = styled[0]!.children![0]!.children![0]!.children![0]!;
    leaf.style = { textColor: "#abcdef", paddingY: 12, boxShadow: "lg" };
    expect(LayoutTreeSchema.safeParse(styled).success).toBe(true);

    leaf.style = { textColor: "url(http://evil)" } as LayoutNode["style"];
    expect(LayoutTreeSchema.safeParse(styled).success).toBe(false);
  });
});

describe("NodeStyle effects", () => {
  it("accepts bounded transform/filter/custom-shadow/hover fields", () => {
    const style = {
      translateX: 20,
      translateY: -40,
      rotate: 15,
      scale: 1.2,
      blur: 4,
      brightness: 110,
      saturate: 120,
      shadowX: 0,
      shadowY: 12,
      shadowBlur: 30,
      shadowSpread: -4,
      shadowColor: "rgba(0, 0, 0, 0.25)",
      hoverTranslateY: -6,
      hoverScale: 1.03,
      transitionDuration: 280,
      transitionEasing: "smooth",
    };
    expect(NodeStyleSchema.safeParse(style).success).toBe(true);
  });

  it("rejects out-of-range effect magnitudes and a bad easing", () => {
    expect(NodeStyleSchema.safeParse({ scale: 5 }).success).toBe(false);
    expect(NodeStyleSchema.safeParse({ rotate: 720 }).success).toBe(false);
    expect(NodeStyleSchema.safeParse({ transitionDuration: 99999 }).success).toBe(false);
    expect(NodeStyleSchema.safeParse({ transitionEasing: "bounce" }).success).toBe(false);
  });

  it("still fences the custom shadow colour", () => {
    expect(NodeStyleSchema.safeParse({ shadowColor: "url(http://evil)" }).success).toBe(false);
    expect(NodeStyleSchema.safeParse({ shadowColor: "#000000" }).success).toBe(true);
  });
});
