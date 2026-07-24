"use client";

import { useState } from "react";
import type { Block, BlockDocument, CoreBlockType } from "@zcmsorg/schemas";
import type { ContentTypeOption } from "@/lib/block-registry";
import { BLOCK_SPECS, createBlock, getBlockSpec, newBlockId } from "@/lib/block-registry";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/shell/icon";
import { cn } from "@/lib/cn";
import { useT } from "@/lib/i18n-provider";
import { BlockPropsForm } from "./block-props-form";

/**
 * Reorder is buttons, not drag-and-drop: a drag library is 30 kB and a
 * keyboard-hostile interaction, and "move up" is what an editor actually reaches
 * for on a ten-block page.
 */
export function BlockEditor({
  blocks,
  onChange,
  disabled,
  contentTypes,
}: {
  blocks: BlockDocument;
  onChange: (blocks: BlockDocument) => void;
  disabled?: boolean;
  /** The site's content types — a `core/content-list` block lists one of them. */
  contentTypes: ContentTypeOption[];
}) {
  const t = useT();
  const [openId, setOpenId] = useState<string | null>(blocks[0]?.id ?? null);
  const [adding, setAdding] = useState(false);

  function update(index: number, next: Block) {
    const copy = [...blocks];
    copy[index] = next;
    onChange(copy);
  }

  function move(index: number, delta: number) {
    const target = index + delta;
    if (target < 0 || target >= blocks.length) return;
    const copy = [...blocks];
    const [item] = copy.splice(index, 1);
    if (item) copy.splice(target, 0, item);
    onChange(copy);
  }

  function remove(index: number) {
    onChange(blocks.filter((_, i) => i !== index));
  }

  function add(type: CoreBlockType) {
    const block = createBlock(type, t);
    onChange([...blocks, block]);
    setOpenId(block.id);
    setAdding(false);
  }

  function duplicate(index: number) {
    const source = blocks[index];
    if (!source) return;
    const copy = [...blocks];
    const clone: Block = { ...structuredClone(source), id: newBlockId() };
    copy.splice(index + 1, 0, clone);
    onChange(copy);
    setOpenId(clone.id);
  }

  return (
    <div className="flex flex-col gap-2">
      {blocks.length === 0 ? (
        <p className="rounded-md border border-dashed border-[var(--border-strong)] px-4 py-8 text-center text-xs z-muted">
          {t("content.blocks.empty")}
        </p>
      ) : null}

      {blocks.map((block, index) => {
        const spec = getBlockSpec(block.type);
        const open = openId === block.id;

        return (
          <div key={block.id} className="rounded-md border border-[var(--border)]">
            <div
              className={cn(
                "flex items-center gap-2 px-2.5 py-2",
                open && "border-b border-[var(--border)] bg-[var(--surface-sunken)]",
              )}
            >
              <button
                type="button"
                onClick={() => setOpenId(open ? null : block.id)}
                aria-expanded={open}
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
              >
                <span className="flex size-6 shrink-0 items-center justify-center rounded bg-brand-500/12 text-[10px] font-bold text-brand-600 dark:text-brand-300">
                  {spec?.icon ?? "?"}
                </span>
                <span className="min-w-0">
                  <span className="block text-[13px] font-medium">
                    {spec ? t(spec.labelKey) : block.type}
                  </span>
                  <span className="block truncate text-[11px] z-muted">
                    {summarize(block) ||
                      (spec ? t(spec.descriptionKey) : "") ||
                      block.type}
                  </span>
                </span>
              </button>

              <span className="flex shrink-0 items-center gap-0.5">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={disabled || index === 0}
                  onClick={() => move(index, -1)}
                  aria-label={t("common.moveUp")}
                  className="size-8 px-0"
                >
                  <Icon name="up" size={20} />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={disabled || index === blocks.length - 1}
                  onClick={() => move(index, 1)}
                  aria-label={t("common.moveDown")}
                  className="size-8 px-0"
                >
                  <Icon name="down" size={20} />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={disabled}
                  onClick={() => duplicate(index)}
                  aria-label={t("common.duplicate")}
                  className="size-8 px-0"
                >
                  <Icon name="copy" size={20} />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={disabled}
                  onClick={() => remove(index)}
                  aria-label={t("content.blocks.delete")}
                  className="size-8 px-0 hover:text-red-600 dark:hover:text-red-400"
                >
                  <Icon name="trash" size={20} />
                </Button>
              </span>
            </div>

            {open ? (
              <div className="p-3">
                {spec ? (
                  <BlockPropsForm
                    spec={spec}
                    props={block.props}
                    disabled={disabled}
                    contentTypes={contentTypes}
                    onChange={(props) => update(index, { ...block, props })}
                  />
                ) : (
                  <UnknownBlock block={block} />
                )}
              </div>
            ) : null}
          </div>
        );
      })}

      <div className="relative">
        <Button
          variant="secondary"
          disabled={disabled}
          onClick={() => setAdding((value) => !value)}
          className="w-full border-dashed"
          aria-expanded={adding}
        >
          <Icon name="plus" size={18} />
          {t("content.blocks.add")}
        </Button>

        {adding ? (
          <div className="z-card absolute inset-x-0 bottom-full z-20 mb-1 p-1 shadow-lg">
            {BLOCK_SPECS.map((spec) => (
              <button
                key={spec.type}
                type="button"
                onClick={() => add(spec.type)}
                className="flex w-full items-start gap-2.5 rounded-md px-2 py-2 text-left hover:bg-[var(--surface-sunken)]"
              >
                <span className="flex size-6 shrink-0 items-center justify-center rounded bg-brand-500/12 text-[10px] font-bold text-brand-600 dark:text-brand-300">
                  {spec.icon}
                </span>
                <span className="min-w-0">
                  <span className="block text-[13px] font-medium">{t(spec.labelKey)}</span>
                  <span className="block text-[11px] z-muted">{t(spec.descriptionKey)}</span>
                </span>
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * A block whose type this admin build does not know (a theme or plugin block)
 * must survive a round trip through the editor untouched — silently dropping a
 * theme's block on save would be data loss.
 */
function UnknownBlock({ block }: { block: Block }) {
  const t = useT();
  return (
    <div className="rounded-md bg-[var(--surface-sunken)] p-3">
      <p className="text-[11px] z-muted">
        {t("content.blocks.unknownTitle", { type: block.type })}
      </p>
      <pre className="mt-2 max-h-40 overflow-auto font-mono text-[11px] z-muted">
        {JSON.stringify(block.props, null, 2)}
      </pre>
    </div>
  );
}

function summarize(block: Block): string {
  const props = block.props;
  for (const key of ["heading", "title", "src", "html", "text"]) {
    const value = props[key];
    if (typeof value === "string" && value.trim()) {
      return value.replace(/<[^>]*>/g, " ").trim().slice(0, 80);
    }
  }
  return "";
}
