import type { PluginResourceDescriptor } from "@/lib/api";

export interface FilterableColumn {
  column: string;
  label: string;
  kind: "select" | "boolean";
  /** For `select`: the values the plugin declared. Empty for a boolean. */
  options: Array<{ value: string; label: string }>;
}

/**
 * Which columns get a dropdown, and what goes in it.
 *
 * A dropdown is only honest where the set of values is knowable, so the source is
 * the form field the plugin declared for that column: a `select` brings its own
 * options, a `boolean` brings yes/no. A free-text column has no exhaustive list and
 * gets the search box instead — offering a dropdown of the values that happen to be
 * on this page would quietly claim there are no others.
 *
 * The column must also be one the resource LISTS. The screen does not show what the
 * plugin left out of its list, and a filter is a lens on what is shown; sifting a
 * table by a column the reader cannot see is a way to learn its contents sideways.
 *
 * This mirrors a rule the endpoint applies too, and the endpoint is the authority —
 * it drops any filter it did not declare, so a hand-written URL cannot filter by
 * something this function would have refused to draw.
 */
export function filterableColumns(descriptor: PluginResourceDescriptor): FilterableColumn[] {
  const listed = new Set(descriptor.list.columns.map((column) => column.column));

  return (descriptor.form?.fields ?? [])
    .filter(
      (field) =>
        listed.has(field.column) && (field.input === "select" || field.input === "boolean"),
    )
    .map((field) => ({
      column: field.column,
      label: field.label,
      kind: field.input === "boolean" ? ("boolean" as const) : ("select" as const),
      options: field.input === "select" ? (field.options ?? []) : [],
    }));
}
