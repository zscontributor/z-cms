"use client";

import { useState, useTransition } from "react";
import type { PluginResourceField, PluginRow } from "@/lib/api";
import { createPluginRowAction, updatePluginRowAction } from "@/app/actions/plugin-admin";
import { Button } from "@/components/ui/button";
import { Checkbox, Field, Input, Select, Textarea } from "@/components/ui/field";
import { MediaPickerField } from "@/components/editor/media-picker";
import { RichTextEditor } from "@/components/editor/rich-text-editor";
import { useLocale } from "@/lib/i18n-provider";
import { formatCell } from "./format-cell";

export interface ResourceFormLabels {
  save: string;
  cancel: string;
}

/**
 * The create/edit form a plugin's resource declares — one component, used by both
 * screens that can open it: the list (New, and an inline edit) and the record's own
 * detail page (Edit, in place, without losing the record you were reading).
 *
 * It was inline in the list panel while the list was the only screen there was.
 * Copying it onto the detail page would have meant two renderers for one
 * descriptor, and the copy that drifts is always the one you are not looking at.
 */
export function ResourceForm({
  pluginKey,
  resourceKey,
  fields,
  row,
  labels,
  onSaved,
  onCancel,
}: {
  pluginKey: string;
  resourceKey: string;
  fields: PluginResourceField[];
  /** The row being edited, or null to create one. */
  row: PluginRow | null;
  labels: ResourceFormLabels;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const locale = useLocale();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, unknown>>(() => {
    if (!row) return {};
    const seed: Record<string, unknown> = {};
    for (const f of fields) seed[f.column] = row[f.column];
    return seed;
  });

  function submit() {
    setError(null);
    startTransition(async () => {
      const payload: Record<string, unknown> = {};
      for (const f of fields) {
        if (f.readonly) continue;
        payload[f.column] = values[f.column] ?? null;
      }
      const result = row
        ? await updatePluginRowAction(pluginKey, resourceKey, String(row.id), payload)
        : await createPluginRowAction(pluginKey, resourceKey, payload);

      if (result.ok) onSaved();
      else setError(result.error);
    });
  }

  return (
    <div className="z-card flex flex-col gap-3 p-4">
      {error && (
        <div className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-300">
          {error}
        </div>
      )}

      {fields.map((f) => {
        const set = (value: unknown) => setValues((v) => ({ ...v, [f.column]: value }));
        return (
          <Field key={f.column} label={f.label}>
            {f.readonly ? (
              <Input value={formatCell(values[f.column], locale)} disabled readOnly />
            ) : f.input === "textarea" ? (
              <Textarea
                value={String(values[f.column] ?? "")}
                disabled={pending}
                onChange={(e) => set(e.target.value)}
              />
            ) : f.input === "richtext" ? (
              <RichTextEditor
                minHeight="10rem"
                value={String(values[f.column] ?? "")}
                onChange={(html) => set(html)}
              />
            ) : f.input === "boolean" ? (
              <Checkbox
                checked={Boolean(values[f.column])}
                disabled={pending}
                onChange={(e) => set(e.target.checked)}
              />
            ) : f.input === "select" ? (
              <Select
                value={String(values[f.column] ?? "")}
                disabled={pending}
                onChange={(e) => set(e.target.value || null)}
              >
                <option value="" />
                {(f.options ?? []).map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </Select>
            ) : f.input === "media" ? (
              <MediaPickerField
                mode="id"
                value={String(values[f.column] ?? "")}
                onChange={(next) => set(next || null)}
              />
            ) : (
              <Input
                type={f.input === "number" ? "number" : f.input === "date" ? "datetime-local" : "text"}
                value={String(values[f.column] ?? "")}
                disabled={pending}
                onChange={(e) =>
                  set(
                    f.input === "number"
                      ? e.target.value === ""
                        ? null
                        : Number(e.target.value)
                      : e.target.value,
                  )
                }
              />
            )}
          </Field>
        );
      })}

      <div className="flex gap-2">
        <Button type="button" onClick={submit} disabled={pending}>
          {labels.save}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={pending}>
          {labels.cancel}
        </Button>
      </div>
    </div>
  );
}
