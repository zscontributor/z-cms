/**
 * The rule: a plugin may never touch the core schema, and any table it owns
 * carries its own prefix.
 *
 * Persistence for a plugin is `ctx.storage` — a key/value space in `plugin_data`,
 * namespaced to (plugin, site) and stamped from the plugin's token, not from
 * anything the plugin says. That covers the overwhelming majority of plugins, and
 * a plugin that only uses it cannot reach the core schema because it has no
 * database handle at all: the runtime process holds no `DATABASE_URL`.
 *
 * A few plugins genuinely need relational tables — an analytics plugin with
 * millions of rows should not be storing them as JSON blobs. Those get real
 * tables, and the two laws below are what keep them from becoming the thing that
 * makes upgrading Z-CMS impossible:
 *
 *   1. A plugin never alters, drops or migrates a core table. Not "should not" —
 *      it is not granted the privilege to.
 *   2. Every table a plugin creates is named with the prefix derived from its own
 *      id, so ownership is legible from the name alone, and two plugins can never
 *      collide.
 *
 * Why the prefix is derived rather than declared: a plugin that got to pick its
 * own prefix would pick `content_`, and the rule would be back to trusting the
 * plugin. It is a pure function of the plugin id, which the marketplace already
 * guarantees is unique.
 */

/** Postgres truncates identifiers at 63 bytes; a name longer than this is a bug. */
const MAX_IDENTIFIER_LENGTH = 63;

/**
 * The prefix every table of a plugin must start with.
 *
 *   "vn.zsoft.plugin.seo"  ->  "p_vn_zsoft_plugin_seo__"
 *
 * Derived from the full reverse-DNS id, not from its last segment: two publishers
 * are entitled to both ship a plugin called "seo", and they must not end up
 * fighting over the same table name.
 */
export function pluginTablePrefix(pluginId: string): string {
  const slug = pluginId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

  return `p_${slug}__`;
}

export interface PluginTableViolation {
  table: string;
  reason: "missing-prefix" | "too-long" | "invalid-name";
}

/**
 * Checks a plugin's declared tables against the two laws.
 *
 * Called when a plugin is installed on a site — before it has run a single line
 * of code. A plugin that declares `content` or `users` is rejected there, which
 * is the only moment at which rejecting it is cheap.
 */
export function validatePluginTables(
  pluginId: string,
  tables: readonly string[] | undefined,
): PluginTableViolation[] {
  if (!tables?.length) return [];

  const prefix = pluginTablePrefix(pluginId);
  const violations: PluginTableViolation[] = [];

  for (const table of tables) {
    if (!/^[a-z_][a-z0-9_]*$/.test(table)) {
      violations.push({ table, reason: "invalid-name" });
      continue;
    }

    if (!table.startsWith(prefix)) {
      violations.push({ table, reason: "missing-prefix" });
      continue;
    }

    if (table.length > MAX_IDENTIFIER_LENGTH) {
      // Postgres would silently truncate, and two tables that differ only past
      // byte 63 would become the same table.
      violations.push({ table, reason: "too-long" });
    }
  }

  return violations;
}

/** True when `table` belongs to `pluginId` by name alone. */
export function isPluginTable(pluginId: string, table: string): boolean {
  return table.startsWith(pluginTablePrefix(pluginId));
}
