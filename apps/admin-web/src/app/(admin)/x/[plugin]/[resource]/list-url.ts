import type { PluginSortDirection } from "@/lib/api";

/**
 * Where a column header points, given what the list is sorted by now.
 *
 * Pure, and separate from the component, because the rules are small but each one
 * is a bug when it is wrong and none of them is visible in a screenshot: clicking
 * the sorted column must reverse it, clicking another must start it ascending
 * (the direction a reader assumes when they did not ask), and either must drop
 * `page` — row 1 of a re-sorted list is somewhere else entirely, so keeping page 5
 * shows a slice of a set whose beginning the reader never saw.
 *
 * `dir` is omitted for ascending rather than written out: ascending is what the
 * server does with no direction, and a link is easier to read for carrying only
 * what changes the answer.
 */
export function sortHref({
  pathname,
  search,
  column,
  order,
}: {
  pathname: string;
  /** The current query string, without the leading "?". */
  search: string;
  column: string;
  order: { column: string; direction: PluginSortDirection } | null;
}): string {
  const next = new URLSearchParams(search);
  next.delete("page");

  const reversing = order?.column === column && order.direction === "asc";
  next.set("sort", column);
  if (reversing) next.set("dir", "desc");
  else next.delete("dir");

  const query = next.toString();
  return query ? `${pathname}?${query}` : pathname;
}
