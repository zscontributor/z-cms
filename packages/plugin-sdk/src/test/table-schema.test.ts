import { describe, expect, it } from "vitest";
import {
  buildPluginCount,
  buildPluginDelete,
  buildPluginInsert,
  buildPluginSelect,
  buildPluginUpdate,
  isPluginRowId,
  coercePluginRow,
  generatePluginTableDdl,
  generatePluginTableDropDdl,
  validatePluginTableSchemas,
  type PluginTableSchema,
} from "../table-schema";

/**
 * These tests are written from the attacker's side. A plugin's tables are the
 * one place plugin-chosen strings get anywhere near SQL, so the whole point of
 * this module is that nothing a plugin names can escape being either an
 * already-validated identifier or a bound parameter. A test that merely proves
 * the happy path works would miss the entire reason the module exists.
 */

const PLUGIN = "vn.zsoft.plugin.crm";
const PREFIX = "p_vn_zsoft_plugin_crm__";

const leads: PluginTableSchema = {
  name: `${PREFIX}leads`,
  columns: [
    { name: "email", type: "text" },
    { name: "score", type: "integer", default: 0 },
    { name: "note", type: "text", nullable: true },
  ],
  indexes: [{ columns: ["email"], unique: true }],
};

const scope = { tenantId: "t1", siteId: "s1" };

describe("validatePluginTableSchemas", () => {
  it("accepts a well-formed, correctly prefixed table", () => {
    expect(validatePluginTableSchemas(PLUGIN, [leads])).toEqual([]);
  });

  it("REFUSES a table outside the plugin's prefix", () => {
    // The land-grab: a table named `content` or `users` would let a plugin's DDL
    // and queries reach core data. Only its own prefix is allowed.
    const v = validatePluginTableSchemas(PLUGIN, [{ ...leads, name: "content" }]);
    expect(v[0]).toMatchObject({ table: "content", reason: "missing-prefix" });
  });

  it("REFUSES a table name carrying SQL punctuation", () => {
    const evil = `${PREFIX}x"; DROP TABLE users; --`;
    const v = validatePluginTableSchemas(PLUGIN, [{ ...leads, name: evil }]);
    expect(v[0]).toMatchObject({ reason: "invalid-table-name" });
  });

  it("REFUSES a column that shadows a core-managed one", () => {
    const v = validatePluginTableSchemas(PLUGIN, [
      { ...leads, columns: [{ name: "tenant_id", type: "uuid" }] },
    ]);
    expect(v[0]).toMatchObject({ reason: "reserved-column", detail: "tenant_id" });
  });

  it("REFUSES a column name carrying SQL punctuation", () => {
    const v = validatePluginTableSchemas(PLUGIN, [
      { ...leads, columns: [{ name: 'x" ) ; DROP', type: "text" }] },
    ]);
    expect(v[0]).toMatchObject({ reason: "invalid-column-name" });
  });

  it("REFUSES an unknown column type", () => {
    const v = validatePluginTableSchemas(PLUGIN, [
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { ...leads, columns: [{ name: "x", type: "serial" as any }] },
    ]);
    expect(v[0]).toMatchObject({ reason: "invalid-column-type" });
  });

  it("REFUSES a default whose type does not match the column", () => {
    const v = validatePluginTableSchemas(PLUGIN, [
      { ...leads, columns: [{ name: "flag", type: "boolean", default: "true; DROP" }] },
    ]);
    expect(v[0]).toMatchObject({ reason: "invalid-default" });
  });

  it("REFUSES a table with no columns", () => {
    const v = validatePluginTableSchemas(PLUGIN, [{ ...leads, columns: [] }]);
    expect(v[0]).toMatchObject({ reason: "no-columns" });
  });

  it("REFUSES an index on a column the table does not have", () => {
    const v = validatePluginTableSchemas(PLUGIN, [
      { ...leads, indexes: [{ columns: ["password"] }] },
    ]);
    expect(v[0]).toMatchObject({ reason: "invalid-index-column", detail: "password" });
  });

  it("allows an index on a reserved column like site_id", () => {
    const v = validatePluginTableSchemas(PLUGIN, [
      { ...leads, indexes: [{ columns: ["site_id", "email"] }] },
    ]);
    expect(v).toEqual([]);
  });

  it("treats no declaration as no violations", () => {
    expect(validatePluginTableSchemas(PLUGIN, undefined)).toEqual([]);
    expect(validatePluginTableSchemas(PLUGIN, [])).toEqual([]);
  });
});

describe("generatePluginTableDdl", () => {
  it("creates the table with core's id/tenant/site/timestamps and RLS", () => {
    const ddl = generatePluginTableDdl(PLUGIN, leads).join("\n");
    expect(ddl).toContain(`CREATE TABLE IF NOT EXISTS "${PREFIX}leads"`);
    expect(ddl).toContain(`"id" uuid PRIMARY KEY DEFAULT gen_random_uuid()`);
    expect(ddl).toContain(`"tenant_id" uuid NOT NULL`);
    expect(ddl).toContain(`"site_id" uuid NOT NULL`);
    expect(ddl).toContain(`ENABLE ROW LEVEL SECURITY`);
    expect(ddl).toContain(`current_tenant_id()`);
    expect(ddl).toContain(`GRANT SELECT, INSERT, UPDATE, DELETE ON "${PREFIX}leads" TO "zcms_app"`);
  });

  it("is idempotent — every statement is safe to re-run on each activation", () => {
    const ddl = generatePluginTableDdl(PLUGIN, leads);
    expect(ddl.some((s) => s.includes("CREATE TABLE IF NOT EXISTS"))).toBe(true);
    expect(ddl.some((s) => s.includes("DROP POLICY IF EXISTS"))).toBe(true);
    expect(ddl.some((s) => s.startsWith("CREATE INDEX IF NOT EXISTS"))).toBe(true);
    // A manifest index is DROP-then-CREATE so a changed shape reconciles; the DROP
    // guards re-runs and the CREATE that follows is only ever hit on an absent name.
    expect(ddl.some((s) => s.startsWith(`DROP INDEX IF EXISTS "${PREFIX}leads__ix0"`))).toBe(true);
    expect(ddl.some((s) => s.startsWith("CREATE UNIQUE INDEX"))).toBe(true);
  });

  it("scopes a manifest index by tenant_id, site_id so 'unique' means per-site", () => {
    // The table is multi-tenant: a UNIQUE index on the plugin's columns alone would
    // be global across every tenant, so one site's SKU would block all others'.
    const ddl = generatePluginTableDdl(PLUGIN, leads).join("\n");
    expect(ddl).toContain(
      `CREATE UNIQUE INDEX "${PREFIX}leads__ix0" ON "${PREFIX}leads" ("tenant_id", "site_id", "email")`,
    );
  });

  it("reconciles a pre-existing table by ADD COLUMN IF NOT EXISTS for every declared column", () => {
    // A plugin that adds a column in an upgrade must get it on the next activation —
    // CREATE TABLE IF NOT EXISTS alone would leave an existing table short a column.
    const ddl = generatePluginTableDdl(PLUGIN, leads).join("\n");
    expect(ddl).toContain(`ALTER TABLE "${PREFIX}leads" ADD COLUMN IF NOT EXISTS "email" text NOT NULL`);
    expect(ddl).toContain(`ALTER TABLE "${PREFIX}leads" ADD COLUMN IF NOT EXISTS "note" text`);
  });

  it("escapes a text default rather than interpolating it raw", () => {
    const table: PluginTableSchema = {
      name: `${PREFIX}x`,
      columns: [{ name: "label", type: "text", default: "a' ); DROP TABLE users; --" }],
    };
    const ddl = generatePluginTableDdl(PLUGIN, table).join("\n");
    // The value is emitted as one string literal with its quote doubled, so it
    // cannot break out. The tell of a breakout would be an *un*-doubled `a' )`.
    expect(ddl).toContain("'a'' ); DROP TABLE users; --'");
    expect(ddl).not.toContain("'a' )");
  });

  it("throws if asked to emit DDL for a table outside the prefix", () => {
    // The last line of defence, past validation: even called directly it will not
    // write a foreign table name into DDL.
    expect(() => generatePluginTableDdl(PLUGIN, { ...leads, name: "users" })).toThrow();
  });

  it("throws on an unknown column type rather than emitting broken DDL", () => {
    // The type is only ever looked up in a fixed map, so it cannot inject — but an
    // unknown one must fail loud here, not slip out as `undefined` in a CREATE.
    expect(() =>
      generatePluginTableDdl(PLUGIN, {
        name: `${PREFIX}x`,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        columns: [{ name: "c", type: "text); DROP TABLE users; --" as any }],
      }),
    ).toThrow(/unknown column type/);
  });
});

describe("generatePluginTableDropDdl", () => {
  it("drops the plugin's own table with IF EXISTS and no CASCADE", () => {
    expect(generatePluginTableDropDdl(PLUGIN, leads)).toEqual([
      `DROP TABLE IF EXISTS "${PREFIX}leads"`,
    ]);
  });

  it("REFUSES to emit a DROP for a core table", () => {
    // The guarantee the whole uninstall path rests on: it can never be turned into
    // `DROP TABLE users`, whatever it is handed.
    expect(() => generatePluginTableDropDdl(PLUGIN, { ...leads, name: "users" })).toThrow();
    expect(() => generatePluginTableDropDdl(PLUGIN, { ...leads, name: "content" })).toThrow();
  });

  it("REFUSES a table under another plugin's prefix", () => {
    expect(() =>
      generatePluginTableDropDdl(PLUGIN, { ...leads, name: "p_other__secrets" }),
    ).toThrow();
  });
});

describe("query builders", () => {
  it("always scopes an insert to the token's tenant and site", () => {
    const q = buildPluginInsert(leads, scope, { email: "a@x.com", score: 5 });
    expect(q.text).toContain(`INSERT INTO "${PREFIX}leads"`);
    expect(q.text).toContain(`"tenant_id", "site_id"`);
    expect(q.values.slice(0, 2)).toEqual(["t1", "s1"]);
    expect(q.values).toContain("a@x.com");
  });

  it("drops any attempt to set a reserved column on insert", () => {
    // A plugin trying to write another tenant's id gets it ignored, not honoured:
    // tenant_id/site_id always come from the two scope placeholders.
    const q = buildPluginInsert(leads, scope, { email: "a@x.com", tenant_id: "evil" });
    expect(q.values).not.toContain("evil");
    expect(q.values[0]).toBe("t1");
  });

  it("always scopes a select to tenant and site, and always bounds it", () => {
    const q = buildPluginSelect(leads, scope, { where: { email: "a@x.com" } });
    expect(q.text).toContain(`WHERE "tenant_id" = $1 AND "site_id" = $2`);
    expect(q.text).toMatch(/LIMIT \d+/);
    expect(q.values).toEqual(["t1", "s1", "a@x.com"]);
  });

  it("binds a where value as a parameter, never as text", () => {
    const q = buildPluginSelect(leads, scope, {
      where: { email: "x'; DROP TABLE users; --" },
    });
    expect(q.text).not.toContain("DROP TABLE");
    expect(q.values).toContain("x'; DROP TABLE users; --");
  });

  it("REFUSES a where on a column the table does not have", () => {
    expect(() =>
      buildPluginSelect(leads, scope, { where: { password: "x" } }),
    ).toThrow(/Unknown column/);
  });

  it("REFUSES an order-by on an unknown column", () => {
    expect(() =>
      buildPluginSelect(leads, scope, { orderBy: { column: "secret" } }),
    ).toThrow(/Unknown column/);
  });

  it("caps an over-large limit and floors a bad one to at least 1", () => {
    expect(buildPluginSelect(leads, scope, { limit: 100000 }).text).toContain("LIMIT 500");
    expect(buildPluginSelect(leads, scope, { limit: 0 }).text).toContain("LIMIT 1");
  });

  it("scopes an update to tenant/site and bumps updated_at", () => {
    const q = buildPluginUpdate(leads, scope, { score: 9 }, { email: "a@x.com" });
    expect(q.text).toContain(`UPDATE "${PREFIX}leads" SET "score" = $1`);
    expect(q.text).toContain(`"updated_at" = now()`);
    expect(q.text).toContain(`"tenant_id" = $2 AND "site_id" = $3`);
    expect(q.values).toEqual([9, "t1", "s1", "a@x.com"]);
  });

  it("REFUSES an update that sets no non-reserved column", () => {
    expect(() =>
      buildPluginUpdate(leads, scope, { tenant_id: "evil" }, { email: "a@x.com" }),
    ).toThrow(/at least one/);
  });

  it("scopes a delete to tenant and site", () => {
    const q = buildPluginDelete(leads, scope, { email: "a@x.com" });
    expect(q.text).toBe(
      `DELETE FROM "${PREFIX}leads" WHERE "tenant_id" = $1 AND "site_id" = $2 AND "email" = $3`,
    );
    expect(q.values).toEqual(["t1", "s1", "a@x.com"]);
  });

  it("renders a null where as IS NULL without a parameter", () => {
    const q = buildPluginSelect(leads, scope, { where: { note: null } });
    expect(q.text).toContain(`"note" IS NULL`);
    expect(q.values).toEqual(["t1", "s1"]);
  });
});

describe("buildPluginCount", () => {
  it("counts within the token's tenant and site, never across them", () => {
    const q = buildPluginCount(leads, scope);
    expect(q.text).toBe(
      `SELECT count(*)::bigint AS count FROM "${PREFIX}leads" ` +
        `WHERE "tenant_id" = $1 AND "site_id" = $2`,
    );
    expect(q.values).toEqual(["t1", "s1"]);
  });

  it("takes the same where vocabulary as the select it paginates", () => {
    // A count phrased more loosely than the select beside it would leak the size
    // of a set the caller cannot read.
    const q = buildPluginCount(leads, scope, { email: { op: "contains", value: "acme" } });
    expect(q.text).toContain(`"email" ILIKE $3`);
    expect(q.values).toEqual(["t1", "s1", "%acme%"]);
  });

  it("REFUSES a where on a column the table does not have", () => {
    expect(() => buildPluginCount(leads, scope, { password: "x" })).toThrow(/Unknown column/);
  });

  it("binds a hostile value as a parameter, never as text", () => {
    const q = buildPluginCount(leads, scope, { email: "x'; DROP TABLE users; --" });
    expect(q.text).not.toContain("DROP TABLE");
    expect(q.values).toContain("x'; DROP TABLE users; --");
  });

  it("has no LIMIT — a count of one page is not a total", () => {
    expect(buildPluginCount(leads, scope).text).not.toContain("LIMIT");
  });
});

describe("isPluginRowId", () => {
  it("accepts the uuid the platform puts on every row, in either case", () => {
    expect(isPluginRowId("3f1c9d2e-5a7b-4c8d-9e0f-1a2b3c4d5e6f")).toBe(true);
    expect(isPluginRowId("3F1C9D2E-5A7B-4C8D-9E0F-1A2B3C4D5E6F")).toBe(true);
  });

  it("rejects anything else, so a uuid column is never compared against it", () => {
    for (const value of ["", "1", "abc", "' OR 1=1 --", "3f1c9d2e5a7b4c8d9e0f1a2b3c4d5e6f"]) {
      expect(isPluginRowId(value)).toBe(false);
    }
  });
});

describe("coercePluginRow", () => {
  const table: PluginTableSchema = {
    name: "p_vn_zsoft_plugin_crm__customers",
    columns: [
      { name: "name", type: "text" },
      { name: "email", type: "text", nullable: true },
      { name: "stage", type: "text", default: "lead" },
      { name: "deal_value", type: "numeric", nullable: true },
      { name: "count", type: "integer", nullable: true },
      { name: "active", type: "boolean", nullable: true },
      { name: "last_contacted", type: "timestamptz", nullable: true },
      { name: "owner_id", type: "uuid", nullable: true },
    ],
  };

  it("coerces form strings to the declared column types", () => {
    const { row, errors } = coercePluginRow(table, {
      name: "Ann",
      deal_value: "199.5",
      count: "3",
      active: "true",
      last_contacted: "2026-07-20T02:00:00.000Z",
    });
    expect(errors).toEqual([]);
    expect(row).toMatchObject({
      name: "Ann",
      deal_value: 199.5,
      count: 3,
      active: true,
      last_contacted: "2026-07-20T02:00:00.000Z",
    });
  });

  it("reports a required error for a non-nullable column with no default on insert", () => {
    const { errors } = coercePluginRow(table, { email: "a@b.co" });
    expect(errors).toContainEqual({ column: "name", reason: "required" });
  });

  it("lets a non-nullable column with a default be omitted (the default applies)", () => {
    const { row, errors } = coercePluginRow(table, { name: "Ann" });
    expect(errors).toEqual([]);
    expect("stage" in row).toBe(false); // dropped so Postgres uses `default: "lead"`
  });

  it("does not demand required columns on a partial update", () => {
    const { errors } = coercePluginRow(table, { email: "a@b.co" }, { partial: true });
    expect(errors).toEqual([]);
  });

  it("flags a type error for a non-numeric number and a bad date", () => {
    const bad = coercePluginRow(table, { name: "Ann", deal_value: "abc" });
    expect(bad.errors).toContainEqual({ column: "deal_value", reason: "type" });
    const badDate = coercePluginRow(table, { name: "Ann", last_contacted: "not-a-date" });
    expect(badDate.errors).toContainEqual({ column: "last_contacted", reason: "type" });
  });

  it("rejects a non-uuid value for a uuid column", () => {
    const { errors } = coercePluginRow(table, { name: "Ann", owner_id: "not-a-uuid" });
    expect(errors).toContainEqual({ column: "owner_id", reason: "type" });
  });

  it("treats a blank string on a nullable column as NULL, not a type error", () => {
    const { row, errors } = coercePluginRow(table, { name: "Ann", email: "" });
    expect(errors).toEqual([]);
    expect(row.email).toBeNull();
  });
});

describe("buildPluginSelect where operators", () => {
  const table: PluginTableSchema = {
    name: `${PREFIX}customers`,
    columns: [
      { name: "name", type: "text" },
      { name: "stage", type: "text" },
      { name: "deal_value", type: "numeric" },
    ],
  };

  it("keeps the bare-value form as equality (back-compat)", () => {
    const q = buildPluginSelect(table, scope, { where: { stage: "lead" } });
    expect(q.text).toContain(`"stage" = $3`);
    expect(q.values).toEqual(["t1", "s1", "lead"]);
  });

  it("emits a range comparison for gte/lte and binds the values", () => {
    const q = buildPluginSelect(table, scope, {
      where: { deal_value: { op: "gte", value: 100 } },
    });
    expect(q.text).toContain(`"deal_value" >= $3`);
    expect(q.values).toEqual(["t1", "s1", 100]);
  });

  it("compiles contains to a bound, escaped ILIKE pattern (no injection)", () => {
    const q = buildPluginSelect(table, scope, {
      where: { name: { op: "contains", value: "50%_off" } },
    });
    expect(q.text).toContain(`"name" ILIKE $3`);
    // The value is a bound parameter with LIKE metacharacters escaped.
    expect(q.values[2]).toBe("%50\\%\\_off%");
  });

  it("compiles in to = ANY() with the array bound as one parameter", () => {
    const q = buildPluginSelect(table, scope, {
      where: { stage: { op: "in", value: ["lead", "customer"] } },
    });
    expect(q.text).toContain(`"stage" = ANY($3)`);
    expect(q.values[2]).toEqual(["lead", "customer"]);
  });

  it("still refuses a column the table does not have, even in the long form", () => {
    expect(() =>
      buildPluginSelect(table, scope, { where: { secret: { op: "eq", value: 1 } } }),
    ).toThrow(/Unknown column/);
  });

  it("refuses an unknown operator rather than treating it as equality", () => {
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      buildPluginSelect(table, scope, { where: { stage: { op: "regex", value: "x" } as any } }),
    ).toThrow(/Unknown filter operator/);
  });

  it("refuses an in filter whose value is not an array", () => {
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      buildPluginSelect(table, scope, { where: { stage: { op: "in", value: "lead" } as any } }),
    ).toThrow(/needs an array/);
  });
});
