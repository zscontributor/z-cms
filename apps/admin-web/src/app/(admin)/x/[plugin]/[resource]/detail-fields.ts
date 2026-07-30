import type { PluginResourceDescriptor } from "@/lib/api";

/** Columns the platform owns on every plugin table — shown apart, at the bottom. */
export const SYSTEM_COLUMNS = ["id", "created_at", "updated_at"] as const;

/** Columns that exist on every row and say nothing about the record. */
const HIDDEN_COLUMNS = ["tenant_id", "site_id"] as const;

export interface DetailField {
  column: string;
  label: string;
  input?: string;
}

/**
 * Which of a record's columns the detail screen shows, and in what order.
 *
 * Declared form fields first, in the plugin's own order, then any list column the
 * form leaves out — a resource may be read-only (no form at all) and still have a
 * list, and that list is then the only description of its columns anyone declared.
 *
 * Columns the plugin declared in NEITHER place are deliberately not shown. The row
 * arrives from `SELECT *`, so they are in hand; but a plugin that surfaced a column
 * nowhere in its admin has chosen not to put it on screen, and inventing that
 * exposure here would quietly widen what "the admin screens" means for every
 * already-published plugin. `tenant_id` and `site_id` are dropped for that reason
 * plus a duller one: they are the same two values on every row of the screen.
 *
 * A column declared in both places keeps the form's label and position — the form
 * label is the longer, more explanatory one ("Patient name" over "Patient"), and a
 * detail screen has room for it.
 */
export function detailFields(descriptor: PluginResourceDescriptor): DetailField[] {
  const out: DetailField[] = [];
  const seen = new Set<string>([...SYSTEM_COLUMNS, ...HIDDEN_COLUMNS]);

  for (const field of descriptor.form?.fields ?? []) {
    if (seen.has(field.column)) continue;
    seen.add(field.column);
    out.push({ column: field.column, label: field.label, input: field.input });
  }
  for (const column of descriptor.list.columns) {
    if (seen.has(column.column)) continue;
    seen.add(column.column);
    out.push({ column: column.column, label: column.label });
  }
  return out;
}
