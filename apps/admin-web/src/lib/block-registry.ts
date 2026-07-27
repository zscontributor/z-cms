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
/**
 * `stringList` and `json` are not offered to core blocks; they exist for the two
 * ways a block reaches the editor without a hand-written spec:
 *   - `stringList` edits a bare array of strings (`["a","b"]`) — a theme's "list of
 *     paragraphs" prop. It stores strings, not `{ value }` records, so it never
 *     rewrites the shape the theme reads.
 *   - `json` is the last resort for a value the editor cannot otherwise shape (a
 *     nested object): an editable JSON box, still better than read-only text.
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
  | "items"
  | "stringList"
  | "json";

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
  {
    /**
     * Places a plugin-declared public form by id. The runtime's `core/form` block
     * renders it as an interactive island on every theme; the plugin owns the
     * fields, validation and handler. The author only names which form.
     */
    type: "core/form",
    labelKey: "content.blocks.specs.form.label",
    descriptionKey: "content.blocks.specs.form.description",
    icon: "F",
    props: [
      {
        key: "formId",
        labelKey: "content.blocks.props.formId",
        kind: "text",
        hintKey: "content.blocks.hints.formId",
        placeholderKey: "content.blocks.placeholders.formId",
      },
    ],
    defaults: () => ({ formId: "" }),
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

// ---------------------------------------------------------------------------
// Theme-provided block schemas
//
// A theme ships an editing schema for its own block types in its manifest (the
// `editorBlocks` map). The admin renders a form from it exactly as it does for a
// core block — so a `zsoft/hero` is edited with labelled fields, not a JSON dump —
// without any code change here. This mirrors the `settingsSchema` contract.
//
// The catch: a core BlockSpec carries i18n *keys* (shipped once, drawn in the
// admin's language), but a theme's schema carries *text* the theme author wrote,
// optionally per-locale. So a theme schema and a core spec are resolved through
// different paths into ONE shape — `ResolvedBlockSpec`, all strings, already in the
// reader's language — which is the only shape the form ever sees.
// ---------------------------------------------------------------------------

/** Text an admin reads: one string, or a locale → string map (`en` is the fallback). */
export type LocalizedText = string | Record<string, string>;

export interface ThemeBlockPropOption {
  value: string;
  label: LocalizedText;
}

export interface ThemeBlockItemField {
  key: string;
  label: LocalizedText;
  kind: "text" | "textarea" | "url" | "boolean" | "select";
  options?: ThemeBlockPropOption[];
}

export interface ThemeBlockProp {
  key: string;
  label: LocalizedText;
  kind: PropKind;
  placeholder?: LocalizedText;
  hint?: LocalizedText;
  options?: ThemeBlockPropOption[];
  min?: number;
  max?: number;
  itemFields?: ThemeBlockItemField[];
  itemLabel?: LocalizedText;
  /** For `stringList`: draw each entry as a textarea rather than an input. */
  multiline?: boolean;
  default?: unknown;
}

export interface ThemeBlockSchema {
  label: LocalizedText;
  description?: LocalizedText;
  icon?: string;
  props: ThemeBlockProp[];
}

// ---------------------------------------------------------------------------
// Resolved specs — the single shape the form consumes
// ---------------------------------------------------------------------------

export interface ResolvedPropOption {
  value: string;
  label: string;
}

export interface ResolvedItemField {
  key: string;
  label: string;
  kind: "text" | "textarea" | "url" | "boolean" | "select";
  options?: ResolvedPropOption[];
}

export interface ResolvedPropSpec {
  key: string;
  label: string;
  kind: PropKind;
  placeholder?: string;
  hint?: string;
  options?: ResolvedPropOption[];
  min?: number;
  max?: number;
  itemFields?: ResolvedItemField[];
  itemLabel?: string;
  multiline?: boolean;
}

export interface ResolvedBlockSpec {
  type: string;
  label: string;
  description: string;
  icon: string;
  /** A core block (`core/*`) vs a theme block — used only for menu grouping. */
  isCore: boolean;
  props: ResolvedPropSpec[];
  /** The props a freshly-inserted block of this type starts with. */
  defaultProps: Record<string, unknown>;
}

/**
 * The editor's whole vocabulary of blocks for one screen: the core blocks plus the
 * active theme's blocks, each resolved into the reader's language. `insertable` is
 * what the "Add block" menu offers; `get` is how a stored block finds its form.
 */
export interface BlockRegistry {
  insertable: ResolvedBlockSpec[];
  get(type: string): ResolvedBlockSpec | undefined;
}

/** Resolve `LocalizedText` (or a plain string) against the admin's locale. */
function pickLocalized(text: LocalizedText | undefined, locale: string): string | undefined {
  if (text === undefined || text === null) return undefined;
  if (typeof text === "string") return text;
  return text[locale] ?? text.en ?? Object.values(text)[0];
}

/** A core `BlockSpec` (i18n keys, defaults factory) → the resolved shape. */
function resolveCoreSpec(spec: BlockSpec, t: Translate): ResolvedBlockSpec {
  return {
    type: spec.type,
    label: t(spec.labelKey),
    description: t(spec.descriptionKey),
    icon: spec.icon,
    isCore: true,
    defaultProps: spec.defaults(t),
    props: spec.props.map((prop) => ({
      key: prop.key,
      label: t(prop.labelKey),
      kind: prop.kind,
      placeholder: prop.placeholderKey ? t(prop.placeholderKey) : undefined,
      hint: prop.hintKey
        ? t(prop.hintKey, { min: prop.min ?? 0, max: prop.max ?? 0 })
        : undefined,
      min: prop.min,
      max: prop.max,
      options: prop.options?.map((option) => ({
        value: option.value,
        label: t(option.labelKey),
      })),
      itemFields: prop.itemFields?.map((field) => ({
        key: field.key,
        label: t(field.labelKey),
        kind: field.kind,
      })),
      itemLabel: prop.itemLabelKey ? t(prop.itemLabelKey) : undefined,
    })),
  };
}

/** A default value for a prop the theme did not give one, appropriate to its kind. */
function emptyValueForKind(kind: PropKind): unknown {
  switch (kind) {
    case "boolean":
      return false;
    case "items":
    case "stringList":
      return [];
    case "number":
      return undefined;
    case "json":
      return {};
    default:
      return "";
  }
}

/** A theme's `ThemeBlockSchema` (author text, per-locale) → the resolved shape. */
function resolveThemeSpec(
  type: string,
  schema: ThemeBlockSchema,
  locale: string,
): ResolvedBlockSpec {
  const props: ResolvedPropSpec[] = (schema.props ?? []).map((prop) => ({
    key: prop.key,
    label: pickLocalized(prop.label, locale) ?? prop.key,
    kind: prop.kind,
    placeholder: pickLocalized(prop.placeholder, locale),
    hint: pickLocalized(prop.hint, locale),
    min: prop.min,
    max: prop.max,
    multiline: prop.multiline,
    options: prop.options?.map((option) => ({
      value: option.value,
      label: pickLocalized(option.label, locale) ?? option.value,
    })),
    itemFields: prop.itemFields?.map((field) => ({
      key: field.key,
      label: pickLocalized(field.label, locale) ?? field.key,
      kind: field.kind,
      options: field.options?.map((option) => ({
        value: option.value,
        label: pickLocalized(option.label, locale) ?? option.value,
      })),
    })),
    itemLabel: pickLocalized(prop.itemLabel, locale),
  }));

  const defaultProps: Record<string, unknown> = {};
  for (const prop of schema.props ?? []) {
    defaultProps[prop.key] =
      prop.default !== undefined ? prop.default : emptyValueForKind(prop.kind);
  }

  return {
    type,
    label: pickLocalized(schema.label, locale) ?? type,
    description: pickLocalized(schema.description, locale) ?? "",
    icon: schema.icon ?? type.split("/")[1]?.[0]?.toUpperCase() ?? "?",
    isCore: false,
    props,
    defaultProps,
  };
}

/**
 * Build the registry for a content-editing screen: the core blocks first, then the
 * active theme's blocks. A theme entry for a `core/*` type overrides the core spec
 * (a theme may relabel a core block), and is de-duplicated so the menu shows it once.
 */
export function buildBlockRegistry(
  t: Translate,
  locale: string,
  themeBlocks: Record<string, ThemeBlockSchema> | undefined,
): BlockRegistry {
  const byType = new Map<string, ResolvedBlockSpec>();
  for (const spec of BLOCK_SPECS) byType.set(spec.type, resolveCoreSpec(spec, t));
  for (const [type, schema] of Object.entries(themeBlocks ?? {})) {
    byType.set(type, resolveThemeSpec(type, schema, locale));
  }
  return {
    insertable: [...byType.values()],
    get: (type) => byType.get(type),
  };
}

/** A new block of a resolved type, its props seeded from the spec's defaults. */
export function createBlockFromSpec(spec: ResolvedBlockSpec): Block {
  return {
    id: newBlockId(),
    type: spec.type,
    props: structuredClone(spec.defaultProps),
  };
}

// ---------------------------------------------------------------------------
// Generic fallback — an editable form inferred from a block's own values
//
// When no spec exists for a stored block (a plugin block, or a theme block the
// theme forgot to declare), the editor still must not strand the author with a
// read-only JSON dump. It infers a control per prop from the value that is there:
// a string becomes text, a boolean a checkbox, an array of records a list, and so
// on. The labels are the prop keys, humanised. It is coarser than a real schema,
// but it edits, and it round-trips anything it cannot shape as raw JSON.
// ---------------------------------------------------------------------------

/** "titleTop" / "cta_href" → "Title top" / "Cta href". */
function humanizeKey(key: string): string {
  const spaced = key
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim();
  if (!spaced) return key;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Keys whose value is a link or an asset, so a media/URL control fits better. */
const URLISH_KEY = /(image|src|url|href|photo|cover|background|banner|logo)/i;

function inferPropSpec(key: string, value: unknown): ResolvedPropSpec {
  const label = humanizeKey(key);

  if (typeof value === "boolean") return { key, label, kind: "boolean" };
  if (typeof value === "number") return { key, label, kind: "number" };

  if (Array.isArray(value)) {
    if (value.length > 0 && value.every((entry) => typeof entry === "string")) {
      return { key, label, kind: "stringList", multiline: true };
    }
    if (
      value.length > 0 &&
      value.every((entry) => entry !== null && typeof entry === "object" && !Array.isArray(entry))
    ) {
      const fieldKeys = [
        ...new Set(value.flatMap((entry) => Object.keys(entry as Record<string, unknown>))),
      ];
      // A record field that is itself an object or array cannot be a flat item
      // field; when any entry has one, the whole list is safer edited as JSON.
      const flat = fieldKeys.every((fieldKey) =>
        value.every((entry) => {
          const cell = (entry as Record<string, unknown>)[fieldKey];
          return cell === undefined || cell === null || typeof cell !== "object";
        }),
      );
      if (flat) {
        return {
          key,
          label,
          kind: "items",
          itemFields: fieldKeys.map((fieldKey) => ({
            key: fieldKey,
            label: humanizeKey(fieldKey),
            kind: "text",
          })),
        };
      }
      return { key, label, kind: "json" };
    }
    // Empty or mixed array: a string list is the least-surprising editable default.
    return { key, label, kind: value.length === 0 ? "stringList" : "json" };
  }

  if (value !== null && typeof value === "object") return { key, label, kind: "json" };

  // string, or a missing value we treat as text
  if (key === "html") return { key, label, kind: "html" };
  if (URLISH_KEY.test(key)) return { key, label, kind: "url" };
  const text = typeof value === "string" ? value : "";
  if (text.includes("\n") || text.length > 80) return { key, label, kind: "textarea" };
  return { key, label, kind: "text" };
}

/**
 * A synthetic spec for a block the registry does not know, inferred from the props
 * it currently carries. Rendered by the same form as a real spec.
 */
export function inferBlockSpec(block: Block): ResolvedBlockSpec {
  const props = block.props ?? {};
  return {
    type: block.type,
    label: block.type,
    description: "",
    icon: block.type.split("/")[1]?.[0]?.toUpperCase() ?? "?",
    isCore: false,
    props: Object.entries(props).map(([key, value]) => inferPropSpec(key, value)),
    defaultProps: { ...props },
  };
}
