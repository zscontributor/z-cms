/**
 * Where a record screen came back to.
 *
 * A list keeps its whole state in the URL — page, search, filters, ordering, page
 * size — so "back to the list" means back to *that* URL, not to its first page.
 * Opening the third record on page 5 of a filtered list and pressing back used to
 * land the reader on page 1 with nothing filtered, and finding the row again was
 * their problem. So every link into a record carries the list's query string in
 * one opaque `from` parameter, and the back link puts it back.
 *
 * It is a parameter rather than `router.back()` because a record screen is a real
 * URL: it can be arrived at from a bookmark, a notification or a reload, and
 * history-based back would then leave the admin entirely. With no `from` the back
 * link still works — it just goes to the list's default state.
 */
export const RETURN_PARAM = "from";

/**
 * A link into a record, carrying the list state to return to.
 *
 * `withReturnTo("/x/crm/leads/42", "page=5&q=ann")`
 *   → `/x/crm/leads/42?from=page%3D5%26q%3Dann`
 */
export function withReturnTo(href: string, search: string | undefined): string {
  const query = normalize(search);
  if (!query) return href;
  return `${href}${href.includes("?") ? "&" : "?"}${RETURN_PARAM}=${encodeURIComponent(query)}`;
}

/** The list URL to go back to: its path, in the state the reader left it in. */
export function returnHref(listPath: string, from: string | string[] | undefined): string {
  const raw = Array.isArray(from) ? from[0] : from;
  const query = normalize(raw);
  return query ? `${listPath}?${query}` : listPath;
}

/** `{ page: "5", q: "ann", status: undefined }` → `page=5&q=ann`. */
export function searchOf(params: Record<string, string | string[] | undefined>): string {
  const out = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (key === RETURN_PARAM) continue;
    if (typeof value === "string" && value !== "") out.set(key, value);
    else if (Array.isArray(value)) for (const item of value) out.append(key, item);
  }
  return out.toString();
}

/**
 * Re-parsing and re-serialising is what makes `from` safe to trust: whatever it
 * held comes back out as escaped `key=value` pairs, so it can only ever become a
 * query string on the list path it is read for — never another path, never
 * another host — and it cannot nest a second `from` inside itself.
 */
function normalize(search: string | undefined): string {
  if (!search) return "";
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  params.delete(RETURN_PARAM);
  return params.toString();
}
