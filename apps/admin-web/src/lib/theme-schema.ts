/**
 * The theme settings schema is JSON Schema (see packages/theme-sdk ThemeSettingsSchema):
 *
 *   { type: "object", properties: { key: { type, title?, description?, format?, default?, enum? } } }
 *
 * It is NOT exported from @zcmsorg/schemas — the SDK owns it — and admin-web must
 * not depend on the theme SDK, so the shape is mirrored here, deliberately
 * tolerant: an unknown `type` degrades to a text input rather than an empty
 * form. The whole point of this file is that adding a setting to a theme
 * requires zero changes in the admin.
 */

export type ThemeFieldType = "string" | "number" | "boolean";
export type ThemeFieldFormat = "color" | "url" | "image" | "textarea" | "password";

export interface ThemeSchemaProperty {
  type?: ThemeFieldType | string;
  title?: string;
  description?: string;
  format?: ThemeFieldFormat | string;
  default?: unknown;
  enum?: string[];
  minimum?: number;
  maximum?: number;
}

export interface ThemeSettingsSchema {
  type?: string;
  properties?: Record<string, ThemeSchemaProperty>;
  required?: string[];
  [key: string]: unknown;
}

export type ControlKind =
  | "text"
  | "textarea"
  | "number"
  | "boolean"
  | "color"
  | "url"
  | "password"
  | "image"
  | "enum";

export interface ThemeSettingControl {
  key: string;
  label: string;
  description?: string;
  kind: ControlKind;
  options: string[];
  defaultValue: unknown;
  required: boolean;
  min?: number;
  max?: number;
}

function kindOf(property: ThemeSchemaProperty): ControlKind {
  if (Array.isArray(property.enum) && property.enum.length > 0) return "enum";

  switch (property.format) {
    case "color":
      return "color";
    case "textarea":
      return "textarea";
    case "url":
      return "url";
    case "image":
      return "image";
    case "password":
      return "password";
    default:
      break;
  }

  switch (property.type) {
    case "boolean":
      return "boolean";
    case "number":
    case "integer":
      return "number";
    default:
      return "text";
  }
}

export function normalizeThemeSchema(schema: ThemeSettingsSchema | null): ThemeSettingControl[] {
  if (!schema) return [];

  // Tolerate a bare `{ key: {...} }` map as well as a proper JSON Schema object.
  const properties: Record<string, ThemeSchemaProperty> =
    schema.properties ??
    (Object.fromEntries(
      Object.entries(schema).filter(
        ([, value]) => value !== null && typeof value === "object" && !Array.isArray(value),
      ),
    ) as Record<string, ThemeSchemaProperty>);

  const required = new Set(schema.required ?? []);

  return Object.entries(properties).map(([key, property]) => ({
    key,
    label: property.title ?? key,
    description: property.description,
    kind: kindOf(property),
    options: property.enum ?? [],
    defaultValue: property.default,
    required: required.has(key),
    min: property.minimum,
    max: property.maximum,
  }));
}

/** Merges stored values over the schema defaults so an unset key still shows
 *  what the theme will actually use. */
export function resolveThemeValues(
  controls: ThemeSettingControl[],
  stored: Record<string, unknown>,
): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const control of controls) {
    values[control.key] =
      stored[control.key] !== undefined ? stored[control.key] : control.defaultValue;
  }
  // Keep keys the current schema no longer declares: a downgrade of the theme
  // must not silently destroy their values.
  for (const [key, value] of Object.entries(stored)) {
    if (!(key in values)) values[key] = value;
  }
  return values;
}
