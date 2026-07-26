import { describe, expect, it } from "vitest";
import {
  buildPluginDelete,
  buildPluginInsert,
  buildPluginSelect,
  buildPluginUpdate,
  generatePluginTableDdl,
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
    expect(ddl.some((s) => s.startsWith("CREATE UNIQUE INDEX IF NOT EXISTS"))).toBe(true);
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
