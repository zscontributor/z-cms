/**
 * The admin's TOLERANT reader for a theme/plugin settings schema.
 *
 * The strict authoring shape is the shared `SettingsSchema` in `@zcmsorg/schemas`
 * (what a theme/plugin declares, what cms-api coerces with). This file is not a
 * duplicate of it but its deliberately loose counterpart: admin-web parses a
 * possibly-malformed manifest it does not control, so every field is optional and
 * an unknown `type`/`format` degrades to a text input rather than an empty form.
 * The base scalar/format unions are reused from the canonical type; the `| string`
 * slack is what keeps a strange manifest renderable instead of a type error.
 */
import type { SettingsFieldFormat, SettingsFieldType } from "@zcmsorg/schemas";

export type ThemeFieldType = SettingsFieldType;
export type ThemeFieldFormat = SettingsFieldFormat;

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
