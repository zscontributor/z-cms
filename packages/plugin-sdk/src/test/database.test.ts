import { describe, expect, it } from "vitest";
import { isPluginTable, pluginTablePrefix, validatePluginTables } from "../database";

/**
 * This file is the tenant/plugin isolation boundary. A plugin that owns relational
 * tables is the ONE place plugin-controlled metadata touches the core Postgres
 * schema, so "every table you name starts with the prefix derived from your id"
 * is load-bearing: if it can be bypassed, a plugin reaches `users` or another
 * plugin's rows. `verify-tables.ts` is the standalone attack script; this is the
 * unit-level version of the same adversary, plus the cases it does not cover.
 */

const PLUGIN = "vn.zsoft.plugin.seo";
const PREFIX = pluginTablePrefix(PLUGIN);

/** A table is refused iff validatePluginTables returns at least one violation. */
function refused(tables: string[], plugin = PLUGIN): boolean {
  return validatePluginTables(plugin, tables).length > 0;
}

describe("pluginTablePrefix", () => {
  it("derives a prefix from the whole reverse-DNS id, not its last segment", () => {
    // Two publishers may both ship a plugin whose last segment is "seo"; deriving
    // from the full id is what keeps them from fighting over one table name.
    expect(pluginTablePrefix("vn.zsoft.plugin.seo")).toBe("p_vn_zsoft_plugin_seo__");
  });

  it("gives two different plugin ids two different prefixes", () => {
    expect(pluginTablePrefix("vn.zsoft.plugin.seo")).not.toBe(
      pluginTablePrefix("vn.evil.plugin.seo"),
    );
  });

  it("normalises case and punctuation so the prefix is a pure function of the id", () => {
    // The prefix is derived, never declared: an attacker cannot pick "content_".
    // Case and separators must collapse deterministically or the same plugin
    // could be handed two prefixes on two installs.
    expect(pluginTablePrefix("VN.ZSoft.Plugin.SEO")).toBe(pluginTablePrefix("vn.zsoft.plugin.seo"));
  });

  it("collapses any run of non-alphanumeric characters to a single underscore", () => {
    expect(pluginTablePrefix("a..b--c  d")).toBe("p_a_b_c_d__");
  });

  it("trims leading and trailing separators so the prefix never has a stray underscore", () => {
    expect(pluginTablePrefix("...seo...")).toBe("p_seo__");
  });

  it("ends every prefix with a double underscore, the boundary that makes startsWith safe", () => {
    // The "__" terminator is what stops one plugin's prefix from being a prefix of
    // another's ("p_seo__" vs "p_seo_extra__"): see the collision test below.
    expect(pluginTablePrefix("anything")).toMatch(/__$/);
  });
});

describe("validatePluginTables", () => {
  it("accepts the plugin's own, correctly prefixed tables", () => {
    // A validator that rejects everything is an outage, not a guard.
    expect(refused([`${PREFIX}metadata`, `${PREFIX}sitemap_entries`])).toBe(false);
  });

  it("accepts a plugin that declares no tables at all", () => {
    // The common case: `ctx.storage` is the normal answer and `database` is absent.
    expect(validatePluginTables(PLUGIN, undefined)).toEqual([]);
    expect(validatePluginTables(PLUGIN, [])).toEqual([]);
  });

  it("refuses a core table named directly", () => {
    // ATTACK: the whole point — a plugin trying to own `users` or `contents`.
    expect(refused(["users"])).toBe(true);
    expect(refused(["contents"])).toBe(true);
    expect(validatePluginTables(PLUGIN, ["users"])[0]?.reason).toBe("missing-prefix");
  });

  it("refuses a Postgres catalog table", () => {
    // ATTACK: `pg_authid` holds password hashes. It has no plugin prefix, so the
    // same rule that blocks `users` blocks it.
    expect(refused(["pg_authid"])).toBe(true);
  });

  it("refuses a name that merely CONTAINS the prefix instead of starting with it", () => {
    // ATTACK: the near-miss an `includes()` check would wave through. The prefix
    // must be at the START, or `evil_<prefix>data` — an attacker-owned table
    // dressed up to look prefixed — gets in.
    expect(refused([`evil_${PREFIX}data`])).toBe(true);
  });

  it("refuses another plugin's prefix reached by naming it directly", () => {
    // ATTACK: cross-plugin reach. Plugin A naming plugin B's table to read B's
    // rows. B's prefix is not A's, so it is missing-prefix from A's point of view.
    const anotherPluginsTable = pluginTablePrefix("vn.evil.plugin.x") + "loot";

    expect(refused([anotherPluginsTable])).toBe(true);
  });

  it("does not let one plugin's prefix be a prefix of another's", () => {
    // ATTACK: "p_seo__" must NOT be accepted for a plugin whose prefix is
    // "p_seo_pro__". The trailing "__" is what prevents this — assert the shorter
    // plugin cannot claim a table that belongs under the longer one's namespace.
    const shortPrefix = pluginTablePrefix("seo");
    const longPluginTable = pluginTablePrefix("seo_pro") + "data";

    // The "seo" plugin cannot own a table sitting under "seo_pro"'s prefix.
    expect(refused([longPluginTable], "seo")).toBe(true);
  });

  it("refuses an identifier carrying an SQL injection payload", () => {
    // ATTACK: a table name that is really a statement. The character class
    // `[a-z_][a-z0-9_]*` has no room for a quote, a semicolon or a space, so the
    // payload is rejected as an invalid name before it is ever concatenated.
    expect(refused([`${PREFIX}x"; DROP TABLE users; --`])).toBe(true);
    expect(validatePluginTables(PLUGIN, [`${PREFIX}x"; DROP TABLE users; --`])[0]?.reason).toBe(
      "invalid-name",
    );
  });

  it("refuses a backtick-quoted identifier", () => {
    // ATTACK: MySQL-style quoting to smuggle in characters. Backticks are not in
    // the allowed class.
    expect(refused(["`" + PREFIX + "audit`"])).toBe(true);
  });

  it("refuses a double-quoted / mixed-case identifier", () => {
    // ATTACK: Postgres treats "Users" (quoted) as a distinct, case-sensitive
    // identifier. The validator only allows lower-case unquoted names, so the
    // quoting trick is refused outright.
    expect(refused([`"${PREFIX}Audit"`])).toBe(true);
  });

  it("refuses a schema-qualified name reaching into another schema", () => {
    // ATTACK: `public.users` — the dot would let a plugin address a table outside
    // its namespace. A dot is not in the allowed character class.
    expect(refused(["public.users"])).toBe(true);
  });

  it("refuses a name Postgres would truncate into a collision", () => {
    // ATTACK: Postgres truncates identifiers at 63 bytes, so two names differing
    // only past byte 63 become the SAME table. A correctly-prefixed but over-long
    // name could be crafted to truncate onto another table; length must be checked
    // even AFTER the prefix passes.
    const overLong = PREFIX + "a".repeat(80);

    expect(refused([overLong])).toBe(true);
    expect(validatePluginTables(PLUGIN, [overLong])[0]?.reason).toBe("too-long");
  });

  it("checks a name for a valid shape BEFORE checking its prefix", () => {
    // Order matters for the error message: an injection payload should be reported
    // as invalid-name (the real problem), not as missing-prefix (a distraction).
    const violation = validatePluginTables(PLUGIN, ["'; DROP TABLE users; --"])[0];

    expect(violation?.reason).toBe("invalid-name");
  });

  it("refuses an empty table name", () => {
    // An empty identifier matches neither the name pattern nor the prefix.
    expect(refused([""])).toBe(true);
  });

  it("reports every violating table, not just the first", () => {
    // Install-time feedback: an author fixing their manifest wants the whole list,
    // and a single-violation short-circuit would hide the rest.
    const violations = validatePluginTables(PLUGIN, ["users", `${PREFIX}ok`, "contents"]);

    expect(violations.map((v) => v.table)).toEqual(["users", "contents"]);
  });
});

describe("isPluginTable", () => {
  it("recognises a table that belongs to the plugin by name alone", () => {
    expect(isPluginTable(PLUGIN, `${PREFIX}metadata`)).toBe(true);
  });

  it("denies ownership of a core table", () => {
    expect(isPluginTable(PLUGIN, "users")).toBe(false);
  });

  it("denies ownership of another plugin's table", () => {
    // The runtime uses this to decide whether a plugin may touch a table at all;
    // it must never say yes to a neighbour's rows.
    const othersTable = pluginTablePrefix("vn.other.plugin") + "data";

    expect(isPluginTable(PLUGIN, othersTable)).toBe(false);
  });

  it("denies ownership of a name that only contains the prefix in the middle", () => {
    // Same near-miss as validate: ownership is startsWith, never includes.
    expect(isPluginTable(PLUGIN, `evil_${PREFIX}data`)).toBe(false);
  });
});
