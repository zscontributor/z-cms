import { z } from "zod";
import {
  COLLECTION_MAX_LIMIT,
  COLLECTION_SORTS,
  clampCollectionLimit,
  normaliseCollectionSort,
  type CollectionQuery,
} from "./blocks";

/**
 * The LayoutDocument is the contract between the GUI Theme Editor, the database,
 * and the code generator that turns a drawing into a real theme package.
 *
 * A hand-written theme is React: a person writes JSX and core cannot know what it
 * will do until it runs, which is exactly why a theme must be signed against a
 * pinned key before the runtime will import it. A theme DRAWN in the editor is the
 * opposite: it is DATA. The editor produces this document — a tree of sections,
 * rows, columns and widgets — and one shared, already-reviewed widget library
 * renders it. The generated theme is a thin wrapper that hands this document to
 * that library; the only thing that varies between two drawn themes is the JSON.
 *
 * That is the whole security argument for letting non-programmers publish themes:
 * the executable surface is a library reviewed once, and everything a stranger
 * authored is data that a validator (this file) can bound. So this schema is not a
 * convenience — it is the fence. Anything it fails to constrain is something the
 * code generator would emit verbatim into a package the platform then signs.
 */

// ---------------------------------------------------------------------------
// Templates a drawn theme may author.
//
// A theme SDK knows seven template slots (home, page, post, archive, search,
// notFound, error). The editor only lets a person draw the four that are a
// straightforward arrangement of a page's own content and the site's lists. The
// other three are behavioural — a 404, a runtime error, a search-results page
// have rules a drag surface should not pretend to own — so a generated theme
// inherits the runtime's fallbacks for them rather than shipping an empty canvas.
// ---------------------------------------------------------------------------

export const LAYOUT_TEMPLATES = ["home", "page", "post", "archive"] as const;
export type LayoutTemplateName = (typeof LAYOUT_TEMPLATES)[number];

/**
 * The four kinds of node, and the one rule that makes the tree a layout rather
 * than a soup: each kind may only contain the kind below it.
 *
 *   section  a full-width horizontal band        -> contains rows
 *   row      a horizontal group inside a section  -> contains columns
 *   column   a vertical cell inside a row         -> contains widgets
 *   widget   a leaf that draws something          -> contains nothing
 *
 * This mirrors what Elementor calls Section > Column > Widget, with an explicit
 * Row so a section can stack several independent grids. The containment rule is
 * enforced below (see `violatesContainment`); without it, a "column inside a
 * widget" would be a shape the widget library has no meaning for, and the code
 * generator would emit it anyway.
 */
export const LAYOUT_NODE_KINDS = ["section", "row", "column", "widget"] as const;
export type LayoutNodeKind = (typeof LAYOUT_NODE_KINDS)[number];

/** Which kind each kind is allowed to contain. A widget contains nothing. */
const ALLOWED_CHILDREN: Record<LayoutNodeKind, readonly LayoutNodeKind[]> = {
  section: ["row"],
  row: ["column"],
  column: ["widget"],
  widget: [],
};

// ---------------------------------------------------------------------------
// Data binding.
//
// A widget either carries what it shows (a heading's text, an image's URL) or it
// BINDS to something the server knows. There are exactly two things a drawn theme
// may bind to, and both are deliberately narrow:
//
//   collection  a list of published content of one type ("the six newest posts").
//               Resolves through the same CollectionQuery a hand-written theme
//               declares in its manifest — no `where`, no operators, capped limit.
//               A collection-bound widget contributes one entry to the generated
//               theme's `manifest.collections`, which cms-api runs while it builds
//               the page (see RenderService.declaredCollections).
//
//   current     a field of the page being viewed — its title, its excerpt, its
//               block document. This is how a "post" template draws the actual
//               post: not by querying, but by reading what the runtime already
//               resolved into `ctx` and `content`.
//
// There is no third option on purpose. Anything more expressive than "a capped
// list of one type" or "a field of the current page" is a query language, and a
// query language in the hands of a stranger's theme is a way to read rows they
// were never meant to see. A theme that needs more is asking for a plugin.
// ---------------------------------------------------------------------------

export const CURRENT_BINDING_FIELDS = [
  "title",
  "excerpt",
  "blocks",
  "publishedAt",
  "coverImage",
] as const;
export type CurrentBindingField = (typeof CURRENT_BINDING_FIELDS)[number];

export const CollectionBindingSchema = z.object({
  source: z.literal("collection"),
  /** A content type key on the target site ("post", "product"). */
  contentType: z.string().trim().min(1),
  limit: z.number().int().min(1).max(COLLECTION_MAX_LIMIT).optional(),
  sort: z.enum(COLLECTION_SORTS).optional(),
});

export const CurrentBindingSchema = z.object({
  source: z.literal("current"),
  field: z.enum(CURRENT_BINDING_FIELDS),
});

export const WidgetBindingSchema = z.discriminatedUnion("source", [
  CollectionBindingSchema,
  CurrentBindingSchema,
]);
export type WidgetBinding = z.infer<typeof WidgetBindingSchema>;

/** Turns a stored collection binding into the CollectionQuery cms-api runs. */
export function bindingToCollectionQuery(
  binding: z.infer<typeof CollectionBindingSchema>,
): CollectionQuery {
  return {
    contentType: binding.contentType,
    limit: clampCollectionLimit(binding.limit),
    sort: normaliseCollectionSort(binding.sort),
  };
}

// ---------------------------------------------------------------------------
// The node tree.
//
// Deliberately shaped like BlockSchema: a `z.lazy` self-reference guarded by an
// iterative depth check that runs over raw `unknown` BEFORE the recursive schema
// descends. A hostile document with a few thousand levels of nesting would
// otherwise overflow the stack inside `safeParse` — which throws rather than
// returning a validation error — turning "validate this drawing" into an uncaught
// crash. Depth is bounded first; only a tree within the limit is parsed.
// ---------------------------------------------------------------------------

export interface LayoutNode {
  id: string;
  kind: LayoutNodeKind;
  /** Set only when `kind === "widget"`: which widget in WIDGET_CATALOG. */
  widgetType?: string;
  /** Opaque per-widget/per-container settings. Validated by the widget library. */
  props: Record<string, unknown>;
  /** Present only on a widget that binds to server data. */
  binding?: WidgetBinding;
  children?: LayoutNode[];
}

export const LayoutNodeSchema: z.ZodType<LayoutNode> = z.lazy(() =>
  z.object({
    id: z.string().min(1),
    kind: z.enum(LAYOUT_NODE_KINDS),
    widgetType: WidgetTypeSchema.optional(),
    props: z.record(z.string(), z.unknown()).default({}),
    binding: WidgetBindingSchema.optional(),
    children: z.array(LayoutNodeSchema).optional(),
  }),
);

/** Widget types look like block types: "namespace/name", e.g. "layout/heading". */
export const WidgetTypeSchema = z.string().regex(/^[a-z0-9-]+\/[a-z0-9-]+$/, {
  message: 'Widget type must look like "namespace/name", e.g. "layout/heading".',
});

/** Four kinds is deep; a real page is section>row>column>widget = 4. This is slack. */
export const MAX_LAYOUT_DEPTH = 16;

function exceedsMaxDepth(nodes: unknown): boolean {
  // Iterative on purpose: measuring depth must not overflow the stack on the very
  // input we are trying to reject.
  if (!Array.isArray(nodes)) return false;
  const stack: Array<{ node: unknown; depth: number }> = nodes.map((node) => ({
    node,
    depth: 1,
  }));
  while (stack.length > 0) {
    const { node, depth } = stack.pop()!;
    if (depth > MAX_LAYOUT_DEPTH) return true;
    if (node && typeof node === "object") {
      const children = (node as { children?: unknown }).children;
      if (Array.isArray(children)) {
        for (const child of children) stack.push({ node: child, depth: depth + 1 });
      }
    }
  }
  return false;
}

/**
 * The containment rule (section>row>column>widget), and the two invariants a
 * widget must hold: it names a widget type, and it has no children. Checked
 * iteratively over the already-parsed tree, so it never recurses.
 *
 * Returns the first violation as a message, or null when the tree is well-formed.
 * A well-formed tree is what the widget library and the code generator both assume
 * without re-checking — this is the one place that assumption is earned.
 */
function findContainmentViolation(roots: LayoutNode[]): string | null {
  const stack: LayoutNode[] = [...roots];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.kind === "widget") {
      if (!node.widgetType) return `A widget node (${node.id}) has no widgetType.`;
      if (node.children && node.children.length > 0) {
        return `A widget node (${node.id}) may not contain children.`;
      }
      continue;
    }
    if (node.widgetType) {
      return `A ${node.kind} node (${node.id}) must not carry a widgetType.`;
    }
    const allowed = ALLOWED_CHILDREN[node.kind];
    for (const child of node.children ?? []) {
      if (!allowed.includes(child.kind)) {
        return `A ${node.kind} node (${node.id}) may not contain a ${child.kind}.`;
      }
      stack.push(child);
    }
  }
  return null;
}

/**
 * A template's root: an ordered list of sections (or, for `post`/`page`, whatever
 * the author arranged — the containment rule still applies from whatever the top
 * level is). The depth gate short-circuits via `.pipe`, so an over-deep tree is a
 * clean validation error rather than a stack overflow, and the containment rule
 * runs only on a tree shallow enough to have survived it.
 */
export const LayoutTreeSchema = z
  .array(z.unknown())
  .refine((nodes) => !exceedsMaxDepth(nodes), {
    message: `Layout tree is nested deeper than the ${MAX_LAYOUT_DEPTH}-level limit.`,
  })
  .pipe(z.array(LayoutNodeSchema))
  .refine((nodes) => findContainmentViolation(nodes) === null, {
    message: "Layout tree breaks the section>row>column>widget containment rule.",
  });

// ---------------------------------------------------------------------------
// Design tokens.
//
// The knobs a whole theme shares — its palette, its type, its rhythm. They map
// one-to-one onto the generated theme's `settingsSchema`, which is what lets a
// site owner re-colour a drawn theme from the admin without the theme being
// rebuilt. Kept small and closed: a token the widget library does not consume is
// a token that does nothing, and the editor should not offer it.
// ---------------------------------------------------------------------------

export const LayoutTokensSchema = z
  .object({
    colorPrimary: z.string().optional(),
    colorText: z.string().optional(),
    colorBackground: z.string().optional(),
    fontHeading: z.string().optional(),
    fontBody: z.string().optional(),
    radius: z.number().min(0).max(64).optional(),
    maxWidth: z.number().int().min(320).max(2560).optional(),
  })
  .strict();
export type LayoutTokens = z.infer<typeof LayoutTokensSchema>;

// ---------------------------------------------------------------------------
// The document.
// ---------------------------------------------------------------------------

/**
 * The current on-disk shape version. Bumped when the node model changes in a way a
 * stored document would not survive; the editor migrates forward on load. Present
 * so a document drawn today is still openable after the model grows.
 */
export const LAYOUT_DOCUMENT_VERSION = 1 as const;

export const LayoutDocumentSchema = z.object({
  version: z.literal(LAYOUT_DOCUMENT_VERSION),
  tokens: LayoutTokensSchema.default({}),
  /**
   * One tree per template. `page` is required — it is the fallback every other
   * template degrades to, exactly as in a hand-written theme — and the rest are
   * optional. A template a person never drew simply falls back to `page`.
   */
  templates: z
    .object({
      home: LayoutTreeSchema.optional(),
      page: LayoutTreeSchema,
      post: LayoutTreeSchema.optional(),
      archive: LayoutTreeSchema.optional(),
    })
    .strict(),
});
export type LayoutDocument = z.infer<typeof LayoutDocumentSchema>;

// ---------------------------------------------------------------------------
// Collections a document declares.
//
// The bridge from "widgets the author dropped" to "what cms-api must fetch". Every
// collection-bound widget across every template becomes one named CollectionQuery
// in the generated `manifest.collections`. cms-api caps a manifest at
// MAX_THEME_COLLECTIONS (8) and silently drops the rest, so the editor must refuse
// the ninth — but this function is the single source of truth for the count, used
// by both the editor (to warn) and the code generator (to emit).
//
// Two widgets that bind to the SAME (contentType, limit, sort) share one query and
// one name: asking twice for "the six newest posts" is one fetch, and the widget
// library reads both from `ctx.collections[name]`.
// ---------------------------------------------------------------------------

/** How many named collections a generated theme's manifest may declare. */
export const MAX_THEME_COLLECTIONS = 8;

/** A deterministic name for a query, so the same query always maps to the same key. */
export function collectionNameFor(query: CollectionQuery): string {
  const limit = clampCollectionLimit(query.limit);
  const sort = normaliseCollectionSort(query.sort);
  // Human-legible and stable: "post_6_newest". The code generator embeds this both
  // in the manifest and in the widget's props, so it must be pure of the query.
  return `${query.contentType}_${limit}_${sort}`.replace(/[^a-z0-9_]/gi, "_");
}

/**
 * Walks a document and returns the deduplicated collection queries it declares,
 * keyed by their deterministic name. Order is stable (first appearance wins) so a
 * re-run over an unchanged document yields byte-identical output — the code
 * generator depends on that for reproducible builds.
 */
export function collectDocumentCollections(
  doc: LayoutDocument,
): Record<string, CollectionQuery> {
  const out: Record<string, CollectionQuery> = {};
  const trees = [
    doc.templates.home,
    doc.templates.page,
    doc.templates.post,
    doc.templates.archive,
  ].filter((t): t is LayoutNode[] => Array.isArray(t));

  for (const tree of trees) {
    const stack: LayoutNode[] = [...tree];
    // Reverse so a pre-order (top-to-bottom) first-appearance wins despite the LIFO.
    stack.reverse();
    while (stack.length > 0) {
      const node = stack.shift()!;
      if (
        node.kind === "widget" &&
        node.binding &&
        node.binding.source === "collection"
      ) {
        const query = bindingToCollectionQuery(node.binding);
        const name = collectionNameFor(query);
        if (!(name in out)) out[name] = query;
      }
      for (const child of node.children ?? []) stack.push(child);
    }
  }
  return out;
}

/** True when a document declares more distinct collections than a manifest allows. */
export function exceedsCollectionBudget(doc: LayoutDocument): boolean {
  return Object.keys(collectDocumentCollections(doc)).length > MAX_THEME_COLLECTIONS;
}
