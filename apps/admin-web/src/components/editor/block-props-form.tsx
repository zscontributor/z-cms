"use client";

import { useState } from "react";
import type {
  ContentTypeOption,
  ResolvedBlockSpec,
  ResolvedItemField,
  ResolvedPropSpec,
} from "@/lib/block-registry";
import { Button } from "@/components/ui/button";
import { Checkbox, Field, Input, Select, Textarea } from "@/components/ui/field";
import { Icon } from "@/components/shell/icon";
import { useT } from "@/lib/i18n-provider";
import { MediaPickerField } from "./media-picker";
import { RichTextEditor } from "./rich-text-editor";

type Props = Record<string, unknown>;

export function BlockPropsForm({
  spec,
  props,
  onChange,
  disabled,
  contentTypes,
}: {
  spec: ResolvedBlockSpec;
  props: Props;
  onChange: (props: Props) => void;
  disabled?: boolean;
  /** The site's content types — what a `contentType` control resolves its key against. */
  contentTypes: ContentTypeOption[];
}) {
  function set(key: string, value: unknown) {
    onChange({ ...props, [key]: value });
  }

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {spec.props.map((prop) => (
        <PropControl
          key={prop.key}
          prop={prop}
          value={props[prop.key]}
          disabled={disabled}
          contentTypes={contentTypes}
          onChange={(value) => set(prop.key, value)}
        />
      ))}
    </div>
  );
}

/** Kinds that want the full row rather than half of the two-column grid. */
const WIDE_KINDS = new Set<ResolvedPropSpec["kind"]>([
  "textarea",
  "html",
  "items",
  "stringList",
  "json",
]);

function PropControl({
  prop,
  value,
  onChange,
  disabled,
  contentTypes,
}: {
  prop: ResolvedPropSpec;
  value: unknown;
  onChange: (value: unknown) => void;
  disabled?: boolean;
  contentTypes: ContentTypeOption[];
}) {
  const id = `prop-${prop.key}`;

  return (
    <Field
      label={prop.label}
      htmlFor={id}
      hint={prop.hint}
      className={WIDE_KINDS.has(prop.kind) ? "sm:col-span-2" : undefined}
    >
      {prop.kind === "text" ? (
        <Input
          id={id}
          disabled={disabled}
          value={str(value)}
          placeholder={prop.placeholder}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : null}

      {prop.kind === "textarea" ? (
        <Textarea
          id={id}
          rows={3}
          disabled={disabled}
          value={str(value)}
          placeholder={prop.placeholder}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : null}

      {prop.kind === "html" ? (
        <RichTextEditor
          id={id}
          disabled={disabled}
          value={str(value)}
          onChange={(html) => onChange(html)}
        />
      ) : null}

      {prop.kind === "url" ? (
        <MediaPickerField
          id={id}
          mode="url"
          value={str(value)}
          placeholder={prop.placeholder}
          onChange={(next) => onChange(next)}
        />
      ) : null}

      {prop.kind === "boolean" ? (
        <BooleanControl id={id} value={value} onChange={onChange} disabled={disabled} />
      ) : null}

      {prop.kind === "select" ? (
        <Select
          id={id}
          disabled={disabled}
          value={str(value)}
          onChange={(event) => onChange(event.target.value)}
        >
          {(prop.options ?? []).map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
      ) : null}

      {prop.kind === "number" ? (
        <Input
          id={id}
          type="number"
          inputMode="numeric"
          step={1}
          min={prop.min}
          max={prop.max}
          disabled={disabled}
          value={str(value)}
          placeholder={prop.placeholder}
          // Clamped on blur, not on every keystroke: rewriting "1" to the minimum
          // while someone is still typing "12" makes the field impossible to use.
          // A `type="number"` input hands back "" for text, so "abc" never lands in
          // the props — an out-of-range digit is the only bad value left to catch.
          onChange={(event) => onChange(readNumber(event.target.value))}
          onBlur={(event) => onChange(clamp(readNumber(event.target.value), prop))}
        />
      ) : null}

      {prop.kind === "contentType" ? (
        <ContentTypeControl
          id={id}
          value={value}
          onChange={onChange}
          disabled={disabled}
          contentTypes={contentTypes}
        />
      ) : null}

      {prop.kind === "items" ? (
        <ItemsControl prop={prop} value={value} onChange={onChange} disabled={disabled} />
      ) : null}

      {prop.kind === "stringList" ? (
        <StringListControl prop={prop} value={value} onChange={onChange} disabled={disabled} />
      ) : null}

      {prop.kind === "json" ? (
        <JsonControl id={id} value={value} onChange={onChange} disabled={disabled} />
      ) : null}
    </Field>
  );
}

function BooleanControl({
  id,
  value,
  onChange,
  disabled,
}: {
  id: string;
  value: unknown;
  onChange: (value: unknown) => void;
  disabled?: boolean;
}) {
  const t = useT();
  return (
    <label className="flex h-9 items-center gap-2 text-sm">
      <Checkbox
        id={id}
        disabled={disabled}
        checked={value === true}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="z-muted">{value === true ? t("common.on") : t("common.off")}</span>
    </label>
  );
}

/**
 * A select over the content types this site actually has. The stored value is the
 * type KEY ("post"); what an editor reads is its name ("Post"), because the key is
 * an implementation detail they never chose.
 */
function ContentTypeControl({
  id,
  value,
  onChange,
  disabled,
  contentTypes,
}: {
  id: string;
  value: unknown;
  onChange: (value: unknown) => void;
  disabled?: boolean;
  contentTypes: ContentTypeOption[];
}) {
  const t = useT();
  const current = str(value);

  // A site with no content types cannot list anything; an empty select with no
  // explanation would look like a bug in the editor rather than an empty site.
  if (contentTypes.length === 0) {
    return <p className="text-[11px] z-muted">{t("content.blocks.noContentTypes")}</p>;
  }

  // A key the site no longer defines (the type was renamed or deleted under a
  // saved page) has no option to select, and the browser would show the field as
  // blank — making a *stored* value look unset and inviting a silent overwrite on
  // the next save. Keep it, flagged, so the editor sees what the block is asking
  // for and decides whether to change it.
  const orphaned = current !== "" && !contentTypes.some((type) => type.key === current);

  return (
    <Select
      id={id}
      disabled={disabled}
      value={current}
      onChange={(event) => onChange(event.target.value)}
    >
      <option value="">{t("content.blocks.props.contentTypeUnset")}</option>
      {contentTypes.map((type) => (
        <option key={type.key} value={type.key}>
          {type.name}
        </option>
      ))}
      {orphaned ? (
        <option value={current}>
          {t("content.blocks.props.contentTypeUnknown", { key: current })}
        </option>
      ) : null}
    </Select>
  );
}

/** "" (a cleared field, or text a number input refused) means "unset", not zero. */
function readNumber(raw: string): number | undefined {
  if (raw.trim() === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function clamp(value: number | undefined, prop: ResolvedPropSpec): number | undefined {
  if (value === undefined) return undefined;
  const min = prop.min ?? Number.NEGATIVE_INFINITY;
  const max = prop.max ?? Number.POSITIVE_INFINITY;
  return Math.min(Math.max(Math.round(value), min), max);
}

/** A repeatable list of small records (e.g. the entries of core/features). */
function ItemsControl({
  prop,
  value,
  onChange,
  disabled,
}: {
  prop: ResolvedPropSpec;
  value: unknown;
  onChange: (value: unknown) => void;
  disabled?: boolean;
}) {
  const t = useT();
  const fields = prop.itemFields ?? [];
  const items: Props[] = Array.isArray(value) ? (value as Props[]) : [];
  const itemLabel = prop.itemLabel ?? t("content.blocks.item");

  function update(index: number, key: string, next: unknown) {
    const copy = items.map((item, i) => (i === index ? { ...item, [key]: next } : item));
    onChange(copy);
  }

  function move(index: number, delta: number) {
    const target = index + delta;
    if (target < 0 || target >= items.length) return;
    const copy = [...items];
    const [item] = copy.splice(index, 1);
    if (item) copy.splice(target, 0, item);
    onChange(copy);
  }

  return (
    <div className="flex flex-col gap-2">
      {items.map((item, index) => (
        <div
          key={index}
          className="rounded-md border border-[var(--border)] bg-[var(--surface-sunken)] p-2.5"
        >
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[11px] font-medium z-muted">
              {itemLabel} {index + 1}
            </span>
            <span className="flex gap-0.5">
              <Button
                size="sm"
                variant="ghost"
                disabled={disabled || index === 0}
                onClick={() => move(index, -1)}
                aria-label={t("common.moveUp")}
                className="size-7 px-0"
              >
                <Icon name="up" size={18} />
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={disabled || index === items.length - 1}
                onClick={() => move(index, 1)}
                aria-label={t("common.moveDown")}
                className="size-7 px-0"
              >
                <Icon name="down" size={18} />
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={disabled}
                onClick={() => onChange(items.filter((_, i) => i !== index))}
                aria-label={t("common.delete")}
                className="size-7 px-0 hover:text-red-600 dark:hover:text-red-400"
              >
                <Icon name="trash" size={18} />
              </Button>
            </span>
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            {fields.map((field) => (
              <ItemFieldControl
                key={field.key}
                field={field}
                value={item[field.key]}
                disabled={disabled}
                onChange={(next) => update(index, field.key, next)}
              />
            ))}
          </div>
        </div>
      ))}

      <Button
        size="sm"
        disabled={disabled}
        onClick={() => {
          const blank: Props = {};
          for (const field of fields) blank[field.key] = field.kind === "boolean" ? false : "";
          onChange([...items, blank]);
        }}
        className="self-start border-dashed"
      >
        <Icon name="plus" size={18} />
        {t("content.blocks.addItem", { item: itemLabel.toLowerCase() })}
      </Button>
    </div>
  );
}

/** One field of an item record — text/textarea/url/boolean/select. */
function ItemFieldControl({
  field,
  value,
  onChange,
  disabled,
}: {
  field: ResolvedItemField;
  value: unknown;
  onChange: (value: unknown) => void;
  disabled?: boolean;
}) {
  const wide = field.kind === "textarea";
  return (
    <Field label={field.label} className={wide ? "sm:col-span-2" : undefined}>
      {field.kind === "textarea" ? (
        <Textarea
          rows={2}
          disabled={disabled}
          value={str(value)}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : field.kind === "boolean" ? (
        <BooleanControl id={field.key} value={value} onChange={onChange} disabled={disabled} />
      ) : field.kind === "select" ? (
        <Select
          disabled={disabled}
          value={str(value)}
          onChange={(event) => onChange(event.target.value)}
        >
          {(field.options ?? []).map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
      ) : field.kind === "url" ? (
        <MediaPickerField mode="url" value={str(value)} onChange={(next) => onChange(next)} />
      ) : (
        <Input
          disabled={disabled}
          value={str(value)}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </Field>
  );
}

/** A repeatable list of plain strings — stored as `string[]`, never as records. */
function StringListControl({
  prop,
  value,
  onChange,
  disabled,
}: {
  prop: ResolvedPropSpec;
  value: unknown;
  onChange: (value: unknown) => void;
  disabled?: boolean;
}) {
  const t = useT();
  const items: string[] = Array.isArray(value) ? value.map((entry) => str(entry)) : [];
  const itemLabel = prop.itemLabel ?? t("content.blocks.item");

  function update(index: number, next: string) {
    onChange(items.map((item, i) => (i === index ? next : item)));
  }

  function move(index: number, delta: number) {
    const target = index + delta;
    if (target < 0 || target >= items.length) return;
    const copy = [...items];
    const [item] = copy.splice(index, 1);
    if (item !== undefined) copy.splice(target, 0, item);
    onChange(copy);
  }

  return (
    <div className="flex flex-col gap-2">
      {items.map((item, index) => (
        <div key={index} className="flex items-start gap-1.5">
          {prop.multiline ? (
            <Textarea
              rows={2}
              disabled={disabled}
              value={item}
              onChange={(event) => update(index, event.target.value)}
              className="flex-1"
            />
          ) : (
            <Input
              disabled={disabled}
              value={item}
              onChange={(event) => update(index, event.target.value)}
              className="flex-1"
            />
          )}
          <span className="flex shrink-0 gap-0.5">
            <Button
              size="sm"
              variant="ghost"
              disabled={disabled || index === 0}
              onClick={() => move(index, -1)}
              aria-label={t("common.moveUp")}
              className="size-8 px-0"
            >
              <Icon name="up" size={18} />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={disabled || index === items.length - 1}
              onClick={() => move(index, 1)}
              aria-label={t("common.moveDown")}
              className="size-8 px-0"
            >
              <Icon name="down" size={18} />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={disabled}
              onClick={() => onChange(items.filter((_, i) => i !== index))}
              aria-label={t("common.delete")}
              className="size-8 px-0 hover:text-red-600 dark:hover:text-red-400"
            >
              <Icon name="trash" size={18} />
            </Button>
          </span>
        </div>
      ))}

      <Button
        size="sm"
        disabled={disabled}
        onClick={() => onChange([...items, ""])}
        className="self-start border-dashed"
      >
        <Icon name="plus" size={18} />
        {t("content.blocks.addItem", { item: itemLabel.toLowerCase() })}
      </Button>
    </div>
  );
}

/**
 * The last-resort control for a value the editor cannot otherwise shape — a nested
 * object. An editable JSON box: the parsed value is written up only while the text
 * parses, so a half-typed edit can never persist malformed props. Still strictly
 * better than a read-only dump.
 */
function JsonControl({
  id,
  value,
  onChange,
  disabled,
}: {
  id: string;
  value: unknown;
  onChange: (value: unknown) => void;
  disabled?: boolean;
}) {
  const t = useT();
  const [raw, setRaw] = useState(() => stringifyJson(value));
  const [error, setError] = useState(false);

  function onEdit(text: string) {
    setRaw(text);
    try {
      const parsed = JSON.parse(text);
      setError(false);
      onChange(parsed);
    } catch {
      setError(true);
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <Textarea
        id={id}
        rows={6}
        disabled={disabled}
        value={raw}
        onChange={(event) => onEdit(event.target.value)}
        className="font-mono text-[11px]"
        spellCheck={false}
      />
      {error ? (
        <p className="text-[11px] text-red-600 dark:text-red-400">
          {t("content.blocks.generic.invalidJson")}
        </p>
      ) : null}
    </div>
  );
}

function stringifyJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? {}, null, 2);
  } catch {
    return "{}";
  }
}

function str(value: unknown): string {
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value : String(value);
}
