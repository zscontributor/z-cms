import { pluginTablePrefix, validatePluginTables } from "./database";

/**
 * Attacks the plugin table-ownership rule.
 *
 * A plugin that owns relational tables is the one place plugin metadata reaches
 * the core schema, so the rule — "every table you name must start with the prefix
 * derived from your plugin id" — is load-bearing. It was enforced but never
 * attacked, which is the same as saying it was believed rather than known.
 *
 * The interesting cases are not "contents" (obvious). They are the near-misses:
 * a prefix that is a *prefix of another plugin's prefix*, a name Postgres would
 * silently truncate into a collision, an identifier carrying SQL.
 */

const PLUGIN = "vn.zsoft.plugin.seo";
const PREFIX = pluginTablePrefix(PLUGIN);

let failures = 0;
function check(name: string, passed: boolean, detail: string) {
  console.log(`  ${passed ? "PASS" : "FAIL"}  ${name}\n        ${detail}`);
  if (!passed) failures++;
}

function rejects(tables: string[]): { rejected: boolean; reasons: string } {
  const violations = validatePluginTables(PLUGIN, tables);
  return {
    rejected: violations.length > 0,
    reasons: violations.map((v) => `${v.table}: ${v.reason}`).join(", ") || "(accepted)",
  };
}

function main() {
  console.log("\nPlugin table verification — attacking the ownership rule\n");
  console.log(`  prefix for ${PLUGIN} = "${PREFIX}"\n`);

  for (const [name, tables] of [
    ["a core table", ["contents"]],
    ["the users table", ["users"]],
    ["a Postgres catalog table", ["pg_authid"]],
    // The near-miss: a name that merely CONTAINS the prefix rather than starting
    // with it. A `includes()` check instead of `startsWith()` would let this in.
    ["prefix in the middle", [`evil_${PREFIX}data`]],
    // Another plugin's namespace, reached by naming it directly.
    ["another plugin's prefix", [pluginTablePrefix("vn.evil.plugin.x") + "loot"]],
    ["an identifier carrying SQL", [`${PREFIX}x"; DROP TABLE users; --`]],
    ["an uppercase / quoted identifier", [`"${PREFIX}Audit"`]],
    // Postgres truncates identifiers at 63 bytes. Two names differing only past
    // that point become the SAME table — a way to collide with a core table if
    // the length is not checked.
    ["a name Postgres would truncate", [PREFIX + "a".repeat(80)]],
  ] as [string, string[]][]) {
    const { rejected, reasons } = rejects(tables);
    check(`refuses ${name}`, rejected, reasons);
  }

  // And the rule must still ACCEPT what it is supposed to — a validator that
  // rejects everything is not a validator, it is an outage.
  const legit = [`${PREFIX}metadata`, `${PREFIX}sitemap_entries`];
  const { rejected, reasons } = rejects(legit);
  check(
    "accepts the plugin's own, correctly prefixed tables",
    !rejected,
    rejected ? `WRONGLY REJECTED: ${reasons}` : legit.join(", "),
  );

  console.log(
    failures === 0
      ? "\nAll plugin-table checks passed — a plugin can only ever own its own tables.\n"
      : `\n${failures} PLUGIN-TABLE CHECK(S) FAILED.\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main();
