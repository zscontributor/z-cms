import { isValidLocalizedLabel, resolveLocalized, type LocalizedString } from "./localized";
import {
  RESERVED_COLUMNS,
  type PluginColumnType,
  type PluginTableSchema,
} from "./table-schema";

/**
 * How a plugin adds screens to the admin — declared, and rendered by core.
 *
 * This is WordPress's `add_menu_page` + `register_post_type`, with the one
 * difference that runs through the whole of this platform: the plugin does not
 * ship the UI. A WordPress plugin hands core a PHP callback that echoes HTML;
 * here a plugin hands core a *description* of a screen — a resource backed by one
 * of its own tables, the columns to list, the fields to edit, and the permission
 * that guards it — and core's admin renders it. The plugin has no code running in
 * the admin at all, which is exactly why it can be a sandboxed, untrusted-by-
 * default thing and still contribute a first-class screen.
 *
 * What a plugin gives up for that is bespoke UI: it gets a list, a detail view
 * and a form over its data, not an arbitrary React tree. What it gets back is
 * that its screen inherits the admin's chrome, its i18n, its permission model and
 * its accessibility for free, and can never break the admin, because there is no
 * seam through which it could.
 */

/** A sidebar entry. Visible only to a user whose role holds `permission`. */
export interface PluginNavItem {
  /** Sidebar label. A plain string, or a `{en,vi,…}` map resolved per reader. */
  label: LocalizedString;
  /** Icon key from the admin's own set; falls back to a default when unknown. */
  icon?: string;
  /** The `key` of the resource this entry opens. */
  resource: string;
  /**
   * The permission a user must hold to see this entry and open the resource —
   * a {@link ProvidedPermission} the plugin declared, or a core one. This is what
   * makes a plugin's menu appear only where it should: no grant, no entry.
   */
  permission: string;
}

/** How one field is edited in the generated form. Defaulted from the column type. */
export type PluginFieldInput =
  | "text"
  | "textarea"
  | "richtext"
  | "number"
  | "boolean"
  | "select"
  | "date"
  | "media"
  | "reference";

/**
 * One choice for a `select` input. `value` is what is stored in the row and is
 * NEVER localized — orders and rows keep one stable value across languages.
 * `label` is display-only and may be a `{en,vi,…}` map. A bare `string` is
 * shorthand for value === label.
 */
export type PluginFieldOption = string | { value: string; label: LocalizedString };

export interface PluginResourceColumn {
  /** A column of the backing table (a declared one, or a reserved core column). */
  column: string;
  label: LocalizedString;
  /**
   * Change this column from the list, without opening the record.
   *
   * For the columns a screen exists to *move* rather than to read: an order's
   * status, a task's stage. Those get touched dozens of times a shift, and making
   * each one a navigation — open, change one dropdown, save, go back, find your
   * place again — is most of the work of using the screen.
   *
   * Only honoured when the column also has a `select` form field: the choices are
   * that field's `options`, so a list cell can never offer a value the record
   * screen would reject, and there is one place to add a new status. Ignored when
   * the resource declares no write permission, and hidden from a reader who does
   * not hold it — the same gate the edit form is behind, since this IS an edit.
   */
  editable?: boolean;
}

export interface PluginResourceField {
  column: string;
  label: LocalizedString;
  /** Overrides the input inferred from the column's type. */
  input?: PluginFieldInput;
  /** Choices for a `select` input. */
  options?: PluginFieldOption[];
  /**
   * For `reference`: the plugin table this column points into.
   *
   * Until there was a picker behind it this was a comment — the admin rendered a
   * `reference` as a plain text box, so "which member of staff is on this shift"
   * was answered by pasting a uuid. Core now resolves the table to the resource
   * that surfaces it and offers a searchable list of its rows.
   */
  refTable?: string;
  /**
   * The column of `refTable` whose value is STORED here. Defaults to `id`.
   *
   * Not every reference is by id: a recipe line names a menu item by its code,
   * because a barista reads "CF-02" and a uuid means nothing to anyone. The
   * picker stores whatever this names and shows {@link refLabel}.
   */
  refValue?: string;
  /**
   * The column of `refTable` a human READS. Defaults to the first column the
   * referenced resource lists — the same "most identifying thing the plugin
   * chose to show" the record screen already uses for its heading.
   */
  refLabel?: string;
  /** Shown but not editable — an `id`, a `created_at`, a computed status. */
  readonly?: boolean;
}

export interface PluginAdminResource {
  /** Stable slug, unique within the plugin; forms the screen's URL. */
  key: string;
  /** Singular/plural-agnostic label for the screen heading. */
  label: LocalizedString;
  /** The declared plugin table this screen reads and writes. */
  table: string;
  list: {
    columns: PluginResourceColumn[];
    orderBy?: { column: string; direction?: "asc" | "desc" };
  };
  /** The create/edit form. Omit for a read-only resource. */
  form?: { fields: PluginResourceField[] };
  /**
   * Other resources of this plugin whose rows belong to THIS record — the
   * ingredients of a drink, the lines of an order.
   *
   * The generated screens are one table each, which is the right default and the
   * wrong answer for data that is only meaningful together: a menu item's recipe
   * lived on its own screen, so "what is in a cà phê sữa" was a question you
   * answered by remembering an item code and going somewhere else to filter by it.
   *
   * A child is a plain join by value: `child.foreignColumn = parent[localColumn]`.
   * No cascade, no ownership, no delete semantics — the parent record simply shows
   * the rows that name it, gated by the CHILD's own read permission, because a
   * cost price does not become public by being listed under something else.
   */
  children?: PluginResourceChild[];
  /**
   * The permissions that guard this resource. `read` gates the list and detail;
   * `write` gates create/update/delete and, absent, makes the resource read-only
   * for everyone regardless of role.
   */
  permissions: { read: string; write?: string };
}

export interface PluginResourceChild {
  /** The `key` of another resource of the same plugin. */
  resource: string;
  /** The child column that names the parent, e.g. `item_code`. */
  foreignColumn: string;
  /** The parent column it is matched against. Defaults to `id`. */
  localColumn?: string;
  /** Heading for the section, e.g. "Ingredients". */
  label: LocalizedString;
}

export interface PluginAdminContribution {
  nav?: PluginNavItem[];
  resources?: PluginAdminResource[];
}

/**
 * The same shapes as above, but every label already resolved to a plain string
 * for one reader and every option normalized to `{value,label}`. This is what the
 * server hands the admin — resolution happens once, server-side, so the admin
 * components render strings and never learn about locale maps.
 */
export interface ResolvedPluginFieldOption {
  value: string;
  label: string;
}
export type ResolvedPluginResourceField = Omit<PluginResourceField, "label" | "options"> & {
  label: string;
  options?: ResolvedPluginFieldOption[];
};
export type ResolvedPluginResourceColumn = {
  column: string;
  label: string;
  /**
   * The choices this cell may be switched between, resolved for one reader.
   *
   * Present only when the plugin marked the column `editable` AND declared a
   * `select` field for it — so the admin needs no second lookup, and an
   * `editable` the plugin cannot honour simply arrives without choices and
   * renders as ordinary text.
   */
  editOptions?: ResolvedPluginFieldOption[];
};
export type ResolvedPluginAdminResource = Omit<
  PluginAdminResource,
  "label" | "list" | "form"
> & {
  label: string;
  list: {
    columns: ResolvedPluginResourceColumn[];
    orderBy?: { column: string; direction?: "asc" | "desc" };
  };
  form?: { fields: ResolvedPluginResourceField[] };
  /**
   * The DECLARED type of every column of the backing table, reserved ones
   * included — so a screen can read a value the way the plugin meant it.
   *
   * Without this the admin had only the shape of the string to go on, and a shape
   * is not a type: `"0908999888"` is a phone number that looks exactly like an
   * integer, and the list rendered it as "908.999.888" — grouped like money, with
   * the leading zero gone. The platform never had to guess. The plugin declared
   * `text` in `manifest.database.tables`, and this is that declaration, travelling
   * as far as the screen that renders it.
   */
  columnTypes?: Record<string, PluginColumnType>;
  /**
   * The declared bounds of every numeric column that has them, so a number input
   * can carry `min`/`max` and a browser can refuse "-5" before anyone waits for a
   * round trip.
   *
   * Presentation only. `coercePluginRow` enforces the same bounds on the server
   * for every write, which is where the guarantee lives — an `<input min>` is a
   * courtesy to whoever is typing, not a control.
   */
  columnBounds?: Record<string, { min?: number; max?: number }>;
};

/**
 * Every column of a table with its declared type, including the five core owns on
 * every plugin table (which no manifest declares but every row carries).
 */
export function pluginColumnTypes(table: PluginTableSchema): Record<string, PluginColumnType> {
  const types: Record<string, PluginColumnType> = {
    id: "uuid",
    tenant_id: "uuid",
    site_id: "uuid",
    created_at: "timestamptz",
    updated_at: "timestamptz",
  };
  for (const column of table.columns) types[column.name] = column.type;
  return types;
}

/** The declared `min`/`max` of every column that has one. */
export function pluginColumnBounds(
  table: PluginTableSchema,
): Record<string, { min?: number; max?: number }> {
  const bounds: Record<string, { min?: number; max?: number }> = {};
  for (const column of table.columns) {
    if (column.min === undefined && column.max === undefined) continue;
    bounds[column.name] = {
      ...(column.min !== undefined ? { min: column.min } : {}),
      ...(column.max !== undefined ? { max: column.max } : {}),
    };
  }
  return bounds;
}

const SLUG_RE = /^[a-z][a-z0-9-]*$/;

export interface PluginAdminViolation {
  where: string;
  reason:
    | "invalid-resource-key"
    | "duplicate-resource-key"
    | "unknown-table"
    | "unknown-column"
    | "missing-read-permission"
    | "invalid-label"
    | "invalid-option"
    | "nav-unknown-resource"
    | "nav-missing-permission"
    | "unknown-ref-table"
    | "unknown-ref-column"
    | "unknown-child-resource"
    | "unknown-child-column";
  detail?: string;
}

/**
 * Validates a plugin's admin contribution against the tables it declared, at
 * install, before any of it can be rendered.
 *
 * The checks are all of one kind: everything the contribution names must resolve
 * to something the plugin actually owns. A resource must back onto a declared
 * table; a listed or edited column must exist on that table (or be a reserved
 * core column, which every plugin table has); a nav entry must open a resource
 * the plugin defined and carry a permission to gate it. A contribution that
 * dangles a reference is refused here, where the fix is the manifest, rather than
 * rendering to a broken screen later.
 *
 * Permission *strings* are checked for presence, not membership: whether a
 * declared permission was itself well-formed is `validateProvidedPermissions`'s
 * job, run beside this one at install.
 */
export function validateAdminContribution(
  admin: PluginAdminContribution | undefined,
  declaredTables: readonly PluginTableSchema[] | undefined,
): PluginAdminViolation[] {
  if (!admin) return [];

  const violations: PluginAdminViolation[] = [];
  const tables = new Map<string, Set<string>>();
  for (const table of declaredTables ?? []) {
    tables.set(
      table.name,
      new Set<string>([...RESERVED_COLUMNS, ...table.columns.map((c) => c.name)]),
    );
  }

  const resourceKeys = new Set<string>();
  for (const resource of admin.resources ?? []) {
    const at = `resource:${resource.key}`;

    if (!SLUG_RE.test(resource.key)) {
      violations.push({ where: at, reason: "invalid-resource-key", detail: resource.key });
      continue;
    }
    if (resourceKeys.has(resource.key)) {
      violations.push({ where: at, reason: "duplicate-resource-key", detail: resource.key });
      continue;
    }
    resourceKeys.add(resource.key);

    const columns = tables.get(resource.table);
    if (!columns) {
      violations.push({ where: at, reason: "unknown-table", detail: resource.table });
      continue;
    }

    if (!resource.permissions?.read) {
      violations.push({ where: at, reason: "missing-read-permission" });
    }

    if (!isValidLocalizedLabel(resource.label)) {
      violations.push({ where: at, reason: "invalid-label", detail: "resource" });
    }
    for (const column of resource.list.columns) {
      if (!isValidLocalizedLabel(column.label)) {
        violations.push({ where: at, reason: "invalid-label", detail: `column:${column.column}` });
      }
    }
    for (const field of resource.form?.fields ?? []) {
      if (!isValidLocalizedLabel(field.label)) {
        violations.push({ where: at, reason: "invalid-label", detail: `field:${field.column}` });
      }
      for (const option of field.options ?? []) {
        const value = typeof option === "string" ? option : option.value;
        if (!value || !value.trim()) {
          violations.push({ where: at, reason: "invalid-option", detail: field.column });
        } else if (typeof option !== "string" && !isValidLocalizedLabel(option.label)) {
          violations.push({ where: at, reason: "invalid-option", detail: `${field.column}:${value}` });
        }
      }
    }

    const named = [
      ...resource.list.columns.map((c) => c.column),
      ...resource.list.orderBy ? [resource.list.orderBy.column] : [],
      ...(resource.form?.fields ?? []).map((f) => f.column),
    ];
    for (const column of named) {
      if (!columns.has(column)) {
        violations.push({ where: at, reason: "unknown-column", detail: column });
      }
    }
  }

  /**
   * References and children are checked in a SECOND pass.
   *
   * Both point at other resources, and a manifest is free to declare them in any
   * order — a first pass would refuse a perfectly good forward reference. So the
   * first pass collects what exists and this one checks what points at it.
   */
  const byKey = new Map((admin.resources ?? []).map((r) => [r.key, r]));
  for (const resource of admin.resources ?? []) {
    const at = `resource:${resource.key}`;

    for (const field of resource.form?.fields ?? []) {
      if (field.input !== "reference") continue;
      const target = [...byKey.values()].find((r) => r.table === field.refTable);
      if (!field.refTable || !target) {
        // A picker with nothing to pick from is a text box asking for a uuid.
        violations.push({ where: at, reason: "unknown-ref-table", detail: field.column });
        continue;
      }
      const targetColumns = tables.get(target.table);
      for (const named of [field.refValue, field.refLabel]) {
        if (named && !targetColumns?.has(named)) {
          violations.push({ where: at, reason: "unknown-ref-column", detail: named });
        }
      }
    }

    for (const child of resource.children ?? []) {
      const target = byKey.get(child.resource);
      if (!target) {
        violations.push({ where: at, reason: "unknown-child-resource", detail: child.resource });
        continue;
      }
      if (!isValidLocalizedLabel(child.label)) {
        violations.push({ where: at, reason: "invalid-label", detail: `child:${child.resource}` });
      }
      if (!tables.get(target.table)?.has(child.foreignColumn)) {
        violations.push({ where: at, reason: "unknown-child-column", detail: child.foreignColumn });
      }
      const local = child.localColumn ?? "id";
      if (!tables.get(resource.table)?.has(local)) {
        violations.push({ where: at, reason: "unknown-child-column", detail: local });
      }
    }
  }

  for (const item of admin.nav ?? []) {
    const at = `nav:${item.resource}`;
    if (!resourceKeys.has(item.resource)) {
      violations.push({ where: at, reason: "nav-unknown-resource", detail: item.resource });
    }
    if (!item.permission) {
      violations.push({ where: at, reason: "nav-missing-permission" });
    }
    if (!isValidLocalizedLabel(item.label)) {
      violations.push({ where: at, reason: "invalid-label", detail: "nav" });
    }
  }

  return violations;
}

/** Normalize one field's choices to `{value,label}` for a reader, or undefined. */
export function resolvePluginFieldOptions(
  options: PluginFieldOption[] | undefined,
  locale: string,
): ResolvedPluginFieldOption[] | undefined {
  if (!options) return undefined;
  return options.map((option) =>
    typeof option === "string"
      ? { value: option, label: option }
      : { value: option.value, label: resolveLocalized(option.label, locale) },
  );
}

/**
 * Resolve every label on a resource for one reader and normalize its options.
 * The server calls this before handing a resource to the admin, so the client
 * only ever sees plain strings — see {@link ResolvedPluginAdminResource}.
 */
export function resolvePluginAdminResource(
  resource: PluginAdminResource,
  locale: string,
): ResolvedPluginAdminResource {
  return {
    ...resource,
    label: resolveLocalized(resource.label, locale),
    list: {
      ...resource.list,
      columns: resource.list.columns.map((column) => {
        // An editable cell's choices ARE the record form's, looked up here so the
        // two can never drift: a status added to the form appears in the list, and
        // a list cell can never offer one the record screen would refuse.
        const field = column.editable
          ? resource.form?.fields.find((f) => f.column === column.column)
          : undefined;
        const editOptions =
          field?.input === "select" && !field.readonly
            ? resolvePluginFieldOptions(field.options, locale)
            : undefined;
        return {
          column: column.column,
          label: resolveLocalized(column.label, locale),
          ...(editOptions?.length ? { editOptions } : {}),
        };
      }),
    },
    form: resource.form
      ? {
          fields: resource.form.fields.map((field) => ({
            ...field,
            label: resolveLocalized(field.label, locale),
            options: resolvePluginFieldOptions(field.options, locale),
          })),
        }
      : undefined,
  };
}

/** The input a form field uses when it does not override one, inferred from type. */
export function inferFieldInput(columnType: string): PluginFieldInput {
  switch (columnType) {
    case "integer":
    case "bigint":
    case "numeric":
      return "number";
    case "boolean":
      return "boolean";
    case "timestamptz":
      return "date";
    default:
      return "text";
  }
}
