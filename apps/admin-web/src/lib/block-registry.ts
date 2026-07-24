import type { Translate } from "@zcmsorg/i18n";
import type { Block, CollectionSort, CoreBlockType } from "@zcmsorg/schemas";
import { COLLECTION_MAX_LIMIT, COLLECTION_SORTS, CORE_BLOCK_TYPES } from "@zcmsorg/schemas";

/**
 * The editor's view of a block type: which props it has and how to draw a
 * control for each. Core deliberately does not validate props server-side
 * (see packages/schemas/src/blocks.ts), so this registry is the only place the
 * admin knows what a "core/hero" contains. A block whose type is not in here
 * still round-trips: it is shown read-only as JSON rather than dropped.
 *
 * Every human-readable string here is a catalogue key, not text — the registry is
 * shipped once and rendered in whatever language the admin is running in. The
 * defaults are a factory for the same reason: a block's starting prose has to be
 * written in the editor's language at the moment it is inserted.
 */
/**
 * `number` and `contentType` exist because a text box is a trap for both of them.
 *
 * `number` is bounded (see `min`/`max`): a limit of "abc", or of 900, is not a
 * thing an editor meant to type, and the control should not have been able to
 * express it. `contentType` is a key that must exist on THIS site — typing "posts"
 * where the site says "post" yields a list that is silently, permanently empty, and
 * nothing anywhere tells the editor why. So the renderer resolves it against the
 * site's actual content types and offers them as a select.
 */
export type PropKind =
  | "text"
  | "textarea"
  | "html"
  | "url"
  | "boolean"
  | "select"
  | "number"
  | "contentType"
  | "items";

export interface PropSpec {
  key: string;
  labelKey: string;
  kind: PropKind;
  placeholderKey?: string;
  /** Shown under the control. Resolved with `{ min, max }` available as variables. */
  hintKey?: string;
  options?: { value: string; labelKey: string }[];
  /** For `number`: the inclusive bounds the control clamps to. */
  min?: number;
  max?: number;
  /** For `items`: the fields of each repeated entry. */
  itemFields?: { key: string; labelKey: string; kind: "text" | "textarea" }[];
  itemLabelKey?: string;
}

/**
 * The site's content types, as a `contentType` control needs them: the stored key
 * and the name to show a human. The editing screen has already loaded these — it
 * cannot render a content form without them — so the select costs no extra request.
 */
export interface ContentTypeOption {
  key: string;
  name: string;
}

/**
 * Typed against `CollectionSort`, so a sort added to the schema fails to compile
 * here until it has a label. The alternative — a select silently missing an option
 * the server accepts — is the kind of drift nobody notices for a release.
 */
const SORT_LABEL_KEYS: Record<CollectionSort, string> = {
  newest: "content.blocks.props.sortNewest",
  oldest: "content.blocks.props.sortOldest",
  title: "content.blocks.props.sortTitle",
};

export interface BlockSpec {
  type: CoreBlockType;
  labelKey: string;
  descriptionKey: string;
  icon: string;
  props: PropSpec[];
  defaults: (t: Translate) => Record<string, unknown>;
}

export const BLOCK_SPECS: BlockSpec[] = [
  {
    type: "core/hero",
    labelKey: "content.blocks.specs.hero.label",
    descriptionKey: "content.blocks.specs.hero.description",
    icon: "H",
    props: [
      {
        key: "heading",
        labelKey: "content.blocks.props.heading",
        kind: "text",
        placeholderKey: "content.blocks.placeholders.heroHeading",
      },
      { key: "subheading", labelKey: "content.blocks.props.subheading", kind: "textarea" },
      { key: "image", labelKey: "content.blocks.props.backgroundImage", kind: "url" },
      {
        key: "ctaLabel",
        labelKey: "content.blocks.props.ctaLabel",
        kind: "text",
        placeholderKey: "content.blocks.placeholders.ctaLabel",
      },
      {
        key: "ctaHref",
        labelKey: "content.blocks.props.ctaHref",
        kind: "url",
        placeholderKey: "content.blocks.placeholders.ctaHref",
      },
      {
        key: "align",
        labelKey: "content.blocks.props.align",
        kind: "select",
        options: [
          { value: "left", labelKey: "content.blocks.props.alignLeft" },
          { value: "center", labelKey: "content.blocks.props.alignCenter" },
          { value: "right", labelKey: "content.blocks.props.alignRight" },
        ],
      },
    ],
    defaults: (t) => ({
      heading: t("content.blocks.defaults.heroHeading"),
      subheading: "",
      image: "",
      ctaLabel: "",
      ctaHref: "",
      align: "center",
    }),
  },
  {
    type: "core/richtext",
    labelKey: "content.blocks.specs.richtext.label",
    descriptionKey: "content.blocks.specs.richtext.description",
    icon: "T",
    props: [{ key: "html", labelKey: "content.blocks.props.html", kind: "html" }],
    defaults: () => ({ html: "<p></p>" }),
  },
  {
    type: "core/features",
    labelKey: "content.blocks.specs.features.label",
    descriptionKey: "content.blocks.specs.features.description",
    icon: "F",
    props: [
      { key: "heading", labelKey: "content.blocks.props.heading", kind: "text" },
      {
        key: "items",
        labelKey: "content.blocks.props.items",
        kind: "items",
        itemLabelKey: "content.blocks.specs.features.itemLabel",
        itemFields: [
          { key: "title", labelKey: "content.blocks.props.title", kind: "text" },
          { key: "description", labelKey: "content.blocks.props.description", kind: "textarea" },
          { key: "icon", labelKey: "content.blocks.props.icon", kind: "text" },
        ],
      },
    ],
    defaults: (t) => ({
      heading: "",
      items: [{ title: t("content.blocks.defaults.featureTitle"), description: "", icon: "" }],
    }),
  },
  {
    type: "core/image",
    labelKey: "content.blocks.specs.image.label",
    descriptionKey: "content.blocks.specs.image.description",
    icon: "I",
    props: [
      {
        key: "src",
        labelKey: "content.blocks.props.src",
        kind: "url",
        placeholderKey: "content.blocks.placeholders.imageSrc",
      },
      { key: "alt", labelKey: "content.blocks.props.alt", kind: "text" },
      { key: "caption", labelKey: "content.blocks.props.caption", kind: "text" },
      {
        key: "width",
        labelKey: "content.blocks.props.width",
        kind: "select",
        options: [
          { value: "contained", labelKey: "content.blocks.props.widthContained" },
          { value: "wide", labelKey: "content.blocks.props.widthWide" },
          { value: "full", labelKey: "content.blocks.props.widthFull" },
        ],
      },
    ],
    defaults: () => ({ src: "", alt: "", caption: "", width: "contained" }),
  },
  {
    type: "core/cta",
    labelKey: "content.blocks.specs.cta.label",
    descriptionKey: "content.blocks.specs.cta.description",
    icon: "C",
    props: [
      { key: "heading", labelKey: "content.blocks.props.heading", kind: "text" },
      { key: "text", labelKey: "content.blocks.props.description", kind: "textarea" },
      { key: "buttonLabel", labelKey: "content.blocks.props.buttonLabel", kind: "text" },
      { key: "buttonHref", labelKey: "content.blocks.props.buttonHref", kind: "url" },
      { key: "inverted", labelKey: "content.blocks.props.inverted", kind: "boolean" },
    ],
    defaults: () => ({
      heading: "",
      text: "",
      buttonLabel: "",
      buttonHref: "",
      inverted: false,
    }),
  },
  {
    /**
     * The block whose props are a QUERY, not content. The editor describes what to
     * list; cms-api runs the query at render time and hands the theme the rows in
     * `props.items`.
     *
     * `items` is deliberately absent from `props` and from `defaults`. The server
     * overwrites it on every render, so anything the editor put there would be
     * thrown away — and a control that let an author *set* the rows a list returns
     * would be a way to put content on a page that the query never authorised.
     * The editor writes the question; only the server writes the answer.
     */
    type: "core/content-list",
    labelKey: "content.blocks.specs.contentList.label",
    descriptionKey: "content.blocks.specs.contentList.description",
    icon: "L",
    props: [
      {
        key: "contentType",
        labelKey: "content.blocks.props.contentType",
        kind: "contentType",
        hintKey: "content.blocks.hints.contentType",
      },
      {
        key: "limit",
        labelKey: "content.blocks.props.limit",
        kind: "number",
        min: 1,
        max: COLLECTION_MAX_LIMIT,
        hintKey: "content.blocks.hints.limit",
      },
      {
        key: "sort",
        labelKey: "content.blocks.props.sort",
        kind: "select",
        options: COLLECTION_SORTS.map((sort) => ({
          value: sort,
          labelKey: SORT_LABEL_KEYS[sort],
        })),
      },
      {
        key: "layout",
        labelKey: "content.blocks.props.layout",
        kind: "select",
        options: [
          { value: "list", labelKey: "content.blocks.props.layoutList" },
          { value: "grid", labelKey: "content.blocks.props.layoutGrid" },
        ],
      },
      {
        key: "heading",
        labelKey: "content.blocks.props.heading",
        kind: "text",
        placeholderKey: "content.blocks.placeholders.contentListHeading",
      },
    ],
    // No `contentType`: which types a site has is not knowable from a translator,
    // and a guessed "post" that the site does not define is exactly the silently
    // empty list this block is meant to avoid. The editor picks it, and until they
    // do the select says so.
    defaults: () => ({
      contentType: "",
      limit: 6,
      sort: "newest",
      layout: "list",
      heading: "",
    }),
  },
];

export function getBlockSpec(type: string): BlockSpec | undefined {
  return BLOCK_SPECS.find((spec) => spec.type === type);
}

export function isCoreBlockType(type: string): type is CoreBlockType {
  return (CORE_BLOCK_TYPES as readonly string[]).includes(type);
}

export function blockLabel(type: string, t: Translate): string {
  const spec = getBlockSpec(type);
  return spec ? t(spec.labelKey) : type;
}

/** Ids only have to be unique within the document; the API stores them verbatim. */
export function newBlockId(): string {
  return `blk_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
}

export function createBlock(type: CoreBlockType, t: Translate): Block {
  const spec = getBlockSpec(type);
  return {
    id: newBlockId(),
    type,
    props: spec ? spec.defaults(t) : {},
  };
}
