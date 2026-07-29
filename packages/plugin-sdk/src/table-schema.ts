import { isPluginTable, pluginTablePrefix } from "./database";

/**
 * A plugin's relational tables, declared — never hand-written as SQL.
 *
 * This is the deliberate counterpart to WordPress's `dbDelta($createSql)`, and
 * it differs on the one point that matters for a sandboxed plugin: the plugin
 * does not get to write the SQL. It describes a table — a name, some columns,
 * some indexes — and core emits the `CREATE TABLE` from that description. A
 * plugin never issues DDL, never names a core table, never picks its own prefix,
 * and never phrases a query as a string. It hands core a shape and gets, back
 * through `ctx.db`, a small typed door onto the rows.
 *
 * Every table core creates from one of these carries the same three things core
 * puts on its own multi-tenant tables — an `id`, a `tenant_id`, a `site_id`,
 * plus `created_at`/`updated_at` — and the same row-level-security policy, so a
 * plugin's rows are isolated per tenant by the database itself, exactly as
 * `plugin_data` and `orders` are. The plugin cannot see the columns; it just
 * gets rows that are already its own.
 */

/** The column types a plugin may declare. A closed set, mapped to Postgres. */
export const PLUGIN_COLUMN_TYPES = [
  "text",
  "integer",
  "bigint",
  "boolean",
  "numeric",
  "timestamptz",
  "uuid",
  "jsonb",
] as const;

export type PluginColumnType = (typeof PLUGIN_COLUMN_TYPES)[number];

/** How each declared type is spelled in the emitted DDL. */
const COLUMN_SQL_TYPE: Record<PluginColumnType, string> = {
  text: "text",
  integer: "integer",
  bigint: "bigint",
  boolean: "boolean",
  numeric: "numeric",
  timestamptz: "timestamptz",
  uuid: "uuid",
  jsonb: "jsonb",
};

export interface PluginColumn {
  /** snake_case, `^[a-z_][a-z0-9_]*$`, and not one of the reserved names below. */
  name: string;
  type: PluginColumnType;
  /** Defaults to NOT NULL. Set true for a column that may be absent. */
  nullable?: boolean;
  /**
   * A constant default. Deliberately narrow — a literal, not an expression — so
   * there is no seam for SQL to arrive through a "default". `"now()"` is the one
   * function allowed, and only on a `timestamptz`.
   */
  default?: string | number | boolean | null;
}

export interface PluginIndex {
  /** One or more of the table's own columns (declared, or a reserved one). */
  columns: string[];
  unique?: boolean;
}

export interface PluginTableSchema {
  /** Must start with `pluginTablePrefix(id)` — core enforces it, never trusts it. */
  name: string;
  columns: PluginColumn[];
  indexes?: PluginIndex[];
}

/**
 * The columns core owns on every plugin table. A plugin may not declare one of
 * these (core would be redefining its own bookkeeping), but it MAY index them —
 * `site_id` especially, since a plugin's every query is scoped to one site.
 */
export const RESERVED_COLUMNS = [
  "id",
  "tenant_id",
  "site_id",
  "created_at",
  "updated_at",
] as const;

const RESERVED = new Set<string>(RESERVED_COLUMNS);
const IDENT_RE = /^[a-z_][a-z0-9_]*$/;
const MAX_IDENTIFIER_LENGTH = 63;

export interface PluginSchemaViolation {
  table: string;
  reason:
    | "missing-prefix"
    | "invalid-table-name"
    | "table-too-long"
    | "no-columns"
    | "duplicate-column"
    | "reserved-column"
    | "invalid-column-name"
    | "invalid-column-type"
    | "invalid-default"
    | "invalid-index-column";
  detail?: string;
}

function isSafeDefault(column: PluginColumn): boolean {
  const { default: def, type } = column;
  if (def === undefined) return true;
  if (def === null) return true;
  if (type === "boolean") return typeof def === "boolean";
  if (type === "integer" || type === "bigint") {
    return typeof def === "number" && Number.isInteger(def);
  }
  if (type === "numeric") return typeof def === "number" && Number.isFinite(def);
  if (type === "timestamptz") return def === "now()";
  if (type === "text") return typeof def === "string";
  // uuid / jsonb take no literal default in this narrow grammar.
  return false;
}

/**
 * Validates a plugin's declared tables against every law core will otherwise
 * have to trust at query time — checked once, at install, before a line of the
 * plugin's code has run and before core emits a single statement of DDL.
 *
 * The name laws are the same two as `validatePluginTables` (own prefix, legal
 * identifier); this adds the column and index grammar, because a table core is
 * about to CREATE from this description must be describable in safe DDL with no
 * string interpolation of anything the plugin chose but an already-validated
 * identifier.
 */
export function validatePluginTableSchemas(
  pluginId: string,
  tables: readonly PluginTableSchema[] | undefined,
): PluginSchemaViolation[] {
  if (!tables?.length) return [];

  const prefix = pluginTablePrefix(pluginId);
  const violations: PluginSchemaViolation[] = [];

  for (const table of tables) {
    const name = table.name;

    if (!IDENT_RE.test(name)) {
      violations.push({ table: name, reason: "invalid-table-name" });
      continue;
    }
    if (!isPluginTable(pluginId, name)) {
      violations.push({ table: name, reason: "missing-prefix", detail: prefix });
      continue;
    }
    if (name.length > MAX_IDENTIFIER_LENGTH) {
      violations.push({ table: name, reason: "table-too-long" });
      continue;
    }
    if (!table.columns?.length) {
      violations.push({ table: name, reason: "no-columns" });
      continue;
    }

    const seen = new Set<string>();
    for (const column of table.columns) {
      if (!IDENT_RE.test(column.name) || column.name.length > MAX_IDENTIFIER_LENGTH) {
        violations.push({ table: name, reason: "invalid-column-name", detail: column.name });
        continue;
      }
      if (RESERVED.has(column.name)) {
        violations.push({ table: name, reason: "reserved-column", detail: column.name });
        continue;
      }
      if (seen.has(column.name)) {
        violations.push({ table: name, reason: "duplicate-column", detail: column.name });
        continue;
      }
      seen.add(column.name);

      if (!PLUGIN_COLUMN_TYPES.includes(column.type)) {
        violations.push({ table: name, reason: "invalid-column-type", detail: column.name });
        continue;
      }
      if (!isSafeDefault(column)) {
        violations.push({ table: name, reason: "invalid-default", detail: column.name });
      }
    }

    // An index may reference a declared column or a reserved one, nothing else —
    // an index on a phantom column would put the plugin's chosen text into DDL.
    const known = new Set<string>([...seen, ...RESERVED]);
    for (const index of table.indexes ?? []) {
      for (const col of index.columns) {
        if (!known.has(col)) {
          violations.push({ table: name, reason: "invalid-index-column", detail: col });
        }
      }
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------
// DDL generation
// ---------------------------------------------------------------------------

/**
 * A validated identifier, double-quoted for DDL. Throws rather than emit
 * anything that did not pass {@link IDENT_RE} — the belt to the validator's
 * braces, so a bug that lets an unvalidated name reach here fails loudly instead
 * of writing it into SQL.
 */
function ident(name: string): string {
  if (!IDENT_RE.test(name) || name.length > MAX_IDENTIFIER_LENGTH) {
    throw new Error(`Refusing to emit an unsafe identifier: ${JSON.stringify(name)}`);
  }
  return `"${name}"`;
}

function defaultLiteral(column: PluginColumn): string | undefined {
  const { default: def, type } = column;
  if (def === undefined) return undefined;
  if (def === null) return "NULL";
  if (type === "boolean") return def ? "TRUE" : "FALSE";
  if (type === "integer" || type === "bigint" || type === "numeric") return String(def);
  if (type === "timestamptz" && def === "now()") return "now()";
  if (type === "text" && typeof def === "string") {
    // Single-quote escaped: the one place a plugin's raw value is emitted, and it
    // is emitted as a string literal, doubled quotes and all.
    return `'${def.replace(/'/g, "''")}'`;
  }
  throw new Error(`Unsafe default for column ${column.name}`);
}

/**
 * The statements that create one plugin table — idempotent, so re-running them
 * on every activation is a no-op once the table exists, the way `dbDelta` is.
 *
 * Assumes the schema already passed {@link validatePluginTableSchemas}; `ident`
 * is the final guard. `appRole` is the least-privileged role plugin queries run
 * as (the same `zcms_app` core grants its own tables), so a plugin gets exactly
 * SELECT/INSERT/UPDATE/DELETE on its own table and, through RLS, only its
 * tenant's rows.
 */
export function generatePluginTableDdl(
  pluginId: string,
  table: PluginTableSchema,
  appRole = "zcms_app",
): string[] {
  if (!isPluginTable(pluginId, table.name)) {
    throw new Error(`Refusing DDL for a table outside ${pluginTablePrefix(pluginId)}`);
  }
  const tbl = ident(table.name);

  // The column body `<type> [NOT NULL] [DEFAULT …]`, shared by CREATE and the
  // reconciling ALTERs. The type is never emitted raw — only its mapped SQL
  // spelling, so a crafted type string cannot inject. An unknown type would map to
  // `undefined` and produce broken DDL; refuse it loudly instead.
  const columnBody = (column: PluginColumn): string => {
    const sqlType = COLUMN_SQL_TYPE[column.type];
    if (!sqlType) {
      throw new Error(`Refusing DDL for unknown column type: ${JSON.stringify(column.type)}`);
    }
    const parts = [sqlType];
    if (column.nullable !== true) parts.push("NOT NULL");
    const def = defaultLiteral(column);
    if (def !== undefined) parts.push(`DEFAULT ${def}`);
    return parts.join(" ");
  };

  const columnLines = table.columns.map((column) => `  ${ident(column.name)} ${columnBody(column)}`);

  const createTable =
    `CREATE TABLE IF NOT EXISTS ${tbl} (\n` +
    [
      `  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid()`,
      `  "tenant_id" uuid NOT NULL`,
      `  "site_id" uuid NOT NULL`,
      ...columnLines,
      `  "created_at" timestamptz NOT NULL DEFAULT now()`,
      `  "updated_at" timestamptz NOT NULL DEFAULT now()`,
    ].join(",\n") +
    `\n)`;

  const statements: string[] = [createTable];

  // Reconcile a table that predates a column: when a plugin ships a new version that
  // ADDS a column, `CREATE TABLE IF NOT EXISTS` is a no-op on the existing table and
  // would leave it missing the column — every insert naming it then fails. So each
  // declared column is also added with `ADD COLUMN IF NOT EXISTS`, idempotent (a
  // no-op on a table the CREATE just made, and on a column already present). A new
  // NOT NULL column with no default cannot be added to a populated table — that is
  // an unsafe migration Postgres refuses, and it fails loudly here rather than at the
  // next insert; ship such a column as nullable or with a default.
  for (const column of table.columns) {
    statements.push(
      `ALTER TABLE ${tbl} ADD COLUMN IF NOT EXISTS ${ident(column.name)} ${columnBody(column)}`,
    );
  }

  // Every query a plugin runs is scoped to one site, so this index is not
  // optional decoration — it is the access path for every read.
  statements.push(
    `CREATE INDEX IF NOT EXISTS ${ident(`${table.name}__tenant_site`)} ` +
      `ON ${tbl} ("tenant_id", "site_id")`,
  );

  table.indexes?.forEach((index, i) => {
    // A plugin table is multi-tenant and site-scoped: every row carries
    // tenant_id/site_id and every query filters by them. A manifest index names
    // only the plugin's own columns, so scope it the way core scopes the table —
    // prepend tenant_id, site_id. Without this a UNIQUE index is global across the
    // whole platform: one site seeding SKU "X" would block every other site from
    // ever holding "X", and "unique" would mean "unique on Z-CMS", not "unique in
    // this shop". DROP-then-CREATE (like the RLS policy below) so an index whose
    // columns or uniqueness changed — across plugin versions, or from this very
    // scoping fix on a table that predates it — is reconciled, not silently left
    // in its old shape by CREATE ... IF NOT EXISTS.
    const cols = [ident("tenant_id"), ident("site_id"), ...index.columns.map(ident)].join(", ");
    const name = ident(`${table.name}__ix${i}`);
    const unique = index.unique ? "UNIQUE " : "";
    statements.push(`DROP INDEX IF EXISTS ${name}`);
    statements.push(`CREATE ${unique}INDEX ${name} ON ${tbl} (${cols})`);
  });

  // RLS, the same policy core writes by hand for every tenant-scoped table it
  // ships. DROP-then-CREATE because Postgres has no CREATE POLICY IF NOT EXISTS;
  // dropping a policy that isn't there is caught by IF EXISTS, so this is safe to
  // re-run on every activation.
  statements.push(`ALTER TABLE ${tbl} ENABLE ROW LEVEL SECURITY`);
  statements.push(`DROP POLICY IF EXISTS tenant_isolation ON ${tbl}`);
  statements.push(
    `CREATE POLICY tenant_isolation ON ${tbl} ` +
      `USING (tenant_id = current_tenant_id()) ` +
      `WITH CHECK (tenant_id = current_tenant_id())`,
  );
  statements.push(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ${tbl} TO ${ident(appRole)}`,
  );

  return statements;
}

/**
 * The statements that drop one plugin table — the mirror of
 * {@link generatePluginTableDdl}, guarded exactly the same way.
 *
 * `isPluginTable` + `ident` are the two locks: this can only ever emit a DROP for
 * a table named with the plugin's own prefix, so a bug or a bad caller cannot turn
 * it into `DROP TABLE users`. No `CASCADE`: a plugin table is a standalone island
 * (nothing else has a foreign key into it), and Postgres drops the table's own
 * indexes and RLS policy with it automatically — so a plain `DROP TABLE IF EXISTS`
 * removes everything the create made and nothing it did not.
 *
 * Dropping is safe ONLY when no site still holds the plugin: the table is a global
 * object shared across every tenant, its rows separated by `tenant_id`/`site_id`.
 * The caller is responsible for that check; this function only refuses to name a
 * table that is not the plugin's.
 */
export function generatePluginTableDropDdl(
  pluginId: string,
  table: PluginTableSchema,
): string[] {
  if (!isPluginTable(pluginId, table.name)) {
    throw new Error(`Refusing to drop a table outside ${pluginTablePrefix(pluginId)}`);
  }
  return [`DROP TABLE IF EXISTS ${ident(table.name)}`];
}

// ---------------------------------------------------------------------------
// Query building
// ---------------------------------------------------------------------------

/** A parameterized statement: `$1`-style placeholders and the values for them. */
export interface SqlQuery {
  text: string;
  values: unknown[];
}

/**
 * The comparisons a `where` may express, beyond bare equality. Still AND-only and
 * still on validated columns — every value is a bound parameter, never SQL.
 */
export const PLUGIN_WHERE_OPERATORS = [
  "eq",
  "neq",
  "lt",
  "lte",
  "gt",
  "gte",
  "contains",
  "startsWith",
  "in",
] as const;
export type PluginWhereOperator = (typeof PLUGIN_WHERE_OPERATORS)[number];

/** The long form of a filter: `{ op, value }`. `contains`/`startsWith` are case- */
/** insensitive substring/prefix; `in` takes an array; the rest are scalar. */
export interface PluginWhereClause {
  op: PluginWhereOperator;
  value: unknown;
}

/**
 * A row filter, AND-ed across columns. Each value is either a **bare value**
 * (equality, or `IS NULL` for `null` — the back-compatible form) or a
 * {@link PluginWhereClause} `{ op, value }` for a range, substring or `in` test.
 * There is still no `OR` and no raw SQL; a column is always validated and a value
 * is always a bound parameter.
 */
export type PluginWhere = Record<string, unknown | PluginWhereClause>;

export interface PluginSelectOptions {
  where?: PluginWhere;
  orderBy?: { column: string; direction?: "asc" | "desc" };
  limit?: number;
  offset?: number;
}

/**
 * The columns a caller may name in a WHERE / ORDER BY / row: the plugin's own,
 * plus the reserved ones core manages. Built once from the table schema so a
 * query naming any other column is refused before a placeholder is allocated.
 */
function knownColumns(table: PluginTableSchema): Set<string> {
  return new Set<string>([...RESERVED_COLUMNS, ...table.columns.map((c) => c.name)]);
}

function assertColumn(known: Set<string>, column: string): void {
  if (!known.has(column)) {
    throw new Error(`Unknown column for this table: ${JSON.stringify(column)}`);
  }
}

/** Escape a value's LIKE metacharacters so a substring test matches them literally. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Read the `{ op, value }` long form, or null for the bare-value (equality) form.
 * A value carrying an `op` that is not a known operator is refused loudly rather
 * than silently treated as an equality against an object.
 */
function asWhereClause(raw: unknown): PluginWhereClause | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || !("op" in raw)) return null;
  const record = raw as Record<string, unknown>;
  const op = record.op;
  if (typeof op !== "string" || !PLUGIN_WHERE_OPERATORS.includes(op as PluginWhereOperator)) {
    throw new Error(`Unknown filter operator: ${JSON.stringify(op)}`);
  }
  return { op: op as PluginWhereOperator, value: record.value };
}

/**
 * Builds a WHERE fragment plus the always-on `tenant_id`/`site_id` scoping the
 * gateway supplies from the token. Placeholders start at `start`; the caller
 * threads the running index so INSERT/UPDATE can put values before the WHERE.
 *
 * Each column's condition is a bare value (equality / `IS NULL`) or a
 * {@link PluginWhereClause}. Every value is a bound parameter; the operator only
 * selects the SQL comparison, so nothing a plugin passes becomes SQL.
 */
function buildWhere(
  known: Set<string>,
  scope: { tenantId: string; siteId: string },
  where: PluginWhere | undefined,
  start: number,
): { clause: string; values: unknown[] } {
  const conds = [`"tenant_id" = $${start}`, `"site_id" = $${start + 1}`];
  const values: unknown[] = [scope.tenantId, scope.siteId];
  let i = start + 2;
  const bind = (v: unknown): string => {
    values.push(v);
    return `$${i++}`;
  };

  for (const [column, raw] of Object.entries(where ?? {})) {
    assertColumn(known, column);
    const col = ident(column);
    const clause = asWhereClause(raw);

    if (!clause) {
      // Bare value: equality, or IS NULL for an explicit null.
      conds.push(raw === null ? `${col} IS NULL` : `${col} = ${bind(raw)}`);
      continue;
    }

    const { op, value } = clause;
    switch (op) {
      case "eq":
        conds.push(value === null ? `${col} IS NULL` : `${col} = ${bind(value)}`);
        break;
      case "neq":
        conds.push(value === null ? `${col} IS NOT NULL` : `${col} <> ${bind(value)}`);
        break;
      case "lt":
        conds.push(`${col} < ${bind(value)}`);
        break;
      case "lte":
        conds.push(`${col} <= ${bind(value)}`);
        break;
      case "gt":
        conds.push(`${col} > ${bind(value)}`);
        break;
      case "gte":
        conds.push(`${col} >= ${bind(value)}`);
        break;
      case "contains":
        conds.push(`${col} ILIKE ${bind(`%${escapeLike(String(value))}%`)}`);
        break;
      case "startsWith":
        conds.push(`${col} ILIKE ${bind(`${escapeLike(String(value))}%`)}`);
        break;
      case "in":
        if (!Array.isArray(value)) {
          throw new Error(`The "in" filter on ${JSON.stringify(column)} needs an array.`);
        }
        conds.push(`${col} = ANY(${bind(value)})`);
        break;
    }
  }

  return { clause: conds.join(" AND "), values };
}

/**
 * The four builders below are the whole of what a plugin can do to its tables.
 * They are pure and take the tenant/site scope as an argument, because that scope
 * comes from the plugin's signed token at the gateway, never from the plugin —
 * so a plugin cannot phrase a query that reaches another site's rows, and cannot
 * phrase one at all against a table that is not its own (the schema it is checked
 * against is its own install's).
 */
export function buildPluginInsert(
  table: PluginTableSchema,
  scope: { tenantId: string; siteId: string },
  row: Record<string, unknown>,
): SqlQuery {
  const known = knownColumns(table);
  const entries = Object.entries(row).filter(([c]) => {
    assertColumn(known, c);
    // Core owns these; a plugin does not get to set them on insert.
    return !RESERVED.has(c);
  });

  const columns = ['"tenant_id"', '"site_id"', ...entries.map(([c]) => ident(c))];
  const values: unknown[] = [scope.tenantId, scope.siteId, ...entries.map(([, v]) => v)];
  const placeholders = values.map((_, i) => `$${i + 1}`);

  const text =
    `INSERT INTO ${ident(table.name)} (${columns.join(", ")}) ` +
    `VALUES (${placeholders.join(", ")}) RETURNING *`;
  return { text, values };
}

export function buildPluginSelect(
  table: PluginTableSchema,
  scope: { tenantId: string; siteId: string },
  options: PluginSelectOptions = {},
): SqlQuery {
  const known = knownColumns(table);
  const { clause, values } = buildWhere(known, scope, options.where, 1);

  let text = `SELECT * FROM ${ident(table.name)} WHERE ${clause}`;

  if (options.orderBy) {
    assertColumn(known, options.orderBy.column);
    const dir = options.orderBy.direction === "desc" ? "DESC" : "ASC";
    text += ` ORDER BY ${ident(options.orderBy.column)} ${dir}`;
  }

  // A limit is always applied so a plugin can never ask the database for
  // everything; an unbounded read is not one of the shapes on offer.
  const limit = Math.min(500, Math.max(1, Math.floor(options.limit ?? 100)));
  text += ` LIMIT ${limit}`;
  if (options.offset && options.offset > 0) {
    text += ` OFFSET ${Math.floor(options.offset)}`;
  }

  return { text, values };
}

export function buildPluginUpdate(
  table: PluginTableSchema,
  scope: { tenantId: string; siteId: string },
  patch: Record<string, unknown>,
  where: PluginWhere,
): SqlQuery {
  const known = knownColumns(table);
  const entries = Object.entries(patch).filter(([c]) => {
    assertColumn(known, c);
    return !RESERVED.has(c);
  });
  if (!entries.length) {
    throw new Error("An update must set at least one non-reserved column.");
  }

  const setParts = entries.map(([c], i) => `${ident(c)} = $${i + 1}`);
  setParts.push(`"updated_at" = now()`);
  const setValues = entries.map(([, v]) => v);

  const { clause, values: whereValues } = buildWhere(
    known,
    scope,
    where,
    entries.length + 1,
  );

  const text =
    `UPDATE ${ident(table.name)} SET ${setParts.join(", ")} ` +
    `WHERE ${clause} RETURNING *`;
  return { text, values: [...setValues, ...whereValues] };
}

export function buildPluginDelete(
  table: PluginTableSchema,
  scope: { tenantId: string; siteId: string },
  where: PluginWhere,
): SqlQuery {
  const known = knownColumns(table);
  const { clause, values } = buildWhere(known, scope, where, 1);
  const text = `DELETE FROM ${ident(table.name)} WHERE ${clause}`;
  return { text, values };
}

// ---------------------------------------------------------------------------
// Value coercion
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type PluginCoercionReason = "required" | "type";

export interface PluginRowCoercion {
  /** The coerced row, ready for {@link buildPluginInsert}/{@link buildPluginUpdate}. */
  row: Record<string, unknown>;
  /** One entry per column that failed; empty means the row is good to write. */
  errors: Array<{ column: string; reason: PluginCoercionReason }>;
}

/** Turn one form value into the type its declared column expects, or fail it. */
function coerceValue(
  type: PluginColumnType,
  raw: unknown,
): { value: unknown; ok: boolean } {
  // Absent / blank is a null the caller then judges against `nullable`/`default`.
  if (raw === undefined || raw === null || raw === "") return { value: null, ok: true };

  switch (type) {
    case "text":
      return { value: typeof raw === "string" ? raw : String(raw), ok: true };
    case "integer":
    case "bigint": {
      const n = typeof raw === "number" ? raw : Number(raw);
      return Number.isInteger(n) ? { value: n, ok: true } : { value: null, ok: false };
    }
    case "numeric": {
      const n = typeof raw === "number" ? raw : Number(raw);
      return Number.isFinite(n) ? { value: n, ok: true } : { value: null, ok: false };
    }
    case "boolean": {
      if (typeof raw === "boolean") return { value: raw, ok: true };
      if (typeof raw === "number") return { value: raw !== 0, ok: true };
      if (typeof raw === "string") {
        const s = raw.trim().toLowerCase();
        if (["true", "1", "on", "yes"].includes(s)) return { value: true, ok: true };
        if (["false", "0", "off", "no"].includes(s)) return { value: false, ok: true };
      }
      return { value: null, ok: false };
    }
    case "timestamptz": {
      const d = raw instanceof Date ? raw : new Date(String(raw));
      return Number.isNaN(d.getTime())
        ? { value: null, ok: false }
        : { value: d.toISOString(), ok: true };
    }
    case "uuid": {
      const s = String(raw);
      return UUID_RE.test(s) ? { value: s, ok: true } : { value: null, ok: false };
    }
    case "jsonb":
      return { value: raw, ok: true };
    default:
      return { value: raw, ok: true };
  }
}

/**
 * Coerce and validate a form-posted row against a plugin table's declared column
 * types — the one place per-field typing lives, so every plugin's CRUD form gets
 * the same guarantees without writing any of it.
 *
 * The builders below only check that a column NAME exists; they pass values into
 * placeholders untouched, which turns a blank number or a bad date into a raw
 * Postgres 500. This runs first: it maps each value to its column's type, drops a
 * blank onto its default (or NULL when the column allows it), and reports a
 * `required`/`type` error rather than letting the database refuse it opaquely.
 *
 * `partial` is for UPDATE — an absent column is "leave it", so required columns
 * are not demanded; only a value that was sent and failed is reported.
 */
export function coercePluginRow(
  table: PluginTableSchema,
  input: Record<string, unknown>,
  opts: { partial?: boolean } = {},
): PluginRowCoercion {
  const partial = opts.partial ?? false;
  const byName = new Map(table.columns.map((c) => [c.name, c]));
  const row: Record<string, unknown> = {};
  const errors: Array<{ column: string; reason: PluginCoercionReason }> = [];

  for (const [key, raw] of Object.entries(input)) {
    if (RESERVED.has(key)) continue; // core owns these; never settable from a form.
    const column = byName.get(key);
    if (!column) {
      row[key] = raw; // Unknown to the schema — let the builder refuse it by name.
      continue;
    }
    const { value, ok } = coerceValue(column.type, raw);
    if (!ok) {
      errors.push({ column: key, reason: "type" });
      continue;
    }
    if (value === null) {
      if (column.nullable) {
        row[key] = null;
      } else if (column.default !== undefined) {
        // Omit so the column's declared default applies.
      } else {
        errors.push({ column: key, reason: "required" });
      }
    } else {
      row[key] = value;
    }
  }

  if (!partial) {
    for (const column of table.columns) {
      if (column.nullable || column.default !== undefined) continue;
      if (!(column.name in row) && !errors.some((e) => e.column === column.name)) {
        errors.push({ column: column.name, reason: "required" });
      }
    }
  }

  return { row, errors };
}
