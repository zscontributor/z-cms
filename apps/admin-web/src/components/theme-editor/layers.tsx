"use client";

import { WIDGET_CATALOG, type LayoutNode } from "@zcmsorg/schemas";
import { Icon } from "@/components/shell/icon";
import { cn } from "@/lib/cn";
import { useT } from "@/lib/i18n-provider";

/**
 * The Layers panel — the document as an outline.
 *
 * The canvas shows what a drawing looks like; this shows what it *is*: the
 * section > row > column > widget tree, so a person can select a node buried under
 * others (a column behind a full-bleed hero) and reorder without hunting on the
 * canvas. It reads the same tree the canvas draws — no second source of truth — and
 * selection is shared state, so clicking a layer is clicking the node.
 */
export function Layers({
  tree,
  selectedId,
  onSelect,
  onMoveWithin,
  disabled,
}: {
  tree: LayoutNode[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onMoveWithin: (id: string, delta: number) => void;
  disabled?: boolean;
}) {
  const t = useT();

  if (tree.length === 0) {
    return <p className="px-1 py-3 text-xs text-neutral-500">{t("themeEditor.canvas.emptyTemplate")}</p>;
  }

  return (
    <div className="flex flex-col gap-0.5">
      {tree.map((node, index) => (
        <LayerRow
          key={node.id}
          node={node}
          depth={0}
          index={index}
          siblings={tree.length}
          selectedId={selectedId}
          onSelect={onSelect}
          onMoveWithin={onMoveWithin}
          disabled={disabled}
        />
      ))}
    </div>
  );
}

function nodeLabelText(node: LayoutNode, t: (k: string) => string): string {
  if (node.kind !== "widget") return t(`themeEditor.containers.${node.kind}`);
  const spec = WIDGET_CATALOG.find((s) => s.type === node.widgetType);
  return spec ? t(spec.labelKey) : (node.widgetType ?? "widget");
}

const KIND_ICON: Record<string, "grid" | "link" | "doc" | "image"> = {
  section: "grid",
  row: "link",
  column: "doc",
  widget: "image",
};

function LayerRow({
  node,
  depth,
  index,
  siblings,
  selectedId,
  onSelect,
  onMoveWithin,
  disabled,
}: {
  node: LayoutNode;
  depth: number;
  index: number;
  siblings: number;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onMoveWithin: (id: string, delta: number) => void;
  disabled?: boolean;
}) {
  const t = useT();
  const selected = selectedId === node.id;
  const children = node.children ?? [];

  return (
    <>
      <div
        className={cn(
          "group flex items-center gap-1.5 rounded px-2 py-1.5 text-xs",
          selected
            ? "bg-brand-500/15 text-brand-700 dark:text-brand-300"
            : "text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800",
        )}
        style={{ paddingLeft: `${8 + depth * 14}px` }}
      >
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
          onClick={() => onSelect(node.id)}
        >
          <Icon name={KIND_ICON[node.kind] ?? "doc"} size={12} />
          <span className="truncate">{nodeLabelText(node, t)}</span>
        </button>
        <span className="flex shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100">
          <button
            type="button"
            className="px-0.5 disabled:opacity-30"
            aria-label={t("themeEditor.a11y.moveUp", { label: nodeLabelText(node, t) })}
            disabled={disabled || index === 0}
            onClick={() => onMoveWithin(node.id, -1)}
          >
            ↑
          </button>
          <button
            type="button"
            className="px-0.5 disabled:opacity-30"
            aria-label={t("themeEditor.a11y.moveDown", { label: nodeLabelText(node, t) })}
            disabled={disabled || index >= siblings - 1}
            onClick={() => onMoveWithin(node.id, 1)}
          >
            ↓
          </button>
        </span>
      </div>
      {children.map((child, i) => (
        <LayerRow
          key={child.id}
          node={child}
          depth={depth + 1}
          index={i}
          siblings={children.length}
          selectedId={selectedId}
          onSelect={onSelect}
          onMoveWithin={onMoveWithin}
          disabled={disabled}
        />
      ))}
    </>
  );
}
