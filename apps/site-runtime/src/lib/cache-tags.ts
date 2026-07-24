/**
 * Cache tags are the contract between cms-api's publish hook and this runtime's
 * cache. They are derived from (hostname, path) — the only two things both sides
 * know without another round trip: the API knows a site's hostnames from the
 * Domain table, and the runtime knows the hostname before it knows the site id.
 *
 * Publishing a page purges `pageTag`; changing menus, theme settings or anything
 * that appears in the site chrome purges `siteTag`, which drops every page of it.
 */

/** Everything rendered for one hostname. */
export function siteTag(hostname: string): string {
  return `site:${normaliseHostname(hostname)}`;
}

/** One URL of one hostname (all paginated variants of it included). */
export function pageTag(hostname: string, path: string): string {
  return `page:${normaliseHostname(hostname)}:${normalisePath(path)}`;
}

export function renderTags(hostname: string, path: string): string[] {
  return [siteTag(hostname), pageTag(hostname, path)];
}

/** Hostnames are case-insensitive; the port is part of the identity in dev. */
export function normaliseHostname(hostname: string): string {
  return hostname.trim().toLowerCase();
}

/** "" and "blog/x" both become "/blog/x"-shaped: a leading slash, no trailing one. */
export function normalisePath(path: string): string {
  const withSlash = path.startsWith("/") ? path : `/${path}`;
  const trimmed = withSlash.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
}
