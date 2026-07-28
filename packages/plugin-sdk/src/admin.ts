import { isValidLocalizedLabel, resolveLocalized, type LocalizedString } from "./localized";
import { RESERVED_COLUMNS, type PluginTableSchema } from "./table-schema";

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
}

export interface PluginResourceField {
  column: string;
  label: LocalizedString;
  /** Overrides the input inferred from the column's type. */
  input?: PluginFieldInput;
  /** Choices for a `select` input. */
  options?: PluginFieldOption[];
  /** For `reference`: the plugin table a chosen id points at (display hint). */
  refTable?: string;
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
   * The permissions that guard this resource. `read` gates the list and detail;
   * `write` gates create/update/delete and, absent, makes the resource read-only
   * for everyone regardless of role.
   */
  permissions: { read: string; write?: string };
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
export type ResolvedPluginResourceColumn = { column: string; label: string };
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
};

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
    | "nav-missing-permission";
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
      columns: resource.list.columns.map((column) => ({
        column: column.column,
        label: resolveLocalized(column.label, locale),
      })),
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
