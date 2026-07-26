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

  const columnLines = table.columns.map((column) => {
    const parts = [ident(column.name), COLUMN_SQL_TYPE[column.type]];
    if (column.nullable !== true) parts.push("NOT NULL");
    const def = defaultLiteral(column);
    if (def !== undefined) parts.push(`DEFAULT ${def}`);
    return "  " + parts.join(" ");
  });

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

  // Every query a plugin runs is scoped to one site, so this index is not
  // optional decoration — it is the access path for every read.
  statements.push(
    `CREATE INDEX IF NOT EXISTS ${ident(`${table.name}__tenant_site`)} ` +
      `ON ${tbl} ("tenant_id", "site_id")`,
  );

  table.indexes?.forEach((index, i) => {
    const cols = index.columns.map(ident).join(", ");
    const name = ident(`${table.name}__ix${i}`);
    const unique = index.unique ? "UNIQUE " : "";
    statements.push(`CREATE ${unique}INDEX IF NOT EXISTS ${name} ON ${tbl} (${cols})`);
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

// ---------------------------------------------------------------------------
// Query building
// ---------------------------------------------------------------------------

/** A parameterized statement: `$1`-style placeholders and the values for them. */
export interface SqlQuery {
  text: string;
  values: unknown[];
}

/** A row filter. Only equality, only on validated columns — no operators, no OR. */
export type PluginWhere = Record<string, unknown>;

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

/**
 * Builds a WHERE fragment plus the always-on `tenant_id`/`site_id` scoping the
 * gateway supplies from the token. Placeholders start at `start`; the caller
 * threads the running index so INSERT/UPDATE can put values before the WHERE.
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

  for (const [column, value] of Object.entries(where ?? {})) {
    assertColumn(known, column);
    if (value === null) {
      conds.push(`${ident(column)} IS NULL`);
    } else {
      conds.push(`${ident(column)} = $${i}`);
      values.push(value);
      i += 1;
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
