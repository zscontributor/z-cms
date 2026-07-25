"use client";

import { useDraggable, useDroppable } from "@dnd-kit/core";
import { createContext, useContext, useState } from "react";
import type { LayoutNode } from "@zcmsorg/schemas";
import { WIDGET_COMPONENTS } from "@zcmsorg/theme-widgets";
import type { ThemeContext } from "@zcmsorg/theme-sdk";
import { Icon } from "@/components/shell/icon";
import { cn } from "@/lib/cn";
import { useT } from "@/lib/i18n-provider";
import { specFor } from "@/lib/layout-doc";

/**
 * Which block the pointer is actually over — the innermost one, not every
 * ancestor that happens to contain it.
 *
 * The old chrome leaned on Tailwind's `group-hover`, and `group-hover` fires for
 * EVERY ancestor marked `group`. Because sections wrap rows wrap columns wrap
 * widgets — each its own `group` — hovering one widget lit up the toolbars of the
 * section, the row and the column all at once. A person aiming at a button ended
 * up looking at four.
 *
 * So hover is JS state now, set through `onMouseOver` with `stopPropagation`:
 * `mouseover` bubbles, so the innermost block under the pointer claims the hover
 * and stops the event before any ancestor can overwrite it. Moving out to a
 * parent's own area re-fires on the parent and corrects itself; leaving the canvas
 * clears it.
 */
const HoverContext = createContext<{
  hoveredId: string | null;
  setHoveredId: (id: string | null) => void;
}>({ hoveredId: null, setHoveredId: () => {} });

/**
 * The canvas.
 *
 * It draws the REAL widget components — the same ones the generated theme bundles
 * — wrapped in selection and drag chrome. That is the point of a shared widget
 * library: a preview built from separate "editor versions" of each widget is a
 * second implementation, and a second implementation is a promise the theme will
 * break at some point that nobody notices until it ships.
 *
 * The chrome is deliberately outside the widget: an outline and a drag handle are
 * the editor's, and a widget that knew it was being edited would carry editor code
 * into a signed package.
 */

export interface CanvasProps {
  tree: LayoutNode[];
  ctx: ThemeContext;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** Structural buttons — the keyboard-reachable twin of every drag. */
  onAddSection: () => void;
  onAddRow: (sectionId: string) => void;
  onAddColumn: (rowId: string) => void;
  onMoveWithin: (id: string, delta: number) => void;
  /** Copy a block, its children and all, in place beside itself. */
  onDuplicate: (id: string) => void;
  /** Remove a block and everything inside it. */
  onDelete: (id: string) => void;
  disabled?: boolean;
}

export function Canvas({
  tree,
  ctx,
  selectedId,
  onSelect,
  onAddSection,
  onAddRow,
  onAddColumn,
  onMoveWithin,
  onDuplicate,
  onDelete,
  disabled,
}: CanvasProps) {
  const t = useT();
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  return (
    <HoverContext.Provider value={{ hoveredId, setHoveredId }}>
    <div
      className="min-h-full bg-white p-4 dark:bg-neutral-950"
      // Clicking the backdrop deselects, which is how the inspector gets back to
      // the theme's own tokens without a "Theme settings" button competing for space.
      onClick={() => onSelect(null)}
      // The pointer has left every block; nothing is hovered. Without this the last
      // block's toolbar would hang around after the mouse moved off the canvas.
      onMouseLeave={() => setHoveredId(null)}
    >
      {tree.length === 0 ? (
        <p className="rounded border border-dashed border-neutral-300 p-8 text-center text-sm text-neutral-500 dark:border-neutral-700">
          {t("themeEditor.canvas.emptyTemplate")}
        </p>
      ) : (
        tree.map((node, index) => (
          <NodeView
            key={node.id}
            node={node}
            index={index}
            siblings={tree.length}
            ctx={ctx}
            selectedId={selectedId}
            onSelect={onSelect}
            onAddRow={onAddRow}
            onAddColumn={onAddColumn}
            onMoveWithin={onMoveWithin}
            onDuplicate={onDuplicate}
            onDelete={onDelete}
            disabled={disabled}
          />
        ))
      )}

      <button
        type="button"
        className="mt-4 w-full rounded border border-dashed border-neutral-300 py-3 text-sm text-neutral-600 hover:border-brand-500 hover:text-brand-600 dark:border-neutral-700 dark:text-neutral-400"
        disabled={disabled}
        onClick={(e) => {
          e.stopPropagation();
          onAddSection();
        }}
      >
        + {t("themeEditor.actions.addSection")}
      </button>
    </div>
    </HoverContext.Provider>
  );
}

interface NodeViewProps {
  node: LayoutNode;
  index: number;
  siblings: number;
  ctx: ThemeContext;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onAddRow: (sectionId: string) => void;
  onAddColumn: (rowId: string) => void;
  onMoveWithin: (id: string, delta: number) => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
  disabled?: boolean;
}

function NodeView(props: NodeViewProps) {
  const { node } = props;
  if (node.kind === "section") return <SectionView {...props} />;
  if (node.kind === "row") return <RowView {...props} />;
  if (node.kind === "column") return <ColumnView {...props} />;
  return <WidgetView {...props} />;
}

/** The shared chrome: an outline, a label, and the block's own controls. */
function Chrome({
  node,
  selected,
  onSelect,
  label,
  index,
  siblings,
  onMoveWithin,
  onDuplicate,
  onDelete,
  disabled,
  children,
  className,
  handleProps,
}: {
  node: LayoutNode;
  selected: boolean;
  onSelect: (id: string | null) => void;
  label: string;
  index: number;
  siblings: number;
  onMoveWithin: (id: string, delta: number) => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
  disabled?: boolean;
  children: React.ReactNode;
  className?: string;
  handleProps?: Record<string, unknown>;
}) {
  const t = useT();
  const { hoveredId, setHoveredId } = useContext(HoverContext);
  // The toolbar shows for the one block the pointer is actually over, or the one
  // that is selected — never for the ancestors that merely contain it.
  const hovered = hoveredId === node.id;
  const show = hovered || selected;
  return (
    <div
      className={cn(
        "relative rounded border transition-colors",
        selected
          ? "border-brand-500 ring-1 ring-brand-500"
          : hovered
            ? "border-neutral-300 dark:border-neutral-700"
            : "border-transparent",
        className,
      )}
      onClick={(e) => {
        e.stopPropagation();
        onSelect(node.id);
      }}
      // `mouseover` bubbles, so the innermost block wins and stopPropagation keeps
      // the event from reaching any ancestor Chrome. That is the whole fix for the
      // "every parent's toolbar lit up at once" behaviour.
      onMouseOver={(e) => {
        e.stopPropagation();
        setHoveredId(node.id);
      }}
    >
      <div
        className={cn(
          "absolute -top-2.5 left-2 z-10 flex items-center gap-0.5 rounded bg-neutral-800 px-1 py-0.5 text-[10px] text-white transition-opacity",
          show ? "opacity-100" : "pointer-events-none opacity-0",
        )}
      >
        {/* The drag handle is a button, so it is reachable by Tab and operable by
            keyboard through dnd-kit's KeyboardSensor. Reorder arrows sit beside it
            for the same reason the block editor has them: dragging is not the only
            way people move things. */}
        <button
          type="button"
          className="cursor-grab px-1"
          aria-label={t("themeEditor.a11y.drag", { label })}
          disabled={disabled}
          {...(handleProps ?? {})}
        >
          ⠿
        </button>
        <span className="px-1">{label}</span>
        <button
          type="button"
          className="px-1 disabled:opacity-30"
          aria-label={t("themeEditor.a11y.moveUp", { label })}
          disabled={disabled || index === 0}
          onClick={(e) => {
            e.stopPropagation();
            onMoveWithin(node.id, -1);
          }}
        >
          ↑
        </button>
        <button
          type="button"
          className="px-1 disabled:opacity-30"
          aria-label={t("themeEditor.a11y.moveDown", { label })}
          disabled={disabled || index >= siblings - 1}
          onClick={(e) => {
            e.stopPropagation();
            onMoveWithin(node.id, 1);
          }}
        >
          ↓
        </button>
        {/* Duplicate and delete are on the block itself now, not only in the
            inspector: the block a person wants to copy or remove is the one their
            pointer is already on, and reaching for a side panel to act on it is a
            trip the toolbar can save. */}
        <button
          type="button"
          className="flex items-center px-1 hover:text-brand-300"
          aria-label={t("themeEditor.a11y.duplicate", { label })}
          disabled={disabled}
          onClick={(e) => {
            e.stopPropagation();
            onDuplicate(node.id);
          }}
        >
          <Icon name="copy" size={12} />
        </button>
        <button
          type="button"
          className="flex items-center px-1 hover:text-red-300"
          aria-label={t("themeEditor.a11y.delete", { label })}
          disabled={disabled}
          onClick={(e) => {
            e.stopPropagation();
            onDelete(node.id);
          }}
        >
          <Icon name="trash" size={12} />
        </button>
      </div>
      {children}
    </div>
  );
}

function SectionView(props: NodeViewProps) {
  const t = useT();
  const { node, ctx, selectedId, onSelect, onAddRow, disabled } = props;
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: node.id,
    data: { kind: "section" },
    disabled,
  });

  return (
    <div ref={setNodeRef} className={cn("mb-3", isDragging && "opacity-40")}>
      <Chrome
        {...props}
        selected={selectedId === node.id}
        label={t("themeEditor.containers.section")}
        className="p-3"
        handleProps={{ ...attributes, ...listeners }}
      >
        {(node.children ?? []).map((child, i) => (
          <NodeView
            {...props}
            key={child.id}
            node={child}
            index={i}
            siblings={node.children?.length ?? 0}
          />
        ))}
        <button
          type="button"
          className="mt-2 w-full rounded border border-dashed border-neutral-300 py-1.5 text-xs text-neutral-500 hover:border-brand-500 dark:border-neutral-700"
          disabled={disabled}
          onClick={(e) => {
            e.stopPropagation();
            onAddRow(node.id);
          }}
        >
          + {t("themeEditor.actions.addRow")}
        </button>
      </Chrome>
    </div>
  );
}

function RowView(props: NodeViewProps) {
  const t = useT();
  const { node, selectedId, onAddColumn, disabled } = props;
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: node.id,
    data: { kind: "row" },
    disabled,
  });

  return (
    <div ref={setNodeRef} className={cn("mb-2", isDragging && "opacity-40")}>
      <Chrome
        {...props}
        selected={selectedId === node.id}
        label={t("themeEditor.containers.row")}
        className="p-2"
        handleProps={{ ...attributes, ...listeners }}
      >
        <div className="flex flex-wrap gap-2">
          {(node.children ?? []).map((child, i) => (
            <NodeView
              {...props}
              key={child.id}
              node={child}
              index={i}
              siblings={node.children?.length ?? 0}
            />
          ))}
        </div>
        <button
          type="button"
          className="mt-2 w-full rounded border border-dashed border-neutral-300 py-1 text-xs text-neutral-500 hover:border-brand-500 dark:border-neutral-700"
          disabled={disabled}
          onClick={(e) => {
            e.stopPropagation();
            onAddColumn(node.id);
          }}
        >
          + {t("themeEditor.actions.addColumn")}
        </button>
      </Chrome>
    </div>
  );
}

/**
 * A column is the only droppable for a widget — the containment rule again, this
 * time as a fact about where dnd-kit will let a drag land.
 */
function ColumnView(props: NodeViewProps) {
  const t = useT();
  const { node, selectedId, disabled } = props;
  const span = Math.min(12, Math.max(1, Number(node.props.span) || 12));
  const { setNodeRef, isOver } = useDroppable({ id: node.id, data: { kind: "column" }, disabled });

  return (
    <div style={{ flexBasis: `calc(${(span / 12) * 100}% - 0.5rem)` }} className="min-w-0 flex-grow">
      <Chrome
        {...props}
        selected={selectedId === node.id}
        label={`${t("themeEditor.containers.column")} ${span}/12`}
      >
        <div
          ref={setNodeRef}
          className={cn(
            "min-h-[3rem] rounded p-2 transition-colors",
            // The drop target, loud on purpose: a filled tint plus a solid ring, so
            // the column a release would land in is unmistakable among its siblings.
            isOver
              ? "bg-brand-100/70 outline outline-2 outline-brand-500 dark:bg-brand-900/40"
              : "",
            (node.children?.length ?? 0) === 0 &&
              !isOver &&
              "border border-dashed border-neutral-300 dark:border-neutral-700",
          )}
        >
          {(node.children ?? []).length === 0 ? (
            <p
              className={cn(
                "py-2 text-center text-[11px]",
                isOver ? "font-medium text-brand-600 dark:text-brand-300" : "text-neutral-400",
              )}
            >
              {t("themeEditor.canvas.dropHere")}
            </p>
          ) : (
            <>
              {(node.children ?? []).map((child, i) => (
                <NodeView
                  {...props}
                  key={child.id}
                  node={child}
                  index={i}
                  siblings={node.children?.length ?? 0}
                />
              ))}
              {/* The insertion line: a widget dropped here appends to the column, so
                  the marker sits after the last child — showing WHERE, not just
                  which column. */}
              {isOver ? (
                <div className="mt-1.5 h-1 rounded-full bg-brand-500" aria-hidden />
              ) : null}
            </>
          )}
        </div>
      </Chrome>
    </div>
  );
}

function WidgetView(props: NodeViewProps) {
  const t = useT();
  const { node, ctx, selectedId, disabled } = props;
  const spec = specFor(node);
  const Widget = node.widgetType ? WIDGET_COMPONENTS[node.widgetType] : undefined;
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: node.id,
    data: { kind: "widget" },
    disabled,
  });

  const label = spec ? t(spec.labelKey) : (node.widgetType ?? "widget");

  return (
    <div ref={setNodeRef} className={cn("mb-2", isDragging && "opacity-40")}>
      <Chrome
        {...props}
        selected={selectedId === node.id}
        label={label}
        className="p-2"
        handleProps={{ ...attributes, ...listeners }}
      >
        {Widget ? (
          // `pointer-events-none`: the preview is a picture. A real <a> inside the
          // canvas would swallow the click that selects the widget and navigate the
          // admin away from the editor.
          <div className="pointer-events-none">
            <Widget node={node} ctx={ctx} content={null} />
          </div>
        ) : (
          <p className="rounded bg-amber-50 p-2 text-xs text-amber-700 dark:bg-amber-950/40">
            {t("themeEditor.canvas.unknownWidget", { type: node.widgetType ?? "" })}
          </p>
        )}
      </Chrome>
    </div>
  );
}
