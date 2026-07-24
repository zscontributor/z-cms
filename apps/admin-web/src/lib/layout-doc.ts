import {
  bindingToCollectionQuery,
  collectDocumentCollections,
  defaultWidgetProps,
  getWidgetSpec,
  MAX_THEME_COLLECTIONS,
  type LayoutDocument,
  type LayoutNode,
  type LayoutNodeKind,
  type LayoutTemplateName,
} from "@zcmsorg/schemas";

/**
 * Tree surgery for the Theme Editor.
 *
 * Every function here is pure: tree in, new tree out, nothing mutated. The editor
 * holds the document in React state, and a mutation in place is a re-render that
 * does not happen — the classic way a drag lands, the data changes, and the canvas
 * does not.
 *
 * The containment rule (section>row>column>widget) is enforced by the schema on the
 * server, but it has to be enforced HERE too, at the moment of the drop: a UI that
 * lets somebody drag a widget onto a section and only says "no" when they hit Save
 * has already wasted their afternoon. `canContain` is the single answer both the
 * drop targets and the insert functions ask.
 */

const ALLOWED_CHILDREN: Record<LayoutNodeKind, readonly LayoutNodeKind[]> = {
  section: ["row"],
  row: ["column"],
  column: ["widget"],
  widget: [],
};

export function canContain(parent: LayoutNodeKind, child: LayoutNodeKind): boolean {
  return ALLOWED_CHILDREN[parent].includes(child);
}

/** Ids only have to be unique within the document; the API stores them verbatim. */
export function newNodeId(prefix = "n"): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
}

export function createWidget(type: string): LayoutNode {
  return { id: newNodeId("w"), kind: "widget", widgetType: type, props: defaultWidgetProps(type) };
}

export function createColumn(span = 12): LayoutNode {
  return { id: newNodeId("c"), kind: "column", props: { span }, children: [] };
}

export function createRow(): LayoutNode {
  return { id: newNodeId("r"), kind: "row", props: { gap: 24 }, children: [createColumn()] };
}

export function createSection(): LayoutNode {
  return {
    id: newNodeId("s"),
    kind: "section",
    props: { paddingY: 64, width: "contained" },
    children: [createRow()],
  };
}

export interface Located {
  node: LayoutNode;
  /** Null when the node is a root of the template. */
  parent: LayoutNode | null;
  index: number;
}

/** Depth-first search for a node, with its parent and position. */
export function locate(tree: LayoutNode[], id: string): Located | null {
  const walk = (nodes: LayoutNode[], parent: LayoutNode | null): Located | null => {
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i]!;
      if (node.id === id) return { node, parent, index: i };
      const found = walk(node.children ?? [], node);
      if (found) return found;
    }
    return null;
  };
  return walk(tree, null);
}

/** Replaces one node, rebuilding only the spine down to it. */
export function updateNode(
  tree: LayoutNode[],
  id: string,
  update: (node: LayoutNode) => LayoutNode,
): LayoutNode[] {
  return tree.map((node) => {
    if (node.id === id) return update(node);
    if (!node.children) return node;
    return { ...node, children: updateNode(node.children, id, update) };
  });
}

export function setProps(
  tree: LayoutNode[],
  id: string,
  props: Record<string, unknown>,
): LayoutNode[] {
  return updateNode(tree, id, (node) => ({ ...node, props }));
}

export function setBinding(
  tree: LayoutNode[],
  id: string,
  binding: LayoutNode["binding"],
): LayoutNode[] {
  return updateNode(tree, id, (node) => {
    if (!binding) {
      // Delete the key rather than set it undefined: the document is serialised to
      // JSON, and `{binding: undefined}` round-trips as an absent key anyway — but
      // only after a save. Removing it now keeps the in-memory tree equal to what
      // the server will store, which is what the "unsaved changes" check compares.
      const { binding: _drop, ...rest } = node;
      return rest;
    }
    return { ...node, binding };
  });
}

export function removeNode(tree: LayoutNode[], id: string): LayoutNode[] {
  return tree
    .filter((node) => node.id !== id)
    .map((node) => (node.children ? { ...node, children: removeNode(node.children, id) } : node));
}

/** Deep copy with fresh ids — a duplicate that shared ids would not be a duplicate. */
export function cloneWithNewIds(node: LayoutNode): LayoutNode {
  const prefix = node.kind === "widget" ? "w" : node.kind[0]!;
  return {
    ...node,
    id: newNodeId(prefix),
    ...(node.children ? { children: node.children.map(cloneWithNewIds) } : {}),
  };
}

export function duplicateNode(tree: LayoutNode[], id: string): LayoutNode[] {
  const found = locate(tree, id);
  if (!found) return tree;
  const copy = cloneWithNewIds(found.node);

  const insertAfter = (nodes: LayoutNode[]): LayoutNode[] => {
    const out: LayoutNode[] = [];
    for (const node of nodes) {
      out.push(node.children ? { ...node, children: insertAfter(node.children) } : node);
      if (node.id === id) out.push(copy);
    }
    return out;
  };
  return insertAfter(tree);
}

/**
 * Inserts `node` into `parentId` at `index`, refusing a drop the containment rule
 * forbids. Returns the tree unchanged on refusal, so a caller can compare by
 * identity to know whether the drop took.
 */
export function insertNode(
  tree: LayoutNode[],
  parentId: string,
  index: number,
  node: LayoutNode,
): LayoutNode[] {
  const parent = locate(tree, parentId);
  if (!parent || !canContain(parent.node.kind, node.kind)) return tree;

  return updateNode(tree, parentId, (target) => {
    const children = [...(target.children ?? [])];
    children.splice(Math.max(0, Math.min(index, children.length)), 0, node);
    return { ...target, children };
  });
}

/**
 * Moves a node to a new parent and index.
 *
 * Two refusals matter. A drop the containment rule forbids is one. The other is
 * dropping a node INTO ITSELF (or into its own descendant) — which the UI can
 * express, because a section's drop targets are still on screen while the section
 * is being dragged, and which would detach that whole subtree from the document
 * and leak it out of the tree entirely.
 */
export function moveNode(
  tree: LayoutNode[],
  id: string,
  targetParentId: string,
  index: number,
): LayoutNode[] {
  const found = locate(tree, id);
  if (!found) return tree;

  const target = locate(tree, targetParentId);
  if (!target || !canContain(target.node.kind, found.node.kind)) return tree;
  if (id === targetParentId) return tree;
  if (locate(found.node.children ?? [], targetParentId)) return tree;

  // Same parent: a splice, so the index the caller gave still means what they saw.
  if (found.parent?.id === targetParentId) {
    return updateNode(tree, targetParentId, (parent) => {
      const children = [...(parent.children ?? [])];
      const from = children.findIndex((c) => c.id === id);
      if (from === -1) return parent;
      const [item] = children.splice(from, 1);
      if (!item) return parent;
      // Removing first shifts everything after it left by one, so a move to a later
      // slot must account for the hole the node left behind.
      const to = from < index ? index - 1 : index;
      children.splice(Math.max(0, Math.min(to, children.length)), 0, item);
      return { ...parent, children };
    });
  }

  const detached = removeNode(tree, id);
  return insertNode(detached, targetParentId, index, found.node);
}

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

export interface CollectionBudget {
  used: number;
  max: number;
  /** True when the document already declares as many distinct queries as allowed. */
  full: boolean;
}

/**
 * How many of the eight collection queries this drawing has spent.
 *
 * cms-api caps a manifest at MAX_THEME_COLLECTIONS and silently DROPS the rest, so
 * a ninth list renders empty forever with nothing to say why. The API refuses the
 * save; this is what lets the editor grey the button out first.
 *
 * Counted on deduplicated QUERIES, not widgets: twenty lists all asking for "the
 * six newest posts" are one query and cost one slot.
 */
export function collectionBudget(doc: LayoutDocument): CollectionBudget {
  const used = Object.keys(collectDocumentCollections(doc)).length;
  return { used, max: MAX_THEME_COLLECTIONS, full: used >= MAX_THEME_COLLECTIONS };
}

/**
 * Whether adding this binding would need a NEW slot.
 *
 * A binding that matches a query already in the document is free — it shares the
 * slot. So the editor may allow a ninth list, as long as it is asking a question
 * one of the first eight already asked.
 */
export function bindingNeedsNewSlot(
  doc: LayoutDocument,
  binding: NonNullable<LayoutNode["binding"]>,
): boolean {
  if (binding.source !== "collection") return false;
  const existing = collectDocumentCollections(doc);
  const query = bindingToCollectionQuery(binding);
  const name = `${query.contentType}_${query.limit}_${query.sort}`.replace(/[^a-z0-9_]/gi, "_");
  return !(name in existing);
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export function templateTree(doc: LayoutDocument, template: LayoutTemplateName): LayoutNode[] {
  return doc.templates[template] ?? [];
}

export function withTemplate(
  doc: LayoutDocument,
  template: LayoutTemplateName,
  tree: LayoutNode[],
): LayoutDocument {
  return { ...doc, templates: { ...doc.templates, [template]: tree } };
}

/** A human label for a node, for the layer tree and the inspector's header. */
export function nodeLabel(node: LayoutNode): string {
  if (node.kind !== "widget") return node.kind;
  return node.widgetType ?? "widget";
}

/** The catalogue entry behind a widget node, if this build knows it. */
export function specFor(node: LayoutNode) {
  return node.kind === "widget" && node.widgetType ? getWidgetSpec(node.widgetType) : undefined;
}
