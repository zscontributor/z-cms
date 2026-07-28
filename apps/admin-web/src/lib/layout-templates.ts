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
          // Two columns, vertically centred against each other: copy on the left,
          // a picture on the right. The row gap gives the two sides breathing room;
          // on a phone the columns stack (image under the text) on their own.
          row(
            [
              column(6, [
                widget("layout/heading", { text: "Build something remarkable", level: "1", align: "left" }),
                widget(
                  "layout/richtext",
                  {
                    html: "<p>A short, confident sentence about what you make and who it is for.</p>",
                  },
                  { fontSize: 18 },
                ),
                widget("layout/button", { label: "Get started", variant: "primary", align: "left" }),
              ]),
              // Empty src on purpose — the author drops their own image here; the
              // rounded corners are already set so it looks finished the moment they do.
              column(6, [widget("media/image", { alt: "", width: "full" }, { borderRadius: 16 })]),
            ],
            { gap: 48, align: "center" },
          ),
        ],
        // Taller than a normal section so the hero fills the top of the page.
        { paddingY: 120 },
        { backgroundGradient: "twilight", textColor: "#ffffff", minHeight: 460 },
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
  {
    key: "pricing",
    labelKey: "themeEditor.patterns.pricing.label",
    descriptionKey: "themeEditor.patterns.pricing.description",
    build: () => {
      // A pricing tier: name, price, a checkmark feature list and a CTA, boxed as a
      // card. Cards force a white fill and dark text so they stay legible whatever
      // the page sits on; the highlighted middle tier gets a heavier border, a
      // stronger shadow, a primary button and a "Popular" badge — same widgets, a
      // different style. Features are checkmark lines (not a <ul>) so they centre
      // cleanly without bullets.
      const featureList = (items: string[]) =>
        `<p>${items.map((f) => `✓ ${f}`).join("<br/>")}</p>`;
      const tier = (
        name: string,
        price: string,
        period: string,
        items: string[],
        cta: string,
        opts: { highlight?: boolean; badge?: string } = {},
      ): LayoutNode =>
        column(
          4,
          [
            ...(opts.badge
              ? [widget("content/badge", { label: opts.badge, variant: "primary" })]
              : []),
            widget("layout/heading", { text: name, level: "3", align: "center" }),
            widget("layout/heading", { text: price, level: "2", align: "center" }),
            widget("layout/richtext", { html: `<p>${period}</p>` }),
            widget("layout/richtext", { html: featureList(items) }),
            widget(
              "layout/button",
              {
                label: cta,
                variant: opts.highlight ? "primary" : "secondary",
                align: "center",
              },
              // Equal breathing room above and below the CTA — marginY sets marginTop
              // and marginBottom to the same value.
              { marginY: 8 },
            ),
          ],
          {
            background: "#ffffff",
            textColor: "#111827",
            textAlign: "center",
            borderRadius: 16,
            borderStyle: "solid",
            borderWidth: opts.highlight ? 2 : 1,
            borderColor: opts.highlight ? "#111827" : "#e5e7eb",
            boxShadow: opts.highlight ? "lg" : "sm",
            paddingX: 28,
            paddingY: 32,
          },
        );

      return [
        section([
          row([
            column(12, [
              widget("layout/heading", { text: "Simple, honest pricing", level: "2", align: "center" }),
              widget(
                "layout/richtext",
                { html: "<p>Pick a plan that fits. Change or cancel anytime.</p>" },
                { textAlign: "center" },
              ),
            ]),
          ]),
          row(
            [
              tier("Starter", "$9", "per month", ["Up to 3 projects", "Basic analytics", "Community support"], "Choose Starter"),
              tier(
                "Pro",
                "$29",
                "per month",
                ["Unlimited projects", "Advanced analytics", "Priority support"],
                "Choose Pro",
                { highlight: true, badge: "Popular" },
              ),
              tier("Team", "$79", "per month", ["Everything in Pro", "Team roles", "SSO and audit log"], "Choose Team"),
            ],
            { gap: 24, align: "stretch" },
          ),
        ]),
      ];
    },
  },
  {
    key: "contact",
    labelKey: "themeEditor.patterns.contact.label",
    descriptionKey: "themeEditor.patterns.contact.description",
    // A heading + intro beside a working contact form (name/email/message). The form
    // posts to the runtime's /api/contact/submit — no binding, no per-theme wiring.
    build: () => [
      section([
        row([
          column(5, [
            widget("layout/heading", { text: "Get in touch", level: "2", align: "left" }),
            widget("layout/richtext", {
              html: "<p>Tell us what you need and we'll get back to you shortly.</p>",
            }),
          ]),
          column(7, [widget("layout/contact-form")]),
        ]),
      ]),
    ],
  },
  {
    key: "footer",
    labelKey: "themeEditor.patterns.footer.label",
    descriptionKey: "themeEditor.patterns.footer.description",
    // A dark site footer: brand + blurb, a menu column, a contact column, then a
    // copyright line. Uses the site's own logo and a menu LOCATION ("footer") the
    // owner fills — the same widgets a hand-built footer would.
    build: () => [
      section(
        [
          row([
            column(5, [
              widget("media/logo", { height: 32 }),
              widget("layout/richtext", {
                html: "<p>A short line about your company or what your site is for.</p>",
              }),
            ]),
            column(3, [
              widget("layout/heading", { text: "Explore", level: "3", align: "left" }),
              widget("layout/menu", { location: "footer", orientation: "vertical" }),
            ]),
            column(4, [
              widget("layout/heading", { text: "Contact", level: "3", align: "left" }),
              widget("layout/richtext", {
                html: "<p>hello@example.com<br/>+00 000 000 000</p>",
              }),
            ]),
          ]),
          row([
            column(12, [
              widget(
                "layout/richtext",
                { html: "<p>© Your Company. All rights reserved.</p>" },
                { textAlign: "center" },
              ),
            ]),
          ]),
        ],
        { paddingY: 64 },
        { background: "#17191f", textColor: "#ffffff" },
      ),
    ],
  },
];
