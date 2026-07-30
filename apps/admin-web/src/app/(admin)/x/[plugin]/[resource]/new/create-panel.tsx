"use client";

import { useRouter } from "next/navigation";
import type { PluginColumnType, PluginResourceField } from "@/lib/api";
import { withReturnTo } from "@/lib/return-to";
import { ResourceForm, type ResourceFormLabels } from "../resource-form";

/**
 * The create form, and where saving and cancelling go.
 *
 * Saving lands on the record just made rather than back on the list: it is the
 * screen that can show what was actually stored — including the columns the
 * plugin left out of its form — and it is where the next thing anyone does
 * (correct a price, add a related row) already lives. The list state carries on
 * from there, so "back to list" from the new record still returns to the page the
 * reader started on. A create that answers without a row (a plugin table with no
 * returning id) falls back to the list rather than to a record that cannot be
 * addressed.
 */
export function CreatePanel({
  pluginKey,
  resourceKey,
  basePath,
  backPath,
  returnTo,
  fields,
  columnTypes,
  columnBounds,
  labels,
}: {
  pluginKey: string;
  resourceKey: string;
  /** The resource's list URL, the base every record hangs off. */
  basePath: string;
  /** The list as the reader left it — where cancel goes. */
  backPath: string;
  /** That same list state, to hand on to the new record's own back link. */
  returnTo?: string;
  fields: PluginResourceField[];
  columnTypes?: Record<string, PluginColumnType>;
  /** Declared numeric bounds, so a new row's inputs carry min/max like an edit's. */
  columnBounds?: Record<string, { min?: number; max?: number }>;
  labels: ResourceFormLabels;
}) {
  const router = useRouter();

  return (
    <ResourceForm
      pluginKey={pluginKey}
      resourceKey={resourceKey}
      fields={fields}
      columnTypes={columnTypes}
      columnBounds={columnBounds}
      row={null}
      labels={labels}
      onSaved={(id) => {
        router.push(
          id ? withReturnTo(`${basePath}/${encodeURIComponent(id)}`, returnTo) : backPath,
        );
        router.refresh();
      }}
      onCancel={() => router.push(backPath)}
    />
  );
}
