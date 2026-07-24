import { z } from "zod";

/**
 * The block document is the contract between the editor, the database and every
 * theme. A page is a list of blocks; a block is a `type` plus opaque `props`.
 *
 * Core deliberately does NOT validate `props` against a per-type schema here.
 * Block types are open — themes and (later) plugins register their own — so the
 * type registry lives at runtime, not in this file. What core guarantees is the
 * envelope: every block has a stable id, a namespaced type, and JSON props.
 * A renderer that meets an unknown type skips it rather than crashing the page.
 */

export const BlockTypeSchema = z
  .string()
  // "core/hero", "zsoft/contact-form" — namespace prevents a plugin from
  // shadowing a core block, and makes provenance obvious in stored JSON.
  .regex(/^[a-z0-9-]+\/[a-z0-9-]+$/, {
    message: 'Block type must look like "namespace/name", e.g. "core/hero".',
  });

export interface Block {
  id: string;
  type: string;
  props: Record<string, unknown>;
  children?: Block[];
}

export const BlockSchema: z.ZodType<Block> = z.lazy(() =>
  z.object({
    id: z.string().min(1),
    type: BlockTypeSchema,
    props: z.record(z.string(), z.unknown()).default({}),
    children: z.array(BlockSchema).optional(),
  }),
);

/**
 * The deepest a block tree may nest. Real pages are a handful of levels; a value
 * this high never constrains a human but sits far below the JS call stack.
 *
 * Without it, `BlockSchema` (a `z.lazy` self-reference) recurses as deep as the
 * input, so a few thousand levels of nested `children` overflow the stack with a
 * `RangeError` — and `safeParse` does NOT convert that into a validation failure,
 * it throws. A hostile CreateContent body could turn "validate this document"
 * into an uncaught exception. So depth is bounded BEFORE the recursive schema
 * ever descends.
 */
export const MAX_BLOCK_DEPTH = 32;

function exceedsMaxDepth(blocks: unknown): boolean {
  // Iterative, not recursive — measuring the depth must not itself overflow the
  // stack on the very input we are trying to reject.
  if (!Array.isArray(blocks)) return false;
  const stack: Array<{ node: unknown; depth: number }> = blocks.map((node) => ({
    node,
    depth: 1,
  }));
  while (stack.length > 0) {
    const { node, depth } = stack.pop()!;
    if (depth > MAX_BLOCK_DEPTH) return true;
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
 * The document as it enters the system. A cheap, non-recursive depth gate runs
 * first (over raw `unknown`, so it does not itself descend the tree), and only a
 * tree within the limit is handed to the full recursive `BlockSchema`. `.pipe`
 * short-circuits: if the gate rejects, the recursive validation never runs, so
 * an over-deep tree is a clean validation error rather than a stack overflow.
 */
export const BlockDocumentSchema = z
  .array(z.unknown())
  .refine((blocks) => !exceedsMaxDepth(blocks), {
    message: `Block tree is nested deeper than the ${MAX_BLOCK_DEPTH}-level limit.`,
  })
  .pipe(z.array(BlockSchema));
export type BlockDocument = z.infer<typeof BlockDocumentSchema>;

/** Block types core ships and every theme is expected to style. */
export const CORE_BLOCK_TYPES = [
  "core/hero",
  "core/richtext",
  "core/features",
  "core/image",
  "core/cta",
  "core/content-list",
] as const;

export type CoreBlockType = (typeof CORE_BLOCK_TYPES)[number];

/**
 * `core/content-list` — the one block whose props are a QUERY rather than content.
 *
 * Every other block carries what it renders. This one carries a description of what
 * to go and find: "the six most recent posts", "three products tagged bestseller".
 * cms-api runs the query while it builds the page and hands the theme the rows in
 * `props.items`; the theme renders them and never learns that a database exists.
 *
 * It is ONE block and not two (`post-list` + `product-grid`) because a grid of
 * products IS a list of content with a different content type and a different
 * layout. Two blocks would be the same code twice, and would ask an editor to choose
 * by name rather than by what they actually want on the page.
 *
 * The props an editor sets:
 *
 *   contentType  which type to list ("post", "product") — a key on THIS site
 *   limit        how many, capped by the server (see COLLECTION_MAX_LIMIT)
 *   sort         newest | oldest | title
 *   layout       list | grid — a hint to the theme, not a command
 *   heading      optional title above the list
 *
 * And the prop the SERVER sets, which an editor cannot:
 *
 *   items        ContentDto[] — the resolved rows
 *
 * `items` is overwritten on every render, so a stored `items` in the database (from
 * a hand-crafted API call, say) can never be served: whatever an author put there is
 * replaced by what the query actually returns. A block that could smuggle its own
 * "content" past the query would be a way to render another tenant's rows.
 */
export const CONTENT_LIST_BLOCK = "core/content-list";

/** How many rows one list may ask for, however large a number is in its props. */
export const COLLECTION_MAX_LIMIT = 24;

/** The orders a list may be asked for. Anything else falls back to "newest". */
export const COLLECTION_SORTS = ["newest", "oldest", "title"] as const;
export type CollectionSort = (typeof COLLECTION_SORTS)[number];

/**
 * A request for a list of content.
 *
 * The same shape whether it comes from a THEME (declared in its manifest, so the
 * theme can draw a front page out of real posts) or from an EDITOR (the props of a
 * `core/content-list` block). One shape means one resolver, which means one place
 * where the limit is capped and the tenant is scoped — and no second path that
 * forgot to.
 *
 * Deliberately not a query language. There is no `where`, no operators, no raw
 * filter: a theme downloaded from a marketplace is code written by a stranger, and
 * anything expressive enough to be useful to them is expressive enough to read rows
 * they were never meant to see. This asks for "the N most recent published items of
 * this type, in this language" — and a theme that needs more than that is asking
 * for a plugin, which has permissions and a sandbox.
 */
export interface CollectionQuery {
  /** A content type key on this site ("post", "product"). Unknown -> empty list. */
  contentType: string;
  /** Capped at COLLECTION_MAX_LIMIT by the server. */
  limit?: number;
  sort?: CollectionSort;
}

/** Clamps a limit from a manifest or a block's props into something sane. */
export function clampCollectionLimit(limit: unknown): number {
  const n = Math.floor(Number(limit));
  if (!Number.isFinite(n) || n < 1) return 6;
  return Math.min(n, COLLECTION_MAX_LIMIT);
}

/** Anything that is not a sort we implement is "newest". */
export function normaliseCollectionSort(sort: unknown): CollectionSort {
  return COLLECTION_SORTS.includes(sort as CollectionSort)
    ? (sort as CollectionSort)
    : "newest";
}
