import { defaultWidgetProps, type LayoutNode, type NodeStyle } from "@zcmsorg/schemas";
import { newNodeId } from "./layout-doc";

/**
 * Starter section patterns for the Theme Editor.
 *
 * A pattern is a factory that returns a fresh `LayoutNode[]` — a whole section,
 * wired from the SAME widgets and the SAME bounded style the editor already knows,
 * so it round-trips `LayoutDocumentSchema` like anything drawn by hand. It is data,
 * not a special case: inserting one is identical to dragging the widgets in and
 * setting their props, just done in one click.
 *
 * Every id is minted per call (`newNodeId`), so inserting the same pattern twice
 * produces two independent sections rather than two nodes sharing an id.
 */

type Props = Record<string, unknown>;

function widget(type: string, props: Props = {}, style?: NodeStyle): LayoutNode {
  return {
    id: newNodeId("w"),
    kind: "widget",
    widgetType: type,
    props: { ...defaultWidgetProps(type), ...props },
    ...(style ? { style } : {}),
  };
}

function column(span: number, children: LayoutNode[], style?: NodeStyle): LayoutNode {
  return {
    id: newNodeId("c"),
    kind: "column",
    props: { span },
    ...(style ? { style } : {}),
    children,
  };
}

function row(children: LayoutNode[], props: Props = {}, style?: NodeStyle): LayoutNode {
  return {
    id: newNodeId("r"),
    kind: "row",
    props: { gap: 24, ...props },
    ...(style ? { style } : {}),
    children,
  };
}

function section(children: LayoutNode[], props: Props = {}, style?: NodeStyle): LayoutNode {
  return {
    id: newNodeId("s"),
    kind: "section",
    props: { paddingY: 72, width: "contained", ...props },
    ...(style ? { style } : {}),
    children,
  };
}

export interface LayoutPattern {
  key: string;
  labelKey: string;
  descriptionKey: string;
  /** A fresh section (or sections) each call. */
  build: () => LayoutNode[];
}

export const LAYOUT_PATTERNS: readonly LayoutPattern[] = [
  {
    key: "hero",
    labelKey: "themeEditor.patterns.hero.label",
    descriptionKey: "themeEditor.patterns.hero.description",
    build: () => [
      section(
        [
          row([
            column(12, [
              widget("layout/heading", { text: "Build something remarkable", level: "1", align: "center" }),
              widget("layout/richtext", {
                html: "<p>A short, confident sentence about what you make and who it is for.</p>",
              }, { textAlign: "center" }),
              widget("layout/button", { label: "Get started", variant: "primary", align: "center" }),
            ]),
          ]),
        ],
        { paddingY: 96 },
        { backgroundGradient: "twilight", textColor: "#ffffff", textAlign: "center" },
      ),
    ],
  },
  {
    key: "features",
    labelKey: "themeEditor.patterns.features.label",
    descriptionKey: "themeEditor.patterns.features.description",
    build: () => [
      section([
        row([
          column(12, [widget("layout/heading", { text: "What you get", level: "2", align: "center" })]),
        ]),
        row(
          [1, 2, 3].map((n) =>
            column(4, [
              widget("layout/heading", { text: `Feature ${n}`, level: "3", align: "left" }),
              widget("layout/richtext", { html: "<p>Describe the value of this feature in a line or two.</p>" }),
            ]),
          ),
        ),
      ]),
    ],
  },
  {
    key: "mediaText",
    labelKey: "themeEditor.patterns.mediaText.label",
    descriptionKey: "themeEditor.patterns.mediaText.description",
    build: () => [
      section([
        row([
          column(6, [widget("media/image", { alt: "", width: "wide" })]),
          column(6, [
            widget("layout/heading", { text: "Made for real work", level: "2", align: "left" }),
            widget("layout/richtext", { html: "<p>Explain the outcome, not the mechanism. Keep it human.</p>" }),
            widget("layout/button", { label: "Learn more", variant: "secondary", align: "left" }),
          ]),
        ]),
      ]),
    ],
  },
  {
    key: "stats",
    labelKey: "themeEditor.patterns.stats.label",
    descriptionKey: "themeEditor.patterns.stats.description",
    build: () => [
      section(
        [
          row(
            [
              ["3×", "Faster publishing"],
              ["98", "Performance score"],
              ["100%", "Theme ownership"],
              ["24/7", "Secure delivery"],
            ].map(([value, label]) =>
              column(3, [
                widget("layout/heading", { text: value, level: "2", align: "center" }),
                widget("layout/richtext", { html: `<p>${label}</p>` }, { textAlign: "center" }),
              ]),
            ),
          ),
        ],
        { paddingY: 64 },
        { background: "#17191f", textColor: "#ffffff" },
      ),
    ],
  },
  {
    key: "latestPosts",
    labelKey: "themeEditor.patterns.latestPosts.label",
    descriptionKey: "themeEditor.patterns.latestPosts.description",
    build: () => [
      section([
        row([
          column(12, [
            {
              ...widget("dynamic/post-list", { heading: "Latest posts", layout: "grid", showExcerpt: true }),
              // A sensible default binding the author can re-point; an unknown type
              // just draws the empty state, exactly as on the live site.
              binding: { source: "collection", contentType: "post", limit: 6, sort: "newest" },
            },
          ]),
        ]),
      ]),
    ],
  },
  {
    key: "cta",
    labelKey: "themeEditor.patterns.cta.label",
    descriptionKey: "themeEditor.patterns.cta.description",
    build: () => [
      section(
        [
          row([
            column(12, [
              widget("layout/heading", { text: "Ready to start?", level: "2", align: "center" }),
              widget("layout/button", { label: "Contact us", variant: "primary", align: "center" }),
            ]),
          ]),
        ],
        { paddingY: 80 },
        { background: "#fafafa", textAlign: "center", borderRadius: 24 },
      ),
    ],
  },
];
