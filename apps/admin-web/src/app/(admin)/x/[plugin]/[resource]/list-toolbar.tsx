"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Input, Select } from "@/components/ui/field";
import type { FilterableColumn } from "./filterable";

/** The sizes on offer. 100 is the server's cap, so nothing here can exceed it. */
const PAGE_SIZES = [20, 50, 100] as const;

export interface ToolbarLabels {
  search: string;
  searchPlaceholder: string;
  perPage: string;
  all: string;
  yes: string;
  no: string;
}

/**
 * Search, filters and page size — all of them kept in the URL.
 *
 * In the URL rather than in component state because they belong to the *link*: a
 * colleague sent "the unconfirmed requests I am looking at" should see the same
 * rows, and a reload after saving a record should not silently return to the
 * unfiltered first page. Every control drops `page` when it changes, because page 7
 * of one result set is not page 7 of another and keeping the number lands the reader
 * past the end.
 *
 * Which columns get a dropdown is decided by `filterableColumns`, from the plugin's
 * own declaration — this component draws what it is handed and invents nothing.
 */
export function ListToolbar({
  perPage,
  searchable,
  filters,
  columns,
  labels,
}: {
  perPage: number;
  /** Whether a search box is worth drawing at all (no text columns ⇒ nothing to search). */
  searchable: boolean;
  /** The filters currently applied, as the server echoed them back. */
  filters: Record<string, unknown>;
  columns: FilterableColumn[];
  labels: ToolbarLabels;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [term, setTerm] = useState(params.get("q") ?? "");

  // The box follows the URL, so Back and a cleared filter both leave it consistent
  // with the rows on screen.
  useEffect(() => {
    setTerm(params.get("q") ?? "");
  }, [params]);

  function push(next: URLSearchParams) {
    next.delete("page");
    const query = next.toString();
    router.push(query ? `${pathname}?${query}` : pathname);
  }

  function onSearch(event: React.FormEvent) {
    event.preventDefault();
    const next = new URLSearchParams(params.toString());
    const trimmed = term.trim();
    if (trimmed) next.set("q", trimmed);
    else next.delete("q");
    push(next);
  }

  function onFilter(column: string, value: string) {
    const next = new URLSearchParams(params.toString());
    // "All" is the absence of a filter, not a value of one.
    if (value) next.set(`f.${column}`, value);
    else next.delete(`f.${column}`);
    push(next);
  }

  function onPerPage(value: string) {
    const next = new URLSearchParams(params.toString());
    // The default needs no parameter: a URL that says nothing gets the default, and
    // a link is easier to read for not carrying it.
    if (value === String(PAGE_SIZES[0])) next.delete("perPage");
    else next.set("perPage", value);
    push(next);
  }

  const current = (column: string): string => {
    const value = filters[column];
    if (value === undefined || value === null) return "";
    return typeof value === "boolean" ? String(value) : String(value);
  };

  return (
    <div className="mb-3 flex flex-wrap items-center gap-2">
      {searchable && (
        <form onSubmit={onSearch}>
          <Input
            type="search"
            value={term}
            onChange={(event) => setTerm(event.target.value)}
            placeholder={labels.searchPlaceholder}
            aria-label={labels.search}
            className="h-8 w-64 py-1 text-xs"
          />
        </form>
      )}

      {columns.map((column) => (
        <Select
          key={column.column}
          aria-label={column.label}
          value={current(column.column)}
          onChange={(event) => onFilter(column.column, event.target.value)}
          className="h-8 w-44 py-1 text-xs"
        >
          <option value="">
            {column.label} · {labels.all}
          </option>
          {column.kind === "boolean" ? (
            <>
              <option value="true">{labels.yes}</option>
              <option value="false">{labels.no}</option>
            </>
          ) : (
            column.options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))
          )}
        </Select>
      ))}

      <span className="ml-auto flex items-center gap-2 text-[11px] z-muted">
        {labels.perPage}
        <Select
          aria-label={labels.perPage}
          value={String(
            PAGE_SIZES.includes(perPage as (typeof PAGE_SIZES)[number]) ? perPage : PAGE_SIZES[0],
          )}
          onChange={(event) => onPerPage(event.target.value)}
          className="h-8 w-20 py-1 text-xs"
        >
          {PAGE_SIZES.map((size) => (
            <option key={size} value={size}>
              {size}
            </option>
          ))}
        </Select>
      </span>
    </div>
  );
}
