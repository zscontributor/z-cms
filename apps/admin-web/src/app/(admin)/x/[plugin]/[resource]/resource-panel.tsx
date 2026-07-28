"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { PluginResourceDescriptor, PluginRow } from "@/lib/api";
import {
  createPluginRowAction,
  deletePluginRowAction,
  updatePluginRowAction,
} from "@/app/actions/plugin-admin";
import { Button } from "@/components/ui/button";
import { Checkbox, Field, Input, Select, Textarea } from "@/components/ui/field";
import { EmptyState, TBody, TD, TH, THead, TR, Table } from "@/components/ui/table";
import { MediaPickerField } from "@/components/editor/media-picker";
import { RichTextEditor } from "@/components/editor/rich-text-editor";
import { useLocale } from "@/lib/i18n-provider";

interface Props {
  pluginKey: string;
  resourceKey: string;
  descriptor: PluginResourceDescriptor;
  rows: PluginRow[];
  canWrite: boolean;
  labels: {
    new: string;
    edit: string;
    delete: string;
    save: string;
    cancel: string;
    empty: string;
    confirmDelete: string;
    actions: string;
  };
}

/**
 * A plain number, grouped for the reader's locale: 55000 → "55,000" (en) or
 * "55.000" (vi). Integers go through BigInt so a large id or quantity keeps full
 * precision; a decimal keeps exactly the fraction digits it was stored with, so a
 * price is not silently rounded. Returns null for anything that is not a bare
 * number (a SKU, a slug, a uuid), which then passes through untouched.
 */
function formatNumberLike(s: string, locale: string): string | null {
  if (/^-?\d+$/.test(s)) {
    try {
      return new Intl.NumberFormat(locale).format(BigInt(s));
    } catch {
      return null;
    }
  }
  if (/^-?\d+\.\d+$/.test(s)) {
    const decimals = Math.min(s.split(".")[1]!.length, 8);
    return new Intl.NumberFormat(locale, {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }).format(Number(s));
  }
  return null;
}

/** A cell value from Postgres, made readable without knowing its column's type. */
function formatCell(value: unknown, locale: string): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "✓" : "—";
  if (typeof value === "object") return JSON.stringify(value);
  const s = String(value);
  // An ISO timestamp reads better localized; anything else falls through.
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) {
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) return d.toLocaleString(locale);
  }
  // A bare number gets thousands separators; a SKU/slug/uuid is left alone.
  return formatNumberLike(s, locale) ?? s;
}

export function ResourcePanel({
  pluginKey,
  resourceKey,
  descriptor,
  rows,
  canWrite,
  labels,
}: Props) {
  const router = useRouter();
  const locale = useLocale();
  const [pending, startTransition] = useTransition();
  const [editing, setEditing] = useState<PluginRow | "new" | null>(null);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [error, setError] = useState<string | null>(null);

  const fields = descriptor.form?.fields ?? [];

  function open(row: PluginRow | "new") {
    setError(null);
    setEditing(row);
    if (row === "new") {
      setValues({});
    } else {
      const seed: Record<string, unknown> = {};
      for (const f of fields) seed[f.column] = row[f.column];
      setValues(seed);
    }
  }

  function submit() {
    setError(null);
    startTransition(async () => {
      const payload: Record<string, unknown> = {};
      for (const f of fields) {
        if (f.readonly) continue;
        payload[f.column] = values[f.column] ?? null;
      }
      const result =
        editing === "new"
          ? await createPluginRowAction(pluginKey, resourceKey, payload)
          : await updatePluginRowAction(pluginKey, resourceKey, String((editing as PluginRow).id), payload);

      if (result.ok) {
        setEditing(null);
        router.refresh();
      } else {
        setError(result.error);
      }
    });
  }

  function remove(row: PluginRow) {
    if (!window.confirm(labels.confirmDelete)) return;
    startTransition(async () => {
      const result = await deletePluginRowAction(pluginKey, resourceKey, String(row.id));
      if (result.ok) router.refresh();
      else setError(result.error);
    });
  }

  return (
    <div className="flex flex-col gap-4">
      {canWrite && descriptor.form && (
        <div className="flex justify-end">
          <Button type="button" onClick={() => open("new")} disabled={pending}>
            {labels.new}
          </Button>
        </div>
      )}

      {error && (
        <div className="z-card border-red-300 bg-red-50 px-4 py-2 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-300">
          {error}
        </div>
      )}

      {editing !== null && (
        <div className="z-card flex flex-col gap-3 p-4">
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
            <Button type="button" variant="ghost" onClick={() => setEditing(null)} disabled={pending}>
              {labels.cancel}
            </Button>
          </div>
        </div>
      )}

      {rows.length === 0 ? (
        <div className="z-card">
          <EmptyState title={labels.empty} />
        </div>
      ) : (
        <Table>
          <THead>
            <TR>
              {descriptor.list.columns.map((c) => (
                <TH key={c.column}>{c.label}</TH>
              ))}
              {canWrite && descriptor.form && <TH className="w-28 text-right">{labels.actions}</TH>}
            </TR>
          </THead>
          <TBody>
            {rows.map((row, i) => (
              <TR key={String(row.id ?? i)}>
                {descriptor.list.columns.map((c) => (
                  <TD key={c.column}>{formatCell(row[c.column], locale)}</TD>
                ))}
                {canWrite && descriptor.form && (
                  <TD className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button type="button" size="sm" variant="ghost" onClick={() => open(row)} disabled={pending}>
                        {labels.edit}
                      </Button>
                      <Button type="button" size="sm" variant="ghost" onClick={() => remove(row)} disabled={pending}>
                        {labels.delete}
                      </Button>
                    </div>
                  </TD>
                )}
              </TR>
            ))}
          </TBody>
        </Table>
      )}
    </div>
  );
}
