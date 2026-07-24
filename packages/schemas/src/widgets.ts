import { type CollectionSort } from "./blocks";
import { type CurrentBindingField, type LayoutNodeKind } from "./layout";

/**
 * The catalogue of things a person can drop onto the canvas, and the settings each
 * one exposes. It is to the Theme Editor what BLOCK_SPECS is to the block editor:
 * the single description of what a widget contains, shipped once and rendered in
 * whatever language the admin runs in (hence catalogue keys, never text).
 *
 * Three consumers read this one file, which is why it lives in @zcmsorg/schemas and
 * not in admin-web:
 *
 *   - the editor, to build the palette and the per-widget settings panel;
 *   - the widget library (@zcmsorg/theme-widgets), to know which props each
 *     component reads and to default the ones an old document omits;
 *   - the code generator, to emit a manifest and to reject a widget type it has
 *     never heard of before it reaches a signed package.
 *
 * A widget type absent from here is not rendered and not generated — the same
 * "unknown type is skipped, never crashes" rule the block system holds.
 */

// ---------------------------------------------------------------------------
// Controls.
//
// A closed set, chosen so the editor's settings panel can be a switch over `kind`
// and the widget library never receives a value shaped like something it cannot
// draw. `color` and `image` exist for the same reason `number` does in the block
// registry: a text box is a trap for a hex code and for an asset path.
// ---------------------------------------------------------------------------

export type WidgetPropKind =
  | "text"
  | "textarea"
  | "html"
  | "url"
  | "image"
  | "boolean"
  | "select"
  | "number"
  | "color";

export interface WidgetPropSpec {
  key: string;
  labelKey: string;
  kind: WidgetPropKind;
  placeholderKey?: string;
  hintKey?: string;
  options?: { value: string; labelKey: string }[];
  /** For `number`: the inclusive bounds the control clamps to. */
  min?: number;
  max?: number;
  /** The value a freshly-dropped widget starts with. */
  default?: unknown;
}

/**
 * What a widget may bind to, declared so the editor knows whether to show the
 * data-binding controls and the code generator knows whether the widget
 * contributes a collection query. `none` is the common case — a heading shows the
 * text an author typed, not something the server fetched.
 */
export type WidgetBindKind = "none" | "collection" | "current";

export interface WidgetBindSpec {
  kind: WidgetBindKind;
  /** For `current`: which fields of the viewed page this widget can read. */
  fields?: readonly CurrentBindingField[];
}

/** The palette groups a widget can appear under. */
export type WidgetCategory = "content" | "media" | "layout" | "dynamic";

export interface WidgetSpec {
  type: string;
  labelKey: string;
  descriptionKey: string;
  icon: string;
  category: WidgetCategory;
  props: WidgetPropSpec[];
  bind: WidgetBindSpec;
}

const ALIGN_OPTIONS: WidgetPropSpec["options"] = [
  { value: "left", labelKey: "themeEditor.props.alignLeft" },
  { value: "center", labelKey: "themeEditor.props.alignCenter" },
  { value: "right", labelKey: "themeEditor.props.alignRight" },
];

const HEADING_LEVEL_OPTIONS: WidgetPropSpec["options"] = [1, 2, 3, 4, 5, 6].map(
  (n) => ({ value: String(n), labelKey: `themeEditor.props.headingLevel.h${n}` }),
);

const SORT_LABEL_KEYS: Record<CollectionSort, string> = {
  newest: "themeEditor.props.sortNewest",
  oldest: "themeEditor.props.sortOldest",
  title: "themeEditor.props.sortTitle",
};

export const WIDGET_CATALOG: WidgetSpec[] = [
  {
    type: "layout/heading",
    labelKey: "themeEditor.widgets.heading.label",
    descriptionKey: "themeEditor.widgets.heading.description",
    icon: "H",
    category: "content",
    bind: { kind: "none" },
    props: [
      { key: "text", labelKey: "themeEditor.props.text", kind: "text", default: "Heading" },
      {
        key: "level",
        labelKey: "themeEditor.props.headingLevel.label",
        kind: "select",
        options: HEADING_LEVEL_OPTIONS,
        default: "2",
      },
      { key: "align", labelKey: "themeEditor.props.align", kind: "select", options: ALIGN_OPTIONS, default: "left" },
    ],
  },
  {
    type: "layout/richtext",
    labelKey: "themeEditor.widgets.richtext.label",
    descriptionKey: "themeEditor.widgets.richtext.description",
    icon: "T",
    category: "content",
    bind: { kind: "none" },
    props: [{ key: "html", labelKey: "themeEditor.props.html", kind: "html", default: "<p></p>" }],
  },
  {
    type: "layout/button",
    labelKey: "themeEditor.widgets.button.label",
    descriptionKey: "themeEditor.widgets.button.description",
    icon: "B",
    category: "content",
    bind: { kind: "none" },
    props: [
      { key: "label", labelKey: "themeEditor.props.label", kind: "text", default: "Learn more" },
      { key: "href", labelKey: "themeEditor.props.href", kind: "url", default: "" },
      {
        key: "variant",
        labelKey: "themeEditor.props.variant",
        kind: "select",
        options: [
          { value: "primary", labelKey: "themeEditor.props.variantPrimary" },
          { value: "secondary", labelKey: "themeEditor.props.variantSecondary" },
          { value: "link", labelKey: "themeEditor.props.variantLink" },
        ],
        default: "primary",
      },
      { key: "align", labelKey: "themeEditor.props.align", kind: "select", options: ALIGN_OPTIONS, default: "left" },
    ],
  },
  {
    type: "media/image",
    labelKey: "themeEditor.widgets.image.label",
    descriptionKey: "themeEditor.widgets.image.description",
    icon: "I",
    category: "media",
    bind: { kind: "none" },
    props: [
      { key: "src", labelKey: "themeEditor.props.src", kind: "image", default: "" },
      { key: "alt", labelKey: "themeEditor.props.alt", kind: "text", default: "" },
      { key: "caption", labelKey: "themeEditor.props.caption", kind: "text", default: "" },
      {
        key: "width",
        labelKey: "themeEditor.props.width",
        kind: "select",
        options: [
          { value: "contained", labelKey: "themeEditor.props.widthContained" },
          { value: "wide", labelKey: "themeEditor.props.widthWide" },
          { value: "full", labelKey: "themeEditor.props.widthFull" },
        ],
        default: "contained",
      },
    ],
  },
  {
    type: "media/logo",
    labelKey: "themeEditor.widgets.logo.label",
    descriptionKey: "themeEditor.widgets.logo.description",
    icon: "L",
    category: "media",
    bind: { kind: "none" },
    // No src: the logo is the site's, read from ctx at render time. An override
    // would let one theme hardcode another site's brand — the asset() resolver
    // already handles a site-uploaded logo winning over a theme default.
    props: [
      {
        key: "height",
        labelKey: "themeEditor.props.height",
        kind: "number",
        min: 16,
        max: 200,
        default: 40,
      },
    ],
  },
  {
    type: "layout/menu",
    labelKey: "themeEditor.widgets.menu.label",
    descriptionKey: "themeEditor.widgets.menu.description",
    icon: "M",
    category: "layout",
    bind: { kind: "none" },
    props: [
      // A menu LOCATION key, not the menu itself: the site assigns a menu to a
      // location, so a drawn theme names a location and the runtime supplies the
      // menu. Defaulted to "primary", the location every site is seeded with.
      { key: "location", labelKey: "themeEditor.props.menuLocation", kind: "text", default: "primary" },
      {
        key: "orientation",
        labelKey: "themeEditor.props.orientation",
        kind: "select",
        options: [
          { value: "horizontal", labelKey: "themeEditor.props.orientationHorizontal" },
          { value: "vertical", labelKey: "themeEditor.props.orientationVertical" },
        ],
        default: "horizontal",
      },
    ],
  },
  {
    type: "layout/spacer",
    labelKey: "themeEditor.widgets.spacer.label",
    descriptionKey: "themeEditor.widgets.spacer.description",
    icon: "—",
    category: "layout",
    bind: { kind: "none" },
    props: [
      { key: "height", labelKey: "themeEditor.props.height", kind: "number", min: 0, max: 400, default: 48 },
    ],
  },
  {
    type: "dynamic/post-title",
    labelKey: "themeEditor.widgets.postTitle.label",
    descriptionKey: "themeEditor.widgets.postTitle.description",
    icon: "Ⓣ",
    category: "dynamic",
    // Binds to the viewed page's title. On a `post`/`page` template this draws the
    // real title; on `home`/`archive`, where there is no single viewed page, it
    // renders nothing rather than a placeholder.
    bind: { kind: "current", fields: ["title"] },
    props: [
      { key: "align", labelKey: "themeEditor.props.align", kind: "select", options: ALIGN_OPTIONS, default: "left" },
      {
        key: "level",
        labelKey: "themeEditor.props.headingLevel.label",
        kind: "select",
        options: HEADING_LEVEL_OPTIONS,
        default: "1",
      },
    ],
  },
  {
    type: "dynamic/post-content",
    labelKey: "themeEditor.widgets.postContent.label",
    descriptionKey: "themeEditor.widgets.postContent.description",
    icon: "¶",
    category: "dynamic",
    // The viewed page's own block document, rendered through ctx.renderBlocks — the
    // one bridge between a drawn shell and hand-authored page content.
    bind: { kind: "current", fields: ["blocks"] },
    props: [],
  },
  {
    type: "dynamic/post-list",
    labelKey: "themeEditor.widgets.postList.label",
    descriptionKey: "themeEditor.widgets.postList.description",
    icon: "≣",
    category: "dynamic",
    // The one widget that lists content. Its binding (contentType/limit/sort) is
    // edited through the binding controls, not these props, and becomes a
    // CollectionQuery in the generated manifest.
    bind: { kind: "collection" },
    props: [
      { key: "heading", labelKey: "themeEditor.props.heading", kind: "text", default: "" },
      {
        key: "layout",
        labelKey: "themeEditor.props.layout",
        kind: "select",
        options: [
          { value: "list", labelKey: "themeEditor.props.layoutList" },
          { value: "grid", labelKey: "themeEditor.props.layoutGrid" },
        ],
        default: "list",
      },
      { key: "showExcerpt", labelKey: "themeEditor.props.showExcerpt", kind: "boolean", default: true },
    ],
  },
];

export function getWidgetSpec(type: string): WidgetSpec | undefined {
  return WIDGET_CATALOG.find((spec) => spec.type === type);
}

/** True when a widget type is one the catalogue knows (and the generator can emit). */
export function isKnownWidget(type: string): boolean {
  return WIDGET_CATALOG.some((spec) => spec.type === type);
}

/** The default props a freshly-dropped widget of this type starts with. */
export function defaultWidgetProps(type: string): Record<string, unknown> {
  const spec = getWidgetSpec(type);
  if (!spec) return {};
  const out: Record<string, unknown> = {};
  for (const prop of spec.props) {
    if (prop.default !== undefined) out[prop.key] = prop.default;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Containers.
//
// section, row and column are node KINDS, not widgets — they cannot be dropped
// from the palette, they are the scaffold widgets live in. But they still carry
// settings (a section's background, a row's gap, a column's span), and the editor
// renders those through the same control switch. So they get specs too, keyed by
// kind rather than listed in the catalogue.
// ---------------------------------------------------------------------------

export interface ContainerSpec {
  kind: Exclude<LayoutNodeKind, "widget">;
  labelKey: string;
  props: WidgetPropSpec[];
}

export const CONTAINER_SPECS: Record<ContainerSpec["kind"], ContainerSpec> = {
  section: {
    kind: "section",
    labelKey: "themeEditor.containers.section",
    props: [
      { key: "background", labelKey: "themeEditor.props.background", kind: "color", default: "" },
      {
        key: "width",
        labelKey: "themeEditor.props.contentWidth",
        kind: "select",
        options: [
          { value: "contained", labelKey: "themeEditor.props.widthContained" },
          { value: "full", labelKey: "themeEditor.props.widthFull" },
        ],
        default: "contained",
      },
      { key: "paddingY", labelKey: "themeEditor.props.paddingY", kind: "number", min: 0, max: 240, default: 64 },
    ],
  },
  row: {
    kind: "row",
    labelKey: "themeEditor.containers.row",
    props: [
      { key: "gap", labelKey: "themeEditor.props.gap", kind: "number", min: 0, max: 96, default: 24 },
      {
        key: "align",
        labelKey: "themeEditor.props.verticalAlign",
        kind: "select",
        options: [
          { value: "start", labelKey: "themeEditor.props.alignStart" },
          { value: "center", labelKey: "themeEditor.props.alignCenter" },
          { value: "stretch", labelKey: "themeEditor.props.alignStretch" },
        ],
        default: "stretch",
      },
    ],
  },
  column: {
    kind: "column",
    labelKey: "themeEditor.containers.column",
    props: [
      // A 12-column grid, as every layout tool converges on. `span` is how many of
      // the twelve this column occupies; the widget library turns it into a flex
      // basis and stacks columns on narrow screens.
      { key: "span", labelKey: "themeEditor.props.span", kind: "number", min: 1, max: 12, default: 12 },
    ],
  },
};

/** Labels for the sort options a post-list binding offers, keyed by sort value. */
export { SORT_LABEL_KEYS };
