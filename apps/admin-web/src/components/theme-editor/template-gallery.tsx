"use client";

import { useDraggable } from "@dnd-kit/core";
import type { LayoutNode } from "@zcmsorg/schemas";
import { LAYOUT_PATTERNS, type LayoutPattern } from "@/lib/layout-templates";
import { cn } from "@/lib/cn";
import { useT } from "@/lib/i18n-provider";

/**
 * Starter section patterns — drag one onto the canvas to drop it at a chosen spot,
 * or click to append it. Each card calls a factory that mints a fresh `LayoutNode[]`,
 * so inserting the same pattern twice yields two independent sections. It is a
 * shortcut for dragging the widgets in by hand — the result is ordinary nodes the
 * author then edits.
 */
export function TemplateGallery({
  onInsert,
  disabled,
}: {
  /** Click-to-append: the keyboard path, since dragging is not the only way. */
  onInsert: (nodes: LayoutNode[]) => void;
  disabled?: boolean;
}) {
  const t = useT();

  return (
    <div className="flex flex-col gap-2 p-2">
      <p className="px-1 pb-1 text-[11px] text-neutral-500 dark:text-neutral-400">{t("themeEditor.patterns.hint")}</p>
      {LAYOUT_PATTERNS.map((pattern) => (
        <PatternCard key={pattern.key} pattern={pattern} onInsert={onInsert} disabled={disabled} />
      ))}
    </div>
  );
}

function PatternCard({
  pattern,
  onInsert,
  disabled,
}: {
  pattern: LayoutPattern;
  onInsert: (nodes: LayoutNode[]) => void;
  disabled?: boolean;
}) {
  const t = useT();
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `tpl:${pattern.key}`,
    // patternKey (not the built nodes): the drop handler builds fresh nodes so a
    // drag never reuses ids, and the drag payload stays tiny.
    data: { kind: "template", patternKey: pattern.key },
    disabled,
  });

  return (
    <button
      ref={setNodeRef}
      type="button"
      disabled={disabled}
      // Click still appends — dragging is the "place it exactly" path, clicking is
      // the keyboard-reachable one.
      onClick={() => onInsert(pattern.build())}
      className={cn(
        "cursor-grab rounded-lg border border-neutral-200 bg-neutral-100 p-3 text-left transition-colors hover:border-brand-500 hover:bg-neutral-200 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-800/60 dark:hover:bg-neutral-800",
        isDragging && "opacity-40",
      )}
      {...attributes}
      {...listeners}
    >
      <span className="block text-xs font-semibold text-neutral-800 dark:text-neutral-100">{t(pattern.labelKey)}</span>
      <span className="mt-0.5 block text-[11px] text-neutral-500 dark:text-neutral-400">{t(pattern.descriptionKey)}</span>
    </button>
  );
}
