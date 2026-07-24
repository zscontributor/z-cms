"use client";

import {
  COLLECTION_MAX_LIMIT,
  COLLECTION_SORTS,
  CONTAINER_SPECS,
  type CollectionSort,
  type LayoutDocument,
  type LayoutNode,
  type LayoutTokens,
} from "@zcmsorg/schemas";
import type { ContentTypeOption } from "@/lib/block-registry";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/field";
import { useT } from "@/lib/i18n-provider";
import { bindingNeedsNewSlot, collectionBudget, specFor } from "@/lib/layout-doc";
import { WidgetPropsForm } from "./widget-props-form";

/**
 * The right-hand panel: what the selected thing is, and every knob it has.
 *
 * Three sections, and which appear depends on the selection — a section has
 * padding, a post-list has a query, a heading has neither. Nothing is invented for
 * a node that does not declare it: the catalogue is the description, and a control
 * the widget library does not read would be a knob that does nothing.
 */
export function Inspector({
  doc,
  node,
  contentTypes,
  onProps,
  onBinding,
  onTokens,
  onDelete,
  onDuplicate,
  disabled,
}: {
  doc: LayoutDocument;
  /** Null when nothing is selected — the panel then edits the theme's tokens. */
  node: LayoutNode | null;
  contentTypes: ContentTypeOption[];
  onProps: (props: Record<string, unknown>) => void;
  onBinding: (binding: LayoutNode["binding"]) => void;
  onTokens: (tokens: LayoutTokens) => void;
  onDelete: () => void;
  onDuplicate: () => void;
  disabled?: boolean;
}) {
  const t = useT();

  if (!node) return <TokensPanel tokens={doc.tokens} onChange={onTokens} disabled={disabled} />;

  const spec = specFor(node);
  const containerSpec = node.kind !== "widget" ? CONTAINER_SPECS[node.kind] : undefined;
  const propSpecs = spec?.props ?? containerSpec?.props ?? [];
  const title = spec ? t(spec.labelKey) : containerSpec ? t(containerSpec.labelKey) : node.kind;

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-neutral-200 px-4 py-3 dark:border-neutral-800">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold">{title}</h2>
          {/* A widget the catalogue does not know still round-trips — the document
              may have been drawn on a newer build. Say so rather than pretend. */}
          {node.kind === "widget" && !spec ? (
            <p className="truncate text-xs text-amber-600">
              {t("themeEditor.inspector.unknownWidget", { type: node.widgetType ?? "" })}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 gap-1">
          <Button variant="ghost" size="sm" disabled={disabled} onClick={onDuplicate}>
            {t("themeEditor.actions.duplicate")}
          </Button>
          <Button variant="ghost" size="sm" disabled={disabled} onClick={onDelete}>
            {t("themeEditor.actions.delete")}
          </Button>
        </div>
      </header>

      <div className="flex-1 space-y-5 overflow-y-auto p-4">
        <WidgetPropsForm
          specs={propSpecs}
          props={node.props}
          onChange={onProps}
          disabled={disabled}
        />

        {spec?.bind.kind === "collection" ? (
          <CollectionBinding
            doc={doc}
            node={node}
            contentTypes={contentTypes}
            onChange={onBinding}
            disabled={disabled}
          />
        ) : null}

        {spec?.bind.kind === "current" ? (
          <p className="rounded border border-neutral-200 bg-neutral-50 p-3 text-xs text-neutral-600 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-400">
            {t("themeEditor.inspector.currentBinding")}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The query controls for a post-list.
 *
 * This is the whole of what a drawn theme may ask the database. Three fields:
 * which type, how many, in what order. There is no filter, no `where`, no operator
 * — the same limit a hand-written theme's manifest has, and for the same reason:
 * anything expressive enough to be useful to a stranger's theme is expressive
 * enough to read rows it was never meant to see.
 */
function CollectionBinding({
  doc,
  node,
  contentTypes,
  onChange,
  disabled,
}: {
  doc: LayoutDocument;
  node: LayoutNode;
  contentTypes: ContentTypeOption[];
  onChange: (binding: LayoutNode["binding"]) => void;
  disabled?: boolean;
}) {
  const t = useT();
  const binding = node.binding?.source === "collection" ? node.binding : undefined;
  const budget = collectionBudget(doc);

  const set = (patch: Partial<NonNullable<typeof binding>>) => {
    const next = {
      source: "collection" as const,
      contentType: binding?.contentType ?? "",
      limit: binding?.limit ?? 6,
      sort: binding?.sort ?? ("newest" as CollectionSort),
      ...patch,
    };
    if (!next.contentType) return onChange(undefined);
    onChange(next);
  };

  // A binding that asks a question one of the existing eight already asks is free —
  // it shares the slot. So the warning is about NEW questions, not about lists.
  const wouldNeedSlot = binding ? bindingNeedsNewSlot(doc, binding) : true;
  const blocked = budget.full && wouldNeedSlot;

  return (
    <section className="space-y-3 rounded border border-neutral-200 p-3 dark:border-neutral-800">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
        {t("themeEditor.inspector.dataSource")}
      </h3>

      <Field label={t("themeEditor.props.contentType")} hint={t("themeEditor.hints.contentType")}>
        <Select
          value={binding?.contentType ?? ""}
          disabled={disabled}
          onChange={(e) => set({ contentType: e.target.value })}
        >
          <option value="">{t("themeEditor.props.contentTypeNone")}</option>
          {/* Resolved against the site's REAL content types. A typed "posts" where
              the site says "post" is a list that is silently, permanently empty. */}
          {contentTypes.map((type) => (
            <option key={type.key} value={type.key}>
              {type.name}
            </option>
          ))}
        </Select>
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label={t("themeEditor.props.limit")} hint={t("themeEditor.hints.limit", { max: COLLECTION_MAX_LIMIT })}>
          <Input
            type="number"
            min={1}
            max={COLLECTION_MAX_LIMIT}
            value={String(binding?.limit ?? 6)}
            disabled={disabled || !binding}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (!Number.isFinite(n)) return;
              set({ limit: Math.min(COLLECTION_MAX_LIMIT, Math.max(1, Math.trunc(n))) });
            }}
          />
        </Field>
        <Field label={t("themeEditor.props.sort")}>
          <Select
            value={binding?.sort ?? "newest"}
            disabled={disabled || !binding}
            onChange={(e) => set({ sort: e.target.value as CollectionSort })}
          >
            {COLLECTION_SORTS.map((sort) => (
              <option key={sort} value={sort}>
                {t(`themeEditor.props.sort${sort[0]!.toUpperCase()}${sort.slice(1)}`)}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <p className={blocked ? "text-xs text-amber-600" : "text-xs text-neutral-500"}>
        {blocked
          ? t("themeEditor.inspector.budgetFull", { max: budget.max })
          : t("themeEditor.inspector.budget", { used: budget.used, max: budget.max })}
      </p>
    </section>
  );
}

/** The theme-wide knobs. They become the generated theme's settingsSchema. */
function TokensPanel({
  tokens,
  onChange,
  disabled,
}: {
  tokens: LayoutTokens;
  onChange: (tokens: LayoutTokens) => void;
  disabled?: boolean;
}) {
  const t = useT();
  const set = (patch: Partial<LayoutTokens>) => onChange({ ...tokens, ...patch });

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-neutral-200 px-4 py-3 dark:border-neutral-800">
        <h2 className="text-sm font-semibold">{t("themeEditor.inspector.themeTitle")}</h2>
        <p className="text-xs text-neutral-500">{t("themeEditor.inspector.themeHint")}</p>
      </header>
      <div className="flex-1 space-y-3 overflow-y-auto p-4">
        <ColorToken
          label={t("themeEditor.tokens.colorPrimary")}
          value={tokens.colorPrimary}
          disabled={disabled}
          onChange={(v) => set({ colorPrimary: v })}
        />
        <ColorToken
          label={t("themeEditor.tokens.colorText")}
          value={tokens.colorText}
          disabled={disabled}
          onChange={(v) => set({ colorText: v })}
        />
        <ColorToken
          label={t("themeEditor.tokens.colorBackground")}
          value={tokens.colorBackground}
          disabled={disabled}
          onChange={(v) => set({ colorBackground: v })}
        />
        <Field label={t("themeEditor.tokens.fontHeading")}>
          <Input
            value={tokens.fontHeading ?? ""}
            placeholder="Georgia, serif"
            disabled={disabled}
            onChange={(e) => set({ fontHeading: e.target.value || undefined })}
          />
        </Field>
        <Field label={t("themeEditor.tokens.fontBody")}>
          <Input
            value={tokens.fontBody ?? ""}
            placeholder="system-ui, sans-serif"
            disabled={disabled}
            onChange={(e) => set({ fontBody: e.target.value || undefined })}
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t("themeEditor.tokens.radius")}>
            <Input
              type="number"
              min={0}
              max={64}
              value={tokens.radius ?? ""}
              disabled={disabled}
              onChange={(e) =>
                set({ radius: e.target.value === "" ? undefined : Number(e.target.value) })
              }
            />
          </Field>
          <Field label={t("themeEditor.tokens.maxWidth")}>
            <Input
              type="number"
              min={320}
              max={2560}
              value={tokens.maxWidth ?? ""}
              disabled={disabled}
              onChange={(e) =>
                set({ maxWidth: e.target.value === "" ? undefined : Number(e.target.value) })
              }
            />
          </Field>
        </div>
      </div>
    </div>
  );
}

function ColorToken({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: string | undefined;
  onChange: (value: string | undefined) => void;
  disabled?: boolean;
}) {
  const t = useT();
  return (
    <Field label={label}>
      <div className="flex items-center gap-2">
        <input
          type="color"
          className="h-9 w-12 cursor-pointer rounded border border-neutral-300 bg-transparent dark:border-neutral-700"
          value={value || "#000000"}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        />
        <Input
          value={value ?? ""}
          placeholder={t("themeEditor.tokens.unset")}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value || undefined)}
        />
        {/* Unset is a real state, and the only way back to the stylesheet's own
            default. A colour input alone cannot express it. */}
        {value ? (
          <Button variant="ghost" size="sm" disabled={disabled} onClick={() => onChange(undefined)}>
            {t("themeEditor.tokens.clear")}
          </Button>
        ) : null}
      </div>
    </Field>
  );
}
