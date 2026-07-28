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
  | "imageList"
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
      { key: "label", labelKey: "themeEditor.props.label", kind: "text", default: "Button" },
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
    type: "media/gallery",
    labelKey: "themeEditor.widgets.gallery.label",
    descriptionKey: "themeEditor.widgets.gallery.description",
    icon: "▦",
    category: "media",
    // Hand-picked, not a query: the images are chosen from the Media library and
    // travel as URLs in props, exactly like a single media/image's src. A dynamic
    // "newest N in folder X" gallery would be a bind kind, which needs a media
    // channel on the render payload — deliberately not this widget.
    bind: { kind: "none" },
    props: [
      { key: "images", labelKey: "themeEditor.props.images", kind: "imageList", default: [] },
      {
        key: "layout",
        labelKey: "themeEditor.props.galleryLayout",
        kind: "select",
        options: [
          { value: "grid", labelKey: "themeEditor.props.galleryGrid" },
          { value: "masonry", labelKey: "themeEditor.props.galleryMasonry" },
          { value: "carousel", labelKey: "themeEditor.props.galleryCarousel" },
        ],
        default: "grid",
      },
      { key: "columns", labelKey: "themeEditor.props.columns", kind: "number", min: 1, max: 6, default: 3 },
      { key: "gap", labelKey: "themeEditor.props.gap", kind: "number", min: 0, max: 64, default: 12 },
    ],
  },
  {
    type: "media/slider",
    labelKey: "themeEditor.widgets.slider.label",
    descriptionKey: "themeEditor.widgets.slider.description",
    icon: "▭",
    category: "media",
    // Hand-picked image slides, same as gallery — the URLs travel in props. The
    // autoplay/arrows/dots are enhanced by ONE reviewed runtime script keyed off a
    // data-attribute; the theme itself ships no JS.
    bind: { kind: "none" },
    props: [
      { key: "images", labelKey: "themeEditor.props.images", kind: "imageList", default: [] },
      { key: "height", labelKey: "themeEditor.props.height", kind: "number", min: 120, max: 800, default: 420 },
      { key: "autoplay", labelKey: "themeEditor.props.autoplay", kind: "boolean", default: true },
      { key: "interval", labelKey: "themeEditor.props.interval", kind: "number", min: 2000, max: 15000, default: 5000 },
      { key: "arrows", labelKey: "themeEditor.props.arrows", kind: "boolean", default: true },
      { key: "dots", labelKey: "themeEditor.props.dots", kind: "boolean", default: true },
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
    type: "layout/contact-form",
    labelKey: "themeEditor.widgets.contactForm.label",
    descriptionKey: "themeEditor.widgets.contactForm.description",
    icon: "✉",
    category: "layout",
    // A no-JS contact form posting to the runtime's /api/contact/submit. Its fields
    // (name/email/message) are a subset of CONTACT_FORM_FIELDS — the same list cms-api
    // validates and the runtime's enhancer upgrades — so a drawn form works end to end
    // with zero backend wiring. bind:none: it submits, it does not read the page.
    bind: { kind: "none" },
    props: [
      { key: "nameLabel", labelKey: "themeEditor.props.nameLabel", kind: "text", default: "Name" },
      { key: "emailLabel", labelKey: "themeEditor.props.emailLabel", kind: "text", default: "Email" },
      { key: "messageLabel", labelKey: "themeEditor.props.messageLabel", kind: "text", default: "Message" },
      { key: "submitLabel", labelKey: "themeEditor.props.submitLabel", kind: "text", default: "Send message" },
      {
        key: "successText",
        labelKey: "themeEditor.props.successText",
        kind: "text",
        default: "Thanks — your message has been sent.",
      },
      {
        key: "errorText",
        labelKey: "themeEditor.props.errorText",
        kind: "text",
        default: "Sorry, something went wrong. Please try again.",
      },
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
  {
    type: "dynamic/content-slider",
    labelKey: "themeEditor.widgets.contentSlider.label",
    descriptionKey: "themeEditor.widgets.contentSlider.description",
    icon: "▭",
    category: "dynamic",
    // A slider whose slides ARE content: same collection binding as post-list, one
    // slide per item (cover image + title + excerpt). Autoplay/arrows/dots are the
    // runtime script's job, exactly as the image slider.
    bind: { kind: "collection" },
    props: [
      { key: "heading", labelKey: "themeEditor.props.heading", kind: "text", default: "" },
      { key: "showExcerpt", labelKey: "themeEditor.props.showExcerpt", kind: "boolean", default: true },
      { key: "autoplay", labelKey: "themeEditor.props.autoplay", kind: "boolean", default: true },
      { key: "interval", labelKey: "themeEditor.props.interval", kind: "number", min: 2000, max: 15000, default: 5000 },
      { key: "arrows", labelKey: "themeEditor.props.arrows", kind: "boolean", default: true },
      { key: "dots", labelKey: "themeEditor.props.dots", kind: "boolean", default: true },
    ],
  },
  {
    type: "dynamic/archive-list",
    labelKey: "themeEditor.widgets.archiveList.label",
    descriptionKey: "themeEditor.widgets.archiveList.description",
    icon: "≣",
    category: "dynamic",
    // Reads the paginated archive off ctx — it has no binding of its own. On any
    // non-archive template it draws nothing, so it belongs on the `archive` tab.
    bind: { kind: "none" },
    props: [
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
  {
    type: "dynamic/pagination",
    labelKey: "themeEditor.widgets.pagination.label",
    descriptionKey: "themeEditor.widgets.pagination.description",
    icon: "»",
    category: "dynamic",
    // Draws prev / numbers / next for the archive, each link locale-safe. Reads the
    // archive off ctx; renders nothing on a single-page or non-archive view.
    bind: { kind: "none" },
    props: [
      { key: "showNumbers", labelKey: "themeEditor.props.showNumbers", kind: "boolean", default: true },
      {
        key: "shape",
        labelKey: "themeEditor.props.pagerShape",
        kind: "select",
        options: [
          { value: "rounded", labelKey: "themeEditor.props.pagerRounded" },
          { value: "square", labelKey: "themeEditor.props.pagerSquare" },
          { value: "circle", labelKey: "themeEditor.props.pagerCircle" },
        ],
        default: "rounded",
      },
      { key: "pageBackground", labelKey: "themeEditor.props.pageBackground", kind: "color", default: "" },
      { key: "pageColor", labelKey: "themeEditor.props.pageColor", kind: "color", default: "" },
      { key: "activeBackground", labelKey: "themeEditor.props.activeBackground", kind: "color", default: "" },
      { key: "activeColor", labelKey: "themeEditor.props.activeColor", kind: "color", default: "" },
    ],
  },

  // -------------------------------------------------------------------------
  // Common UI components (server-rendered, no client JS). Each is a pure static
  // widget the same way heading/button are: props in, reviewed markup out. The
  // interactive-looking ones (accordion) use a native no-JS element (<details>);
  // the multi-item ones (timeline, table) take an `html` prop the same way
  // richtext does — sanitised on save, then styled by widgets.css.
  // -------------------------------------------------------------------------
  {
    type: "content/card",
    labelKey: "themeEditor.widgets.card.label",
    descriptionKey: "themeEditor.widgets.card.description",
    icon: "▢",
    category: "content",
    bind: { kind: "none" },
    props: [
      { key: "image", labelKey: "themeEditor.props.src", kind: "image", default: "" },
      { key: "title", labelKey: "themeEditor.props.title", kind: "text", default: "Card title" },
      { key: "text", labelKey: "themeEditor.props.body", kind: "textarea", default: "" },
      { key: "buttonLabel", labelKey: "themeEditor.props.buttonLabel", kind: "text", default: "" },
      { key: "href", labelKey: "themeEditor.props.href", kind: "url", default: "" },
    ],
  },
  {
    type: "media/avatar",
    labelKey: "themeEditor.widgets.avatar.label",
    descriptionKey: "themeEditor.widgets.avatar.description",
    icon: "◉",
    category: "media",
    bind: { kind: "none" },
    props: [
      { key: "src", labelKey: "themeEditor.props.src", kind: "image", default: "" },
      // The initials fallback when there is no image — an avatar with neither is
      // a silent empty circle, so `name` gives it a letter.
      { key: "name", labelKey: "themeEditor.props.avatarName", kind: "text", default: "" },
      { key: "size", labelKey: "themeEditor.props.size", kind: "number", min: 24, max: 200, default: 56 },
      {
        key: "shape",
        labelKey: "themeEditor.props.shape",
        kind: "select",
        options: [
          { value: "circle", labelKey: "themeEditor.props.shapeCircle" },
          { value: "rounded", labelKey: "themeEditor.props.shapeRounded" },
          { value: "square", labelKey: "themeEditor.props.shapeSquare" },
        ],
        default: "circle",
      },
    ],
  },
  {
    type: "content/badge",
    labelKey: "themeEditor.widgets.badge.label",
    descriptionKey: "themeEditor.widgets.badge.description",
    icon: "●",
    category: "content",
    bind: { kind: "none" },
    props: [
      { key: "label", labelKey: "themeEditor.props.label", kind: "text", default: "New" },
      {
        key: "variant",
        labelKey: "themeEditor.props.variant",
        kind: "select",
        options: [
          { value: "neutral", labelKey: "themeEditor.props.variantNeutral" },
          { value: "primary", labelKey: "themeEditor.props.variantPrimary" },
          { value: "success", labelKey: "themeEditor.props.variantSuccess" },
          { value: "warning", labelKey: "themeEditor.props.variantWarning" },
          { value: "danger", labelKey: "themeEditor.props.variantDanger" },
        ],
        default: "primary",
      },
    ],
  },
  {
    type: "content/tag",
    labelKey: "themeEditor.widgets.tag.label",
    descriptionKey: "themeEditor.widgets.tag.description",
    icon: "#",
    category: "content",
    bind: { kind: "none" },
    props: [
      { key: "label", labelKey: "themeEditor.props.label", kind: "text", default: "Tag" },
      // Optional: a tag with a link is a category chip; without one it is a plain
      // pill. Either way it draws as long as it has a label.
      { key: "href", labelKey: "themeEditor.props.href", kind: "url", default: "" },
      {
        key: "variant",
        labelKey: "themeEditor.props.variant",
        kind: "select",
        options: [
          { value: "neutral", labelKey: "themeEditor.props.variantNeutral" },
          { value: "primary", labelKey: "themeEditor.props.variantPrimary" },
          { value: "success", labelKey: "themeEditor.props.variantSuccess" },
          { value: "warning", labelKey: "themeEditor.props.variantWarning" },
          { value: "danger", labelKey: "themeEditor.props.variantDanger" },
        ],
        default: "neutral",
      },
    ],
  },
  {
    type: "content/alert",
    labelKey: "themeEditor.widgets.alert.label",
    descriptionKey: "themeEditor.widgets.alert.description",
    icon: "!",
    category: "content",
    bind: { kind: "none" },
    props: [
      { key: "title", labelKey: "themeEditor.props.title", kind: "text", default: "" },
      { key: "text", labelKey: "themeEditor.props.body", kind: "textarea", default: "Heads up — here is something worth noting." },
      {
        key: "variant",
        labelKey: "themeEditor.props.variant",
        kind: "select",
        options: [
          { value: "info", labelKey: "themeEditor.props.variantInfo" },
          { value: "success", labelKey: "themeEditor.props.variantSuccess" },
          { value: "warning", labelKey: "themeEditor.props.variantWarning" },
          { value: "danger", labelKey: "themeEditor.props.variantDanger" },
        ],
        default: "info",
      },
    ],
  },
  {
    type: "content/progress",
    labelKey: "themeEditor.widgets.progress.label",
    descriptionKey: "themeEditor.widgets.progress.description",
    icon: "▬",
    category: "content",
    bind: { kind: "none" },
    props: [
      { key: "label", labelKey: "themeEditor.props.label", kind: "text", default: "" },
      { key: "value", labelKey: "themeEditor.props.value", kind: "number", min: 0, max: 100, default: 60 },
      { key: "showValue", labelKey: "themeEditor.props.showValue", kind: "boolean", default: true },
      { key: "barColor", labelKey: "themeEditor.props.barColor", kind: "color", default: "" },
    ],
  },
  {
    type: "content/rating",
    labelKey: "themeEditor.widgets.rating.label",
    descriptionKey: "themeEditor.widgets.rating.description",
    icon: "★",
    category: "content",
    bind: { kind: "none" },
    props: [
      { key: "value", labelKey: "themeEditor.props.value", kind: "number", min: 0, max: 5, default: 4 },
      { key: "max", labelKey: "themeEditor.props.max", kind: "number", min: 1, max: 10, default: 5 },
      { key: "showValue", labelKey: "themeEditor.props.showValue", kind: "boolean", default: false },
    ],
  },
  {
    type: "content/accordion",
    labelKey: "themeEditor.widgets.accordion.label",
    descriptionKey: "themeEditor.widgets.accordion.description",
    icon: "≡",
    category: "content",
    // Four fixed slots, empty ones skipped — a native <details>/<summary> group, so
    // it opens and closes with zero JavaScript. Structured props rather than an
    // `html` prop because the sanitiser drops <details>, so the widget must emit it.
    bind: { kind: "none" },
    props: [
      { key: "q1", labelKey: "themeEditor.props.accordion.q1", kind: "text", default: "First question" },
      { key: "a1", labelKey: "themeEditor.props.accordion.a1", kind: "textarea", default: "The answer to the first question." },
      { key: "q2", labelKey: "themeEditor.props.accordion.q2", kind: "text", default: "Second question" },
      { key: "a2", labelKey: "themeEditor.props.accordion.a2", kind: "textarea", default: "The answer to the second question." },
      { key: "q3", labelKey: "themeEditor.props.accordion.q3", kind: "text", default: "" },
      { key: "a3", labelKey: "themeEditor.props.accordion.a3", kind: "textarea", default: "" },
      { key: "q4", labelKey: "themeEditor.props.accordion.q4", kind: "text", default: "" },
      { key: "a4", labelKey: "themeEditor.props.accordion.a4", kind: "textarea", default: "" },
      { key: "openFirst", labelKey: "themeEditor.props.openFirst", kind: "boolean", default: true },
    ],
  },
  {
    type: "content/timeline",
    labelKey: "themeEditor.widgets.timeline.label",
    descriptionKey: "themeEditor.widgets.timeline.description",
    icon: "┋",
    category: "content",
    // The entries are a plain list the author writes (one <li> per point); the
    // stylesheet draws the connecting line and the dots. An `html` prop, sanitised
    // on save exactly like richtext — no per-item props, no JS.
    bind: { kind: "none" },
    props: [
      {
        key: "html",
        labelKey: "themeEditor.props.timelineHtml",
        kind: "html",
        hintKey: "themeEditor.hints.timelineHtml",
        default: "<ul><li><strong>2024</strong> — Something happened here.</li><li><strong>2025</strong> — And then this.</li></ul>",
      },
    ],
  },
  {
    type: "content/table",
    labelKey: "themeEditor.widgets.table.label",
    descriptionKey: "themeEditor.widgets.table.description",
    icon: "⊞",
    category: "content",
    // A table the author writes as HTML — table/thead/tbody/tr/th/td all survive the
    // sanitiser. The widget only wraps it so it scrolls on narrow screens and picks
    // up consistent styling.
    bind: { kind: "none" },
    props: [
      {
        key: "html",
        labelKey: "themeEditor.props.tableHtml",
        kind: "html",
        hintKey: "themeEditor.hints.tableHtml",
        default:
          "<table><thead><tr><th>Plan</th><th>Price</th></tr></thead><tbody><tr><td>Basic</td><td>$9</td></tr><tr><td>Pro</td><td>$19</td></tr></tbody></table>",
      },
    ],
  },
  {
    type: "dynamic/breadcrumb",
    labelKey: "themeEditor.widgets.breadcrumb.label",
    descriptionKey: "themeEditor.widgets.breadcrumb.description",
    icon: "›",
    category: "dynamic",
    // Built from the viewed page's own path (e.g. "/shop/dogs/collar"): a link per
    // ancestor segment, the current page's title as the last crumb. Binds to the
    // page's title; the path always travels on the content, so no extra field.
    // Empty on Home and Archive, where there is no single viewed page.
    bind: { kind: "current", fields: ["title"] },
    props: [
      { key: "showHome", labelKey: "themeEditor.props.showHome", kind: "boolean", default: true },
      { key: "homeLabel", labelKey: "themeEditor.props.homeLabel", kind: "text", default: "Home" },
      {
        key: "separator",
        labelKey: "themeEditor.props.separator",
        kind: "select",
        options: [
          { value: "chevron", labelKey: "themeEditor.props.separatorChevron" },
          { value: "slash", labelKey: "themeEditor.props.separatorSlash" },
          { value: "dot", labelKey: "themeEditor.props.separatorDot" },
        ],
        default: "chevron",
      },
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
