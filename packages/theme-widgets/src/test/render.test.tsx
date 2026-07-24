import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ContentDto, LayoutNode } from "@zcmsorg/schemas";
import type { ThemeContext } from "@zcmsorg/theme-sdk";
import { LayoutRenderer } from "../LayoutRenderer";
import { tokensToStyle } from "../tokens";

/**
 * These tests pin the property the whole GUI-theme feature rests on: a
 * LayoutDocument is DATA, and this library is the only code that turns it into
 * HTML. So they lean on the refusals — the unknown widget, the missing menu, the
 * post widget on a page with no post — because those are the cases where a drawn
 * theme meets a site its author never saw.
 */

function mockCtx(overrides: Partial<ThemeContext> = {}): ThemeContext {
  const base = {
    site: { name: "Acme" },
    settings: {},
    menus: {},
    locale: "en",
    t: (key: string) => key,
    renderBlocks: () => null,
    hasCapability: () => false,
    getIntegration: () => undefined,
    renderSlot: () => null,
    url: (path: string) => path,
    asset: (path: string) => path,
    alternates: [],
    colorMode: { modes: ["light"], default: "system", toggleable: false, attribute: "data-theme" },
    collections: {},
  };
  return { ...base, ...overrides } as unknown as ThemeContext;
}

function widget(id: string, type: string, extra: Partial<LayoutNode> = {}): LayoutNode {
  return { id, kind: "widget", widgetType: type, props: {}, ...extra };
}

/** Wraps widgets in the section>row>column scaffold the containment rule requires. */
function scaffold(...widgets: LayoutNode[]): LayoutNode[] {
  return [
    {
      id: "s1",
      kind: "section",
      props: {},
      children: [
        {
          id: "r1",
          kind: "row",
          props: {},
          children: [{ id: "c1", kind: "column", props: {}, children: widgets }],
        },
      ],
    },
  ];
}

function render(nodes: LayoutNode[], ctx = mockCtx(), content?: ContentDto | null) {
  return renderToStaticMarkup(<LayoutRenderer nodes={nodes} ctx={ctx} content={content} />);
}

describe("LayoutRenderer structure", () => {
  it("renders the section>row>column scaffold", () => {
    const html = render(scaffold(widget("w1", "layout/heading", { props: { text: "Hi" } })));
    expect(html).toContain("zw-section");
    expect(html).toContain("zw-row");
    expect(html).toContain("zw-column");
    expect(html).toContain("Hi");
  });

  it("skips a widget type it does not know rather than crashing", () => {
    const html = render(scaffold(widget("w1", "evil/backdoor")));
    expect(html).toContain("zw-column");
    expect(html).not.toContain("evil");
  });

  it("gives a column its span as a CSS variable", () => {
    const nodes: LayoutNode[] = [
      {
        id: "s",
        kind: "section",
        props: {},
        children: [
          {
            id: "r",
            kind: "row",
            props: {},
            children: [{ id: "c", kind: "column", props: { span: 6 }, children: [] }],
          },
        ],
      },
    ];
    expect(render(nodes)).toContain("--zw-span:6");
  });

  it("clamps an out-of-range span into the 12-grid", () => {
    const nodes: LayoutNode[] = [
      {
        id: "s",
        kind: "section",
        props: {},
        children: [
          {
            id: "r",
            kind: "row",
            props: {},
            children: [{ id: "c", kind: "column", props: { span: 99 }, children: [] }],
          },
        ],
      },
    ];
    expect(render(nodes)).toContain("--zw-span:12");
  });
});

describe("Heading", () => {
  it("renders nothing when there is no text", () => {
    expect(render(scaffold(widget("w", "layout/heading")))).not.toContain("zw-heading");
  });

  it("honours the level", () => {
    const html = render(scaffold(widget("w", "layout/heading", { props: { text: "T", level: "3" } })));
    expect(html).toContain("<h3");
  });

  it("clamps a nonsense level rather than emitting <h99>", () => {
    const html = render(scaffold(widget("w", "layout/heading", { props: { text: "T", level: 99 } })));
    expect(html).toContain("<h6");
  });
});

describe("Menu", () => {
  it("renders nothing when the site does not define the location", () => {
    const html = render(scaffold(widget("w", "layout/menu", { props: { location: "nope" } })));
    expect(html).not.toContain("zw-menu");
  });

  it("renders the menu assigned to its location", () => {
    const ctx = mockCtx({
      menus: {
        primary: {
          key: "primary",
          name: "Primary",
          items: [{ id: "i1", label: "About", url: "/about", target: "", children: [] }],
        },
      },
    });
    const html = render(scaffold(widget("w", "layout/menu", { props: { location: "primary" } })), ctx);
    expect(html).toContain("About");
    expect(html).toContain('href="/about"');
  });
});

describe("current-bound widgets", () => {
  const content = {
    id: "c1",
    title: "Hello world",
    blocks: [{ id: "b1", type: "core/richtext", props: {} }],
  } as unknown as ContentDto;

  it("post-title renders nothing without a viewed page", () => {
    const html = render(scaffold(widget("w", "dynamic/post-title")), mockCtx(), null);
    expect(html).not.toContain("zw-post-title");
  });

  it("post-title renders the viewed page's title", () => {
    const html = render(scaffold(widget("w", "dynamic/post-title")), mockCtx(), content);
    expect(html).toContain("Hello world");
  });

  it("post-content delegates to ctx.renderBlocks", () => {
    const renderBlocks = vi.fn(() => <p>rendered</p>);
    const ctx = mockCtx({ renderBlocks: renderBlocks as unknown as ThemeContext["renderBlocks"] });
    const html = render(scaffold(widget("w", "dynamic/post-content")), ctx, content);
    expect(renderBlocks).toHaveBeenCalledWith(content.blocks);
    expect(html).toContain("rendered");
  });

  it("post-content renders nothing when the page has no blocks", () => {
    const empty = { ...content, blocks: [] } as unknown as ContentDto;
    const html = render(scaffold(widget("w", "dynamic/post-content")), mockCtx(), empty);
    expect(html).not.toContain("zw-post-content");
  });
});

describe("PostList", () => {
  const listNode = widget("w", "dynamic/post-list", {
    binding: { source: "collection", contentType: "post", limit: 6, sort: "newest" },
    props: { heading: "Latest" },
  });

  it("reads the collection under the name derived from its own binding", () => {
    // The derived name is the contract with the code generator: it puts the same
    // query in the manifest under this key, and cms-api fills it. A drift here is
    // a permanently empty list on a live site.
    const ctx = mockCtx({
      collections: {
        post_6_newest: [
          { id: "p1", title: "First post", path: "/blog/first", excerpt: "Hi" } as unknown as ContentDto,
        ],
      },
    });
    const html = render(scaffold(listNode), ctx);
    expect(html).toContain("First post");
    expect(html).toContain('href="/blog/first"');
    expect(html).toContain("Latest");
  });

  it("says the list is empty rather than leaving a hole", () => {
    const html = render(scaffold(listNode), mockCtx());
    expect(html).toContain("zw-post-list-empty");
    expect(html).toContain("themeWidgets.postList.empty");
  });

  it("renders nothing without a collection binding", () => {
    const unbound = widget("w", "dynamic/post-list", { props: { heading: "Latest" } });
    expect(render(scaffold(unbound), mockCtx())).not.toContain("zw-post-list");
  });
});

describe("tokensToStyle", () => {
  it("maps tokens onto CSS variables", () => {
    expect(tokensToStyle({ colorPrimary: "#fa5600", radius: 12 })).toEqual({
      "--zw-color-primary": "#fa5600",
      "--zw-radius": "12px",
    });
  });

  it("omits an unset token so the stylesheet fallback wins", () => {
    // An empty custom property is still SET, which defeats var(--x, fallback).
    expect(tokensToStyle({})).toEqual({});
  });

  it("keeps a zero radius, which is a real choice and not an absent one", () => {
    expect(tokensToStyle({ radius: 0 })).toEqual({ "--zw-radius": "0px" });
  });
});
