import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ContentDto, LayoutNode } from "@zcmsorg/schemas";
import type { ThemeContext } from "@zcmsorg/theme-sdk";
import { LayoutRenderer } from "../LayoutRenderer";
import { styleForNode, tokensToStyle } from "../tokens";

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
    archive: null,
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

describe("styleForNode", () => {
  it("maps bounded fields to inline CSS and omits unset ones", () => {
    const css = styleForNode({ textColor: "#111", paddingX: 24, boxShadow: "md" });
    expect(css.color).toBe("#111");
    expect(css.paddingLeft).toBe("24px");
    expect(css.paddingRight).toBe("24px");
    expect(css.boxShadow).toContain("rgba");
    // A field not set never appears — an empty declaration is invalid CSS.
    expect(css.background).toBeUndefined();
    expect(css.borderStyle).toBeUndefined();
  });

  it("returns an empty object for no style, so callers can always spread it", () => {
    expect(styleForNode(undefined)).toEqual({});
  });

  it("lets a gradient preset win over a solid background", () => {
    const css = styleForNode({ background: "#fff", backgroundGradient: "ocean" });
    expect(String(css.background)).toContain("linear-gradient");
  });

  it("resolves a preset name to a fixed declaration, never the author's string", () => {
    // The whole security point: "md" is a NAME, and the value is ours.
    expect(styleForNode({ boxShadow: "md" }).boxShadow).toBe("0 4px 12px rgba(0, 0, 0, 0.10)");
  });

  it("composes a background image with size, position and a quoted URL", () => {
    const css = styleForNode({ backgroundImage: "/uploads/hero.jpg" });
    expect(css.backgroundImage).toBe('url("/uploads/hero.jpg")');
    expect(css.backgroundSize).toBe("cover");
    expect(css.backgroundPosition).toBe("center");
    expect(css.backgroundRepeat).toBe("no-repeat");
  });

  it("layers an overlay over the image so text stays legible", () => {
    const css = styleForNode({
      backgroundImage: "/uploads/hero.jpg",
      backgroundOverlay: "rgba(0, 0, 0, 0.4)",
      backgroundSize: "contain",
      backgroundPosition: "top",
    });
    // overlay first (topmost), then the image; size/position honoured
    expect(String(css.backgroundImage)).toBe(
      'linear-gradient(0deg, rgba(0, 0, 0, 0.4), rgba(0, 0, 0, 0.4)), url("/uploads/hero.jpg")',
    );
    expect(css.backgroundSize).toBe("contain");
    expect(css.backgroundPosition).toBe("top");
  });

  it("keeps a solid colour beneath an image as backgroundColor, not the shorthand", () => {
    const css = styleForNode({ background: "#fff", backgroundImage: "/uploads/hero.jpg" });
    // shorthand would clobber the image — so the solid rides on backgroundColor
    expect(css.backgroundColor).toBe("#fff");
    expect(String(css.backgroundImage)).toContain('url("/uploads/hero.jpg")');
  });

  it("does not emit backgroundVideo as a CSS property (it is a rendered element)", () => {
    const css = styleForNode({ backgroundVideo: "/uploads/loop.mp4" }) as Record<string, unknown>;
    expect(css.backgroundVideo).toBeUndefined();
    expect(Object.keys(css)).toHaveLength(0);
  });
});

describe("LayoutRenderer per-node style", () => {
  it("wraps a styled widget in zw-widget carrying the inline style", () => {
    const html = render(
      scaffold(widget("w", "layout/heading", {
        props: { text: "Hi" },
        style: { textColor: "#abcdef", paddingY: 12 },
      })),
    );
    expect(html).toContain("zw-widget");
    expect(html).toContain("color:#abcdef");
    expect(html).toContain("padding-top:12px");
  });

  it("does not add a wrapper when a widget has no style", () => {
    const html = render(scaffold(widget("w", "layout/heading", { props: { text: "Hi" } })));
    expect(html).not.toContain("zw-widget");
  });

  it("applies a section's style on the section element", () => {
    const nodes: LayoutNode[] = [
      {
        id: "s",
        kind: "section",
        props: {},
        style: { background: "#101010", minHeight: 400 },
        children: [{ id: "r", kind: "row", props: {}, children: [{ id: "c", kind: "column", props: {}, children: [] }] }],
      },
    ];
    const html = render(nodes);
    expect(html).toContain("background:#101010");
    expect(html).toContain("min-height:400px");
  });
});

describe("LayoutRenderer background video", () => {
  const sectionWithVideo = (src: string): LayoutNode[] => [
    {
      id: "s",
      kind: "section",
      props: {},
      style: { backgroundVideo: src },
      children: [{ id: "r", kind: "row", props: {}, children: [{ id: "c", kind: "column", props: {}, children: [] }] }],
    },
  ];

  it("renders a muted looping video behind a section that sets one", () => {
    const html = render(sectionWithVideo("/uploads/loop.mp4"));
    expect(html).toContain("zw-has-bg-video");
    expect(html).toContain('class="zw-bg-video"');
    expect(html).toContain('src="/uploads/loop.mp4"');
    // decoration: autoplay needs muted; loop + playsInline for a seamless background
    expect(html).toContain("muted");
    expect(html).toContain("loop");
  });

  it("routes the video src through ctx.asset (keeps the locale/asset base)", () => {
    const ctx = mockCtx({ asset: (p: string) => `https://cdn.test${p}` });
    const html = render(sectionWithVideo("/uploads/loop.mp4"), ctx);
    expect(html).toContain('src="https://cdn.test/uploads/loop.mp4"');
  });

  it("adds no video element or marker class when none is set", () => {
    const html = render(scaffold(widget("w", "layout/heading", { props: { text: "Hi" } })));
    expect(html).not.toContain("zw-bg-video");
    expect(html).not.toContain("zw-has-bg-video");
  });

  it("wraps an otherwise-styleless widget when only a background video is set", () => {
    const html = render(
      scaffold(widget("w", "layout/heading", { props: { text: "Hi" }, style: { backgroundVideo: "/v.mp4" } })),
    );
    expect(html).toContain("zw-widget zw-has-bg-video");
    expect(html).toContain('class="zw-bg-video"');
  });
});

describe("styleForNode effects", () => {
  it("composes transform and filter strings from bounded magnitudes", () => {
    const css = styleForNode({ translateY: -40, rotate: 15, scale: 1.2, blur: 4, brightness: 110 });
    expect(css.transform).toBe("translate(0px, -40px) rotate(15deg) scale(1.2)");
    expect(css.filter).toBe("blur(4px) brightness(110%)");
  });

  it("builds a custom box-shadow that overrides the preset", () => {
    const css = styleForNode({ boxShadow: "sm", shadowY: 12, shadowBlur: 30, shadowColor: "#000000" });
    expect(css.boxShadow).toBe("0px 12px 30px 0px #000000");
  });

  it("emits the hover custom property and a transition when hover is set", () => {
    const css = styleForNode({ hoverTranslateY: -6, hoverScale: 1.03, transitionDuration: 200, transitionEasing: "smooth" });
    expect((css as Record<string, string>)["--zw-hover-transform"]).toBe("translateY(-6px) scale(1.03)");
    expect(String(css.transition)).toContain("200ms");
    expect(String(css.transition)).toContain("cubic-bezier");
  });

  it("does not emit hover artifacts when no hover fields are set", () => {
    const css = styleForNode({ translateY: 10 });
    expect((css as Record<string, string>)["--zw-hover-transform"]).toBeUndefined();
    expect(css.transition).toBeUndefined();
  });
});

describe("LayoutRenderer hover marker", () => {
  it("marks a hover node with data-zw-hover so the :hover rule applies", () => {
    const html = render(scaffold(widget("w", "layout/heading", {
      props: { text: "Hi" },
      style: { hoverTranslateY: -6 },
    })));
    expect(html).toContain("data-zw-hover");
    expect(html).toContain("--zw-hover-transform");
  });
});

describe("Gallery", () => {
  const gallery = (props: Record<string, unknown>) =>
    scaffold(widget("g", "media/gallery", { props }));

  it("renders nothing without images", () => {
    expect(render(gallery({}))).not.toContain("zw-gallery");
    expect(render(gallery({ images: [] }))).not.toContain("zw-gallery");
  });

  it("renders one img per picked image, resolved through ctx.asset", () => {
    const html = render(gallery({ images: ["/uploads/a.jpg", "/uploads/b.jpg"] }));
    expect(html).toContain("zw-gallery");
    expect((html.match(/<img/g) ?? []).length).toBe(2);
    expect(html).toContain("/uploads/a.jpg");
    expect(html).toContain("/uploads/b.jpg");
  });

  it("honours layout and columns", () => {
    const html = render(gallery({ images: ["/u/a.jpg"], layout: "masonry", columns: 4 }));
    expect(html).toContain("zw-gallery-masonry");
    expect(html).toContain("--zw-gallery-cols:4");
  });

  it("filters non-string entries from the opaque prop", () => {
    const html = render(gallery({ images: ["/u/a.jpg", 42, null, "/u/b.jpg"] }));
    expect((html.match(/<img/g) ?? []).length).toBe(2);
  });
});

describe("Slider (images)", () => {
  const slider = (props: Record<string, unknown>) =>
    scaffold(widget("sl", "media/slider", { props }));

  it("renders nothing without images", () => {
    expect(render(slider({}))).not.toContain("zw-slider");
  });

  it("renders a slide per image with the runtime opt-in attribute", () => {
    const html = render(slider({ images: ["/u/a.jpg", "/u/b.jpg", "/u/c.jpg"], autoplay: true, interval: 4000 }));
    expect(html).toContain("data-zw-slider");
    expect(html).toContain("data-autoplay");
    expect(html).toContain('data-interval="4000"');
    expect((html.match(/zw-slide"/g) ?? []).length).toBe(3);
    expect((html.match(/<img/g) ?? []).length).toBe(3);
  });

  it("shows arrows and dots only when enabled and there is more than one slide", () => {
    const on = render(slider({ images: ["/u/a.jpg", "/u/b.jpg"], arrows: true, dots: true }));
    expect(on).toContain("zw-slider-prev");
    expect(on).toContain("zw-slider-dots");
    const off = render(slider({ images: ["/u/a.jpg", "/u/b.jpg"], arrows: false, dots: false }));
    expect(off).not.toContain("zw-slider-prev");
    expect(off).not.toContain("zw-slider-dots");
  });

  it("omits autoplay attr when autoplay is off", () => {
    const html = render(slider({ images: ["/u/a.jpg", "/u/b.jpg"], autoplay: false }));
    expect(html).not.toContain("data-autoplay");
  });
});

describe("ContentSlider", () => {
  const node = widget("cs", "dynamic/content-slider", {
    binding: { source: "collection", contentType: "post", limit: 6, sort: "newest" },
    props: { heading: "Featured" },
  });

  it("renders a slide per collection row, with the cover image from data", () => {
    const ctx = mockCtx({
      collections: {
        post_6_newest: [
          { id: "p1", title: "First", path: "/blog/first", excerpt: "Hi", data: { heroImage: "/u/hero.jpg" } } as unknown as ContentDto,
          { id: "p2", title: "Second", path: "/blog/second", data: {} } as unknown as ContentDto,
        ],
      },
    });
    const html = render(scaffold(node), ctx);
    expect(html).toContain("data-zw-slider");
    expect(html).toContain("First");
    expect(html).toContain('href="/blog/first"');
    expect(html).toContain("/u/hero.jpg");
    expect(html).toContain("Featured");
  });

  it("renders nothing (beyond a heading) when unbound or empty", () => {
    const unbound = widget("cs2", "dynamic/content-slider", { props: {} });
    expect(render(scaffold(unbound))).not.toContain("zw-slider");
    expect(render(scaffold(node), mockCtx())).toContain("zw-post-list-empty");
  });
});

describe("ArchiveList", () => {
  it("renders nothing off the archive template (ctx.archive is null)", () => {
    expect(render(scaffold(widget("al", "dynamic/archive-list")))).not.toContain("zw-post-list");
  });

  it("renders the archive's own paginated items", () => {
    const ctx = mockCtx({
      archive: {
        contentTypeKey: "post",
        basePath: "/blog",
        page: 2,
        totalPages: 5,
        items: [
          { id: "p1", title: "Alpha", path: "/blog/alpha", excerpt: "Hi" } as unknown as ContentDto,
          { id: "p2", title: "Beta", path: "/blog/beta" } as unknown as ContentDto,
        ],
      },
    });
    const html = render(scaffold(widget("al", "dynamic/archive-list")), ctx);
    expect(html).toContain("Alpha");
    expect(html).toContain("Beta");
    expect(html).toContain('href="/blog/alpha"');
  });
});

describe("Pagination", () => {
  const archive = (over: Record<string, unknown> = {}) => ({
    contentTypeKey: "post",
    basePath: "/blog",
    page: 2,
    totalPages: 5,
    items: [],
    ...over,
  });

  it("renders nothing when there is at most one page, or no archive", () => {
    expect(render(scaffold(widget("pg", "dynamic/pagination")))).not.toContain("zw-pagination");
    const one = mockCtx({ archive: archive({ totalPages: 1 }) as never });
    expect(render(scaffold(widget("pg", "dynamic/pagination")), one)).not.toContain("zw-pagination");
  });

  it("builds every link through ctx.url so it keeps the locale", () => {
    // ctx.url prefixes the current locale — the pager must never emit a bare path.
    const ctx = mockCtx({ archive: archive() as never, url: (p: string) => `/vi${p}` });
    const html = render(scaffold(widget("pg", "dynamic/pagination")), ctx);
    // prev → page 1 is the bare (locale-prefixed) path; next → page 3 with the query.
    expect(html).toContain('href="/vi/blog"');
    expect(html).toContain('href="/vi/blog?page=3"');
    expect(html).not.toContain('href="/blog?page='); // never an un-prefixed link
  });

  it("marks the current page as current, not a link", () => {
    const ctx = mockCtx({ archive: archive() as never, url: (p: string) => `/vi${p}` });
    const html = render(scaffold(widget("pg", "dynamic/pagination")), ctx);
    expect(html).toContain('aria-current="page"');
    // page 2 is current → there is no link to page 2
    expect(html).not.toContain('href="/vi/blog?page=2"');
  });
});

describe("Common UI components", () => {
  it("Card renders nothing when it is entirely empty", () => {
    expect(render(scaffold(widget("c", "content/card")))).not.toContain("zw-card");
  });

  it("Card with only a link and no button label makes the whole card a link", () => {
    const node = widget("c", "content/card", { props: { title: "Hi", href: "/about" } });
    const html = render(scaffold(node));
    expect(html).toContain("zw-card-link");
    expect(html).toContain('href="/about"');
  });

  it("Avatar falls back to initials when there is no image", () => {
    const node = widget("a", "media/avatar", { props: { name: "Ada Lovelace" } });
    const html = render(scaffold(node));
    expect(html).toContain("zw-avatar-initials");
    expect(html).toContain("AL");
  });

  it("Avatar renders nothing with neither image nor name", () => {
    expect(render(scaffold(widget("a", "media/avatar")))).not.toContain("zw-avatar");
  });

  it("Badge draws its variant class and nothing when unlabelled", () => {
    const html = render(scaffold(widget("b", "content/badge", { props: { label: "New", variant: "success" } })));
    expect(html).toContain("zw-badge-success");
    expect(html).toContain("New");
    expect(render(scaffold(widget("b", "content/badge")))).not.toContain("zw-badge");
  });

  it("Tag with a link goes through ctx.url", () => {
    const ctx = mockCtx({ url: (p: string) => `/vi${p}` });
    const html = render(scaffold(widget("t", "content/tag", { props: { label: "Dogs", href: "/dogs" } })), ctx);
    expect(html).toContain('href="/vi/dogs"');
    expect(html).toContain("Dogs");
  });

  it("Progress clamps its value and reports it for assistive tech", () => {
    const html = render(scaffold(widget("p", "content/progress", { props: { value: 140 } })));
    expect(html).toContain('aria-valuenow="100"');
    expect(html).toContain("width:100%");
  });

  it("Rating fills to the score's proportion", () => {
    const html = render(scaffold(widget("r", "content/rating", { props: { value: 3, max: 5 } })));
    expect(html).toContain("zw-rating-fill");
    expect(html).toContain("width:60%");
  });

  it("Accordion skips empty slots and opens the first", () => {
    const node = widget("ac", "content/accordion", {
      props: { q1: "Q1", a1: "A1", q2: "", a2: "", openFirst: true },
    });
    const html = render(scaffold(node));
    expect(html).toContain("<details");
    expect(html).toContain("open");
    expect(html).toContain("Q1");
    // one <details>, not two — the empty second slot is dropped
    expect(html.match(/<details/g)?.length).toBe(1);
  });

  it("Timeline and Table render their sanitised HTML", () => {
    const tl = render(scaffold(widget("tl", "content/timeline", { props: { html: "<ul><li>Point</li></ul>" } })));
    expect(tl).toContain("zw-timeline");
    expect(tl).toContain("<li>Point</li>");
    const tb = render(scaffold(widget("tb", "content/table", { props: { html: "<table><tr><td>x</td></tr></table>" } })));
    expect(tb).toContain("zw-table");
    expect(tb).toContain("<td>x</td>");
  });
});

describe("Breadcrumb", () => {
  const page = (): ContentDto =>
    ({ id: "p1", title: "Collar", path: "/shop/dogs/collar" }) as unknown as ContentDto;

  it("renders nothing without a viewed page (home/archive)", () => {
    expect(render(scaffold(widget("bc", "dynamic/breadcrumb")), mockCtx(), null)).not.toContain("zw-breadcrumb");
  });

  it("links ancestors and uses the page title for the last crumb", () => {
    const ctx = mockCtx({ url: (p: string) => `/vi${p}` });
    const html = render(scaffold(widget("bc", "dynamic/breadcrumb")), ctx, page());
    // Home + de-slugified, locale-prefixed ancestor links
    expect(html).toContain('href="/vi/"');
    expect(html).toContain('href="/vi/shop"');
    expect(html).toContain('href="/vi/shop/dogs"');
    expect(html).toContain("Dogs"); // "dogs" de-slugified
    // current page is its real title, marked current, not a link
    expect(html).toContain('aria-current="page"');
    expect(html).toContain("Collar");
    expect(html).not.toContain('href="/vi/shop/dogs/collar"');
  });

  it("can hide the Home crumb", () => {
    const html = render(scaffold(widget("bc", "dynamic/breadcrumb", { props: { showHome: false } })), mockCtx(), page());
    expect(html).not.toContain('href="/"');
    expect(html).toContain("Collar");
  });
});
