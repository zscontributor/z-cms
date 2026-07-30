"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { PluginResourceField, PluginRow } from "@/lib/api";
import { deletePluginRowAction } from "@/app/actions/plugin-admin";
import { Button } from "@/components/ui/button";
import { ResourceForm } from "../resource-form";

/**
 * Edit and delete, for the record you are looking at.
 *
 * Editing happens on this screen rather than back on the list: the form and the
 * record it changes belong on the same page, and a save that returns you to a table
 * makes you find the row again to check what you just wrote. Delete leaves — there
 * is no record left to be on.
 */
export function RecordActions({
  pluginKey,
  resourceKey,
  listPath,
  fields,
  row,
  labels,
}: {
  pluginKey: string;
  resourceKey: string;
  listPath: string;
  fields: PluginResourceField[];
  row: PluginRow;
  labels: {
    edit: string;
    delete: string;
    save: string;
    cancel: string;
    confirmDelete: string;
  };
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function remove() {
    if (!window.confirm(labels.confirmDelete)) return;
    setError(null);
    startTransition(async () => {
      const result = await deletePluginRowAction(pluginKey, resourceKey, String(row.id));
      if (result.ok) {
        // Back to the list, and refresh it: the row this screen was showing is gone,
        // so staying here would render a record that no longer exists.
        router.push(listPath);
        router.refresh();
      } else {
        setError(result.error);
      }
    });
  }

  if (editing) {
    return (
      <ResourceForm
        pluginKey={pluginKey}
        resourceKey={resourceKey}
        fields={fields}
        row={row}
        labels={{ save: labels.save, cancel: labels.cancel }}
        onSaved={() => {
          setEditing(false);
          router.refresh();
        }}
        onCancel={() => setEditing(false)}
      />
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {error && (
        <div className="z-card border-red-300 bg-red-50 px-4 py-2 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-300">
          {error}
        </div>
      )}
      <div className="flex gap-2">
        <Button type="button" onClick={() => setEditing(true)} disabled={pending}>
          {labels.edit}
        </Button>
        <Button type="button" variant="ghost" onClick={remove} disabled={pending}>
          {labels.delete}
        </Button>
      </div>
    </div>
  );
}
