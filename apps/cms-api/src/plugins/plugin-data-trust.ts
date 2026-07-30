/**
 * Relational data is available only to packages whose executable payload passed
 * a platform trust gate:
 *
 * - BUILTIN is pinned to the first-party signing key.
 * - MARKETPLACE is publisher-signed, reviewed and registry-counter-signed.
 * - SIDELOAD is operator code and deliberately does not gain schema/DDL access.
 *
 * Names, columns, DDL, RPC calls and every row remain independently validated and
 * tenant/site scoped. This answers only whether a package may enter that path.
 */
export function canOwnPluginTables(origin: string | null | undefined): boolean {
  return origin === "BUILTIN" || origin === "MARKETPLACE";
}
