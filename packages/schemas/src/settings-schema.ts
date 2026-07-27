/**
 * The settings-form schema a theme or a plugin declares — the single canonical
 * definition both SDKs build against and cms-api coerces with.
 *
 * It is a small JSON-Schema subset: an object of named properties, each a scalar
 * with an optional widget `format`, default and enum. The admin renders a form
 * straight from it, so adding a customisation option is a manifest change with no
 * admin-web edit. `@zcmsorg/schemas` is the shared home because everything that
 * touches it — `@zcmsorg/theme-sdk`, `@zcmsorg/plugin-sdk`, cms-api and admin-web —
 * already depends on this package, and none of them may depend on the SDKs.
 *
 * Note the two things this type does NOT do, both enforced elsewhere:
 *   - `format: "password"` masks the input AND withholds the value from a plugin
 *     sandbox (stripped before the isolate starts, spent only via
 *     `network.secrets`). That stripping is done in cms-api/plugin-runtime, not
 *     here — this type only records the intent. It is not encryption at rest.
 *   - Untrusted input is not parsed here. admin-web reads a possibly-malformed
 *     manifest with its own deliberately TOLERANT reader; this strict shape is the
 *     authoring contract, `coerceSettings` is the trust boundary on save.
 */
export type SettingsFieldType = "string" | "number" | "boolean";
export type SettingsFieldFormat = "color" | "url" | "image" | "textarea" | "password";

export interface SettingsProperty {
  type: SettingsFieldType;
  title?: string;
  description?: string;
  format?: SettingsFieldFormat;
  default?: unknown;
  enum?: string[];
  /** Numeric bounds, honoured by the admin's number control. */
  minimum?: number;
  maximum?: number;
}

export interface SettingsSchema {
  type: "object";
  properties: Record<string, SettingsProperty>;
  required?: string[];
}

/** The subset of a schema `coerceSettings` needs — kept loose so it accepts a raw, stored manifest. */
interface CoercibleSchema {
  properties?: Record<string, { type?: SettingsFieldType; enum?: string[] }>;
}

/**
 * Filters a settings payload down to what a schema actually declares — the trust
 * boundary between an admin-written JSONB blob and the theme/plugin code that
 * reads it.
 *
 * Deliberately LENIENT, and that is the design: unknown keys are DROPPED (a
 * setting removed in a new version must not make every saved blob un-saveable),
 * wrong types are coerced where unambiguous and skipped where not, and a single
 * bad field never rejects the whole save. A strict all-or-nothing validator would
 * be worse UX for exactly the person editing settings. One implementation, shared
 * by both plugin-settings controllers (and available to theme settings), so the
 * boundary is defined once.
 */
export function coerceSettings(
  schema: CoercibleSchema | undefined,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const properties = schema?.properties;
  if (!properties) return {};

  const out: Record<string, unknown> = {};
  for (const [key, def] of Object.entries(properties)) {
    if (!(key in input)) continue;
    const value = input[key];
    if (value === null || value === undefined) continue;

    switch (def.type) {
      case "boolean":
        out[key] = value === true || value === "true";
        break;
      case "number": {
        const n = Number(value);
        if (!Number.isNaN(n)) out[key] = n;
        break;
      }
      default: {
        const s = String(value);
        // An enum is a closed set; a value outside it is not a setting.
        if (def.enum?.length && !def.enum.includes(s)) break;
        out[key] = s;
      }
    }
  }
  return out;
}
