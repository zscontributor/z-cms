"use client";

import type { ContentTypeField } from "@zcmsorg/schemas";
import { Checkbox, Field, Input, Select, Textarea } from "@/components/ui/field";
import { useT } from "@/lib/i18n-provider";
import { MediaPickerField } from "./media-picker";
import { RichTextEditor } from "./rich-text-editor";

/**
 * Renders a content type's declared fields. This is the same JSON-driven idea as
 * the theme settings form: the admin has no per-customer code, it draws whatever
 * the content type declared.
 */
export function DynamicFields({
  fields,
  values,
  onChange,
}: {
  fields: ContentTypeField[];
  values: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
}) {
  if (fields.length === 0) return null;

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {fields.map((field) => (
        <DynamicField
          key={field.key}
          field={field}
          value={values[field.key]}
          onChange={(value) => onChange(field.key, value)}
        />
      ))}
    </div>
  );
}

function DynamicField({
  field,
  value,
  onChange,
}: {
  field: ContentTypeField;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const id = `field-${field.key}`;
  const wide = field.type === "textarea" || field.type === "richtext" || field.type === "json";

  return (
    <Field
      label={field.label}
      hint={field.description}
      htmlFor={id}
      required={field.required}
      className={wide ? "sm:col-span-2" : undefined}
    >
      <Control field={field} id={id} value={value} onChange={onChange} />
    </Field>
  );
}

function Control({
  field,
  id,
  value,
  onChange,
}: {
  field: ContentTypeField;
  id: string;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const t = useT();

  switch (field.type) {
    case "textarea":
      return (
        <Textarea
          id={id}
          rows={4}
          value={asString(value)}
          onChange={(event) => onChange(event.target.value)}
        />
      );

    case "richtext":
      return (
        <RichTextEditor
          id={id}
          minHeight="12rem"
          value={asString(value)}
          onChange={(html) => onChange(html)}
        />
      );

    case "number":
      return (
        <Input
          id={id}
          type="number"
          value={value === undefined || value === null ? "" : String(value)}
          onChange={(event) => {
            const raw = event.target.value;
            onChange(raw === "" ? undefined : Number(raw));
          }}
        />
      );

    case "boolean":
      return (
        <label className="flex h-9 items-center gap-2 text-sm">
          <Checkbox
            id={id}
            checked={value === true}
            onChange={(event) => onChange(event.target.checked)}
          />
          <span className="z-muted">{value === true ? t("common.on") : t("common.off")}</span>
        </label>
      );

    case "date":
      // buildContentDataSchema validates this as a full ISO datetime, so the
      // local value from the picker has to be widened before it is stored.
      return (
        <Input
          id={id}
          type="datetime-local"
          value={toLocalInput(value)}
          onChange={(event) => {
            const raw = event.target.value;
            if (!raw) return onChange(undefined);
            const date = new Date(raw);
            onChange(Number.isNaN(date.getTime()) ? undefined : date.toISOString());
          }}
        />
      );

    case "select":
      return (
        <Select
          id={id}
          value={asString(value)}
          onChange={(event) => onChange(event.target.value || undefined)}
        >
          <option value="">{t("common.selectPlaceholder")}</option>
          {(field.options ?? []).map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
      );

    case "media":
      return (
        <MediaPickerField
          id={id}
          mode="id"
          value={asString(value)}
          onChange={(next) => onChange(next || undefined)}
        />
      );

    case "reference":
      return (
        <Input
          id={id}
          value={asString(value)}
          placeholder={
            field.refContentType
              ? t("content.fields.referencePlaceholder", { type: field.refContentType })
              : t("content.fields.referencePlaceholderGeneric")
          }
          onChange={(event) => onChange(event.target.value || undefined)}
        />
      );

    case "json":
      return <JsonControl id={id} value={value} onChange={onChange} />;

    default:
      return (
        <Input
          id={id}
          value={asString(value)}
          onChange={(event) => onChange(event.target.value)}
        />
      );
  }
}

/** Keeps the raw text while it is being typed — otherwise every keystroke that
 *  makes the JSON momentarily invalid would wipe the box. */
function JsonControl({
  id,
  value,
  onChange,
}: {
  id: string;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const t = useT();
  const text = typeof value === "string" ? value : JSON.stringify(value ?? null, null, 2);
  let invalid = false;
  try {
    JSON.parse(text);
  } catch {
    invalid = text.trim() !== "";
  }

  return (
    <>
      <Textarea
        id={id}
        rows={6}
        spellCheck={false}
        className="font-mono text-xs"
        value={text}
        onChange={(event) => onChange(event.target.value)}
      />
      {invalid ? (
        <p className="mt-1 text-[11px] text-red-600 dark:text-red-400">
          {t("content.fields.jsonInvalid")}
        </p>
      ) : null}
    </>
  );
}

function asString(value: unknown): string {
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value : String(value);
}

function toLocalInput(value: unknown): string {
  if (typeof value !== "string" || !value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

/**
 * The `json` control edits text; the API wants a value. Parsed at submit time so
 * a half-typed object never leaves the editor.
 */
export function normalizeFieldValues(
  fields: ContentTypeField[],
  values: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...values };
  for (const field of fields) {
    if (field.type !== "json") continue;
    const raw = out[field.key];
    if (typeof raw !== "string") continue;
    if (raw.trim() === "") {
      delete out[field.key];
      continue;
    }
    try {
      out[field.key] = JSON.parse(raw);
    } catch {
      // Leave it as-is; the API's zod validation will report it.
    }
  }
  return out;
}
