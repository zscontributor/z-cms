"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { PluginResourceDescriptor, PluginRow, PluginSortDirection } from "@/lib/api";
import { deletePluginRowAction } from "@/app/actions/plugin-admin";
import { Button } from "@/components/ui/button";
import { EmptyState, TBody, TD, TH, THead, TR, Table } from "@/components/ui/table";
import { useLocale } from "@/lib/i18n-provider";
import { formatCell } from "./format-cell";
import { sortHref } from "./list-url";
import { ResourceForm } from "./resource-form";

/** What a screen reader is told about the sorted column. */
const SORT_ARIA: Record<PluginSortDirection, "ascending" | "descending"> = {
  asc: "ascending",
  desc: "descending",
};

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
    edit: string;
    delete: string;
    save: string;
    cancel: string;
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
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fields = descriptor.form?.fields ?? [];
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
   */
  const detailPath = (row: PluginRow): string | null =>
    row.id === null || row.id === undefined ? null : `${basePath}/${encodeURIComponent(String(row.id))}`;

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
          <Button type="button" onClick={() => setCreating(true)} disabled={pending || creating}>
            {labels.new}
          </Button>
        </div>
      )}

      {error && (
        <div className="z-card border-red-300 bg-red-50 px-4 py-2 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-300">
          {error}
        </div>
      )}

      {creating && (
        <ResourceForm
          pluginKey={pluginKey}
          resourceKey={resourceKey}
          fields={fields}
          row={null}
          labels={{ save: labels.save, cancel: labels.cancel }}
          onSaved={() => {
            setCreating(false);
            router.refresh();
          }}
          onCancel={() => setCreating(false)}
        />
      )}

      {rows.length === 0 ? (
        <div className="z-card">
          <EmptyState title={labels.empty} />
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
                          so a long value is selectable rather than a drag target. */}
                      {index === 0 && href ? (
                        <Link
                          href={href}
                          className="font-medium hover:text-brand-600 dark:hover:text-brand-400"
                        >
                          {formatCell(row[c.column], locale)}
                        </Link>
                      ) : (
                        formatCell(row[c.column], locale)
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
