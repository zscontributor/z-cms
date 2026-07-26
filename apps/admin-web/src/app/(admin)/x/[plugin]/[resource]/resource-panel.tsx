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

/** A cell value from Postgres, made readable without knowing its column's type. */
function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "✓" : "—";
  if (typeof value === "object") return JSON.stringify(value);
  const s = String(value);
  // An ISO timestamp reads better localized; anything else passes through.
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) {
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) return d.toLocaleString();
  }
  return s;
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
          {fields.map((f) => (
            <Field key={f.column} label={f.label}>
              {f.input === "textarea" ? (
                <Textarea
                  value={String(values[f.column] ?? "")}
                  disabled={f.readonly || pending}
                  onChange={(e) => setValues((v) => ({ ...v, [f.column]: e.target.value }))}
                />
              ) : f.input === "boolean" ? (
                <Checkbox
                  checked={Boolean(values[f.column])}
                  disabled={f.readonly || pending}
                  onChange={(e) => setValues((v) => ({ ...v, [f.column]: e.target.checked }))}
                />
              ) : f.input === "select" ? (
                <Select
                  value={String(values[f.column] ?? "")}
                  disabled={f.readonly || pending}
                  onChange={(e) => setValues((v) => ({ ...v, [f.column]: e.target.value }))}
                >
                  <option value="" />
                  {(f.options ?? []).map((opt) => (
                    <option key={opt} value={opt}>
                      {opt}
                    </option>
                  ))}
                </Select>
              ) : (
                <Input
                  type={f.input === "number" ? "number" : f.input === "date" ? "datetime-local" : "text"}
                  value={String(values[f.column] ?? "")}
                  disabled={f.readonly || pending}
                  onChange={(e) =>
                    setValues((v) => ({
                      ...v,
                      [f.column]: f.input === "number" ? Number(e.target.value) : e.target.value,
                    }))
                  }
                />
              )}
            </Field>
          ))}
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
                  <TD key={c.column}>{formatCell(row[c.column])}</TD>
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
