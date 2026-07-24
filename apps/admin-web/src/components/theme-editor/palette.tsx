"use client";

import { useDraggable } from "@dnd-kit/core";
import { WIDGET_CATALOG, type WidgetCategory, type WidgetSpec } from "@zcmsorg/schemas";
import { cn } from "@/lib/cn";
import { useT } from "@/lib/i18n-provider";

/**
 * The palette: everything a person can put on the page, grouped.
 *
 * Built straight from WIDGET_CATALOG, so adding a widget to the library adds it
 * here — the same property the settings form has, and for the same reason. There
 * is no second list to forget to update.
 */

const CATEGORY_ORDER: WidgetCategory[] = ["content", "media", "layout", "dynamic"];

export function Palette({
  onAdd,
  disabled,
}: {
  /** The keyboard path: dragging is not the only way to add a widget. */
  onAdd: (widgetType: string) => void;
  disabled?: boolean;
}) {
  const t = useT();

  return (
    <div className="flex h-full flex-col overflow-y-auto p-3">
      {CATEGORY_ORDER.map((category) => {
        const widgets = WIDGET_CATALOG.filter((spec) => spec.category === category);
        if (widgets.length === 0) return null;
        return (
          <section key={category} className="mb-4">
            <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
              {t(`themeEditor.categories.${category}`)}
            </h3>
            <div className="grid grid-cols-2 gap-2">
              {widgets.map((spec) => (
                <PaletteItem key={spec.type} spec={spec} onAdd={onAdd} disabled={disabled} />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function PaletteItem({
  spec,
  onAdd,
  disabled,
}: {
  spec: WidgetSpec;
  onAdd: (widgetType: string) => void;
  disabled?: boolean;
}) {
  const t = useT();
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `new:${spec.type}`,
    data: { kind: "new", widgetType: spec.type },
    disabled,
  });

  return (
    <button
      ref={setNodeRef}
      type="button"
      title={t(spec.descriptionKey)}
      className={cn(
        "flex cursor-grab flex-col items-center gap-1 rounded border border-neutral-200 p-2 text-center text-[11px] transition-colors hover:border-brand-500 hover:text-brand-600 disabled:opacity-50 dark:border-neutral-800",
        isDragging && "opacity-40",
      )}
      disabled={disabled}
      // Click-to-add appends into the current column. A palette that could ONLY be
      // dragged would be unusable by keyboard, and "add, then move up" is a fine
      // way to place a widget — it is what the block editor has always done.
      onClick={() => onAdd(spec.type)}
      {...attributes}
      {...listeners}
    >
      <span className="text-base leading-none">{spec.icon}</span>
      <span className="truncate">{t(spec.labelKey)}</span>
    </button>
  );
}
