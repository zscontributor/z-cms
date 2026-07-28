"use client";

import type { LayoutNode } from "@zcmsorg/schemas";
import { LAYOUT_PATTERNS } from "@/lib/layout-templates";
import { useT } from "@/lib/i18n-provider";

/**
 * Starter section patterns — one click drops a whole ready-made section onto the
 * canvas. Each card calls a factory that mints a fresh `LayoutNode[]`, so inserting
 * the same pattern twice yields two independent sections. It is a shortcut for
 * dragging the widgets in by hand, nothing more — the result is ordinary nodes the
 * author then edits.
 */
export function TemplateGallery({
  onInsert,
  disabled,
}: {
  onInsert: (nodes: LayoutNode[]) => void;
  disabled?: boolean;
}) {
  const t = useT();

  return (
    <div className="flex flex-col gap-2 p-2">
      <p className="px-1 pb-1 text-[11px] text-neutral-400">{t("themeEditor.patterns.hint")}</p>
      {LAYOUT_PATTERNS.map((pattern) => (
        <button
          key={pattern.key}
          type="button"
          disabled={disabled}
          onClick={() => onInsert(pattern.build())}
          className="rounded-lg border border-neutral-700 bg-neutral-800/60 p-3 text-left transition-colors hover:border-brand-500 hover:bg-neutral-800 disabled:opacity-50"
        >
          <span className="block text-xs font-semibold text-neutral-100">{t(pattern.labelKey)}</span>
          <span className="mt-0.5 block text-[11px] text-neutral-400">{t(pattern.descriptionKey)}</span>
        </button>
      ))}
    </div>
  );
}
