"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { PluginResourceDescriptor, PluginRow, PluginSortDirection } from "@/lib/api";
import { deletePluginRowAction, updatePluginRowAction } from "@/app/actions/plugin-admin";
import { Button, LinkButton } from "@/components/ui/button";
import { EmptyState, TBody, TD, TH, THead, TR, Table } from "@/components/ui/table";
import { useLocale } from "@/lib/i18n-provider";
import { withReturnTo } from "@/lib/return-to";
import { formatCell } from "./format-cell";
import { sortHref } from "./list-url";

/** What a screen reader is told about the sorted column. */
const SORT_ARIA: Record<PluginSortDirection, "ascending" | "descending"> = {
  asc: "ascending",
  desc: "descending",
};

/**
 * The dropdown an editable cell becomes.
 *
 * Deliberately a bare `<select>` rather than the admin's `Select`: a table cell is
 * not a form field, and the bordered control the form uses turns a dense list into
 * a wall of boxes. It reads as text until you go near it, which is the behaviour
 * of every spreadsheet anyone has used.
 *
 * A value the row holds but the plugin no longer offers keeps its own option, so a
 * status retired from the manifest still shows what the row actually says instead
 * of silently displaying the first choice in the list.
 */
function InlineSelect({
  options,
  value,
  disabled,
  onPick,
}: {
  options: Array<{ value: string; label: string }>;
  value: string;
  disabled?: boolean;
  onPick: (value: string) => void;
}) {
  const known = options.some((option) => option.value === value);
  return (
    <select
      className="-mx-1 max-w-full cursor-pointer rounded-md border border-transparent bg-transparent px-1 py-0.5 text-sm hover:border-[var(--border)] hover:bg-[var(--surface-sunken)] focus:border-[var(--border)] disabled:cursor-wait disabled:opacity-60"
      value={value}
      disabled={disabled}
      onChange={(e) => onPick(e.target.value)}
    >
      {value && !known ? <option value={value}>{value}</option> : null}
      {!value ? <option value="" /> : null}
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

interface Props {
  pluginKey: string;
  resourceKey: string;
  descriptor: PluginResourceDescriptor;
  rows: PluginRow[];
  canWrite: boolean;
  /** The ordering the server applied, or null when the resource declares none. */
  order: { column: string; direction: PluginSortDirection } | null;
  labels: {
    new: string;
    view: string;
    delete: string;
    empty: string;
    confirmDelete: string;
    actions: string;
    sortAsc: string;
    sortDesc: string;
  };
}

export function ResourcePanel({
  pluginKey,
  resourceKey,
  descriptor,
  rows,
  canWrite,
  order,
  labels,
}: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const locale = useLocale();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const basePath = `/x/${encodeURIComponent(pluginKey)}/${encodeURIComponent(resourceKey)}`;

  /** See list-url.ts — the toggle rules live there, tested, not inline here. */
  const headerHref = (column: string) =>
    sortHref({ pathname, search: params.toString(), column, order });

  /**
   * Where a record opens. Editing moved to the record's own screen: an inline form
   * above the table asked the reader to hold the row they clicked in their head
   * while looking at a form that no longer showed it, and it could not show a
   * column the plugin left out of its form at all. A row with no id cannot be
   * addressed, so it stays plain text rather than becoming a link to nowhere.
   *
   * The link carries this list's query string, so the record's "back to list" can
   * return to the page, ordering and filters the reader left — not to a fresh
   * first page.
   */
  const detailPath = (row: PluginRow): string | null =>
    row.id === null || row.id === undefined
      ? null
      : withReturnTo(`${basePath}/${encodeURIComponent(String(row.id))}`, params.toString());

  /**
   * Change one cell from the list — an order moving from "new" to "preparing".
   *
   * A PATCH of that single column, through the same action and therefore the same
   * permission check and the same plugin `admin.record.changed` hook as the record
   * form. The alternative was to open the record, change one dropdown, save, and
   * come back to find your place in the list again, dozens of times a shift.
   *
   * The row is not updated locally on success — `router.refresh()` re-reads it, so
   * whatever the plugin's own hook did in reaction (a total recomputed, a stock
   * balance moved) shows up too. Optimism here would show a status the server
   * agreed with beside figures it had already changed.
   */
  function setCell(row: PluginRow, column: string, value: string) {
    setError(null);
    startTransition(async () => {
      const result = await updatePluginRowAction(pluginKey, resourceKey, String(row.id), {
        [column]: value || null,
      });
      if (result.ok) router.refresh();
      else setError(result.error);
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
          {/* A link, not a toggle: creating happens on its own screen now, so the
              form has a URL, a heading and a way back — see new/page.tsx. The
              list's state rides along, so cancelling returns to this page of it. */}
          <LinkButton href={withReturnTo(`${basePath}/new`, params.toString())} variant="primary">
            {labels.new}
          </LinkButton>
        </div>
      )}

      {error && (
        <div className="z-card border-red-300 bg-red-50 px-4 py-2 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-300">
          {error}
        </div>
      )}

      {rows.length === 0 ? (
        <div className="z-card">
          {/* An empty table is where someone is most likely to want the form, and
              the button at the top is the far corner of an otherwise blank screen. */}
          <EmptyState
            title={labels.empty}
            action={
              canWrite && descriptor.form ? (
                <LinkButton
                  href={withReturnTo(`${basePath}/new`, params.toString())}
                  variant="primary"
                  size="sm"
                >
                  {labels.new}
                </LinkButton>
              ) : null
            }
          />
        </div>
      ) : (
        <Table>
          <THead>
            <TR>
              {descriptor.list.columns.map((c) => {
                const active = order?.column === c.column;
                return (
                  <TH key={c.column} aria-sort={active ? SORT_ARIA[order.direction] : "none"}>
                    <Link
                      href={headerHref(c.column)}
                      className="inline-flex items-center gap-1 hover:text-brand-600 dark:hover:text-brand-400"
                      title={active && order.direction === "asc" ? labels.sortDesc : labels.sortAsc}
                    >
                      {c.label}
                      {/* Only the sorted column carries a mark: an arrow on every
                          header says nothing about which one is in effect. */}
                      {active ? (
                        <span aria-hidden="true" className="text-[10px]">
                          {order.direction === "asc" ? "▲" : "▼"}
                        </span>
                      ) : null}
                    </Link>
                  </TH>
                );
              })}
              <TH className="w-32 text-right">{labels.actions}</TH>
            </TR>
          </THead>
          <TBody>
            {rows.map((row, i) => {
              const href = detailPath(row);
              return (
                <TR key={String(row.id ?? i)}>
                  {descriptor.list.columns.map((c, index) => (
                    <TD key={c.column}>
                      {/* The first column is the record's handle, the same way an
                          order number opens an order. Every other cell stays text
                          so a long value is selectable rather than a drag target —
                          unless the plugin marked it editable, which is the whole
                          point of the ones that get changed all day. */}
                      {index === 0 && href ? (
                        <Link
                          href={href}
                          className="font-medium hover:text-brand-600 dark:hover:text-brand-400"
                        >
                          {formatCell(row[c.column], locale, descriptor.columnTypes?.[c.column])}
                        </Link>
                      ) : c.editOptions && canWrite && row.id != null ? (
                        <InlineSelect
                          options={c.editOptions}
                          value={row[c.column] == null ? "" : String(row[c.column])}
                          disabled={pending}
                          onPick={(next) => setCell(row, c.column, next)}
                        />
                      ) : (
                        formatCell(row[c.column], locale, descriptor.columnTypes?.[c.column])
                      )}
                    </TD>
                  ))}
                  <TD className="text-right">
                    <div className="flex justify-end gap-1">
                      {href && (
                        <Link
                          href={href}
                          className="rounded-md px-2 py-1 text-xs font-medium text-brand-600 hover:bg-[var(--surface-sunken)] dark:text-brand-400"
                        >
                          {labels.view}
                        </Link>
                      )}
                      {canWrite && descriptor.form && (
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={() => remove(row)}
                          disabled={pending}
                        >
                          {labels.delete}
                        </Button>
                      )}
                    </div>
                  </TD>
                </TR>
              );
            })}
          </TBody>
        </Table>
      )}
    </div>
  );
}
