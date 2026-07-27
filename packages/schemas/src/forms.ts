import { z } from "zod";

/**
 * Public-site forms: one declaration, validated identically on the client and the
 * server.
 *
 * The whole point of this module is to end a class of bug rather than one instance
 * of it. Before it, every front-end form (contact, checkout) hardcoded its fields
 * in three unrelated places — the theme markup, the runtime proxy route, and a
 * bespoke server Zod schema — and only the server actually validated. So the
 * browser's loose `type="email"` accepted `aa@aa`, the request went all the way to
 * cms-api, and the visitor got a generic "couldn't send" with no idea which field
 * was wrong.
 *
 * Here a form is a list of {@link FormField}s, declared ONCE. {@link buildFormSchema}
 * derives the authoritative Zod validator the server runs; {@link toClientRules}
 * projects the same fields to a tiny JSON the runtime's client enhancer interprets
 * for instant, matching validation — no second copy of the rules, no drift.
 *
 * A specific form (contact, below) is just a `FormField[]`. Wiring a form's submit
 * to a handler is a separate concern (today: the contact route; later: a generic
 * forms endpoint / a plugin `form.submit` capability) — this module is only the
 * field + validation vocabulary both ends share.
 */

export const FORM_FIELD_TYPES = [
  "text",
  "textarea",
  "email",
  "tel",
  "url",
  "number",
  "select",
] as const;
export type FormFieldType = (typeof FORM_FIELD_TYPES)[number];

/** A field name is the submitted key and must be a plain identifier. */
export const FIELD_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_]*$/;
/** A form id is a stable, url-safe slug (it appears in `/forms/<id>/submit`). */
export const FORM_ID_RE = /^[a-z][a-z0-9-]{1,63}$/;

/**
 * The canonical field schema. `FormField` is DERIVED from it (`z.infer`) so the
 * type a form author writes and the schema that validates a declaration can never
 * drift apart — the mistake the survey found across the admin dialects.
 */
export const FormFieldSchema = z.object({
  /** The `name` attribute the value is submitted under. */
  name: z.string().regex(FIELD_NAME_RE),
  type: z.enum(FORM_FIELD_TYPES),
  /** A value must be present and non-empty. */
  required: z.boolean().optional(),
  /** String length bounds (text/textarea/tel/email/url). */
  minLength: z.int().nonnegative().max(100_000).optional(),
  maxLength: z.int().positive().max(500_000).optional(),
  /** Numeric bounds (number). */
  min: z.number().optional(),
  max: z.number().optional(),
  /** A regular-expression source a text value must match. */
  pattern: z.string().max(500).optional(),
  /** Allowed values (select). */
  options: z.array(z.string().max(200)).max(200).optional(),
  /** Human label (rendering); optional because a theme may label its own inputs. */
  label: z.string().max(200).optional(),
});

export type FormField = z.infer<typeof FormFieldSchema>;

/**
 * A declared form: a stable id plus its fields. Plugins (and core) declare these;
 * cms-api validates a submission against `buildFormSchema(fields)` and the runtime
 * validates the same rules client-side via `toClientRules`.
 */
export const FormDefinitionSchema = z.object({
  id: z.string().regex(FORM_ID_RE),
  title: z.string().max(200).optional(),
  fields: z.array(FormFieldSchema).min(1).max(50),
  submitLabel: z.string().max(80).optional(),
  /** A short success message key/text the handler confirms with (optional). */
  successMessage: z.string().max(500).optional(),
});

export type FormDefinition = z.infer<typeof FormDefinitionSchema>;

/**
 * A form projected for the browser — what the render payload carries and a
 * `core/form` block renders.
 *
 * Structurally this IS a `FormDefinition`: a form declaration has no secrets (every
 * field is presentational; the plugin's HANDLER lives in `calls`, never in the
 * manifest), so nothing has to be stripped. The `PublicFormDef` name marks the
 * "core decides what reaches the page" boundary — the same role a capability
 * projector plays — and gives us a place to narrow later if a private field is
 * ever added to a declaration.
 */
export type PublicFormField = FormField;
export type PublicFormDef = FormDefinition;

/** The projection boundary: a declared form as the browser may see it. */
export function toPublicForm(def: FormDefinition): PublicFormDef {
  return FormDefinitionSchema.parse(def);
}

/** Validates a list of declared forms (e.g. at plugin install). Returns error strings. */
export function validateFormDefinitions(forms: unknown): string[] {
  // A plugin with no forms is the common case, not an error.
  if (forms == null) return [];
  const parsed = z.array(FormDefinitionSchema).safeParse(forms);
  if (!parsed.success) {
    return parsed.error.issues.map(
      (i) => `forms.${i.path.join(".") || "(root)"}: ${i.message}`,
    );
  }
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const form of parsed.data) {
    if (seen.has(form.id)) errors.push(`forms: duplicate form id "${form.id}"`);
    seen.add(form.id);
    const names = new Set<string>();
    for (const f of form.fields) {
      if (names.has(f.name)) errors.push(`forms.${form.id}: duplicate field "${f.name}"`);
      names.add(f.name);
      if (f.pattern != null) {
        try {
          new RegExp(f.pattern);
        } catch {
          errors.push(`forms.${form.id}.${f.name}: invalid pattern`);
        }
      }
    }
  }
  return errors;
}

/**
 * The authoritative Zod validator for a form's submitted values (server-side).
 *
 * Built at runtime from the declared fields — the same technique as
 * `buildContentDataSchema`. Unknown keys are stripped (Zod objects strip by
 * default), so a form gaining or losing a field never makes an in-flight
 * submission un-parseable. Optional fields accept an empty string, because an HTML
 * form posts `""` for a blank, not "absent".
 */
export function buildFormSchema(fields: FormField[]): z.ZodObject {
  const shape: Record<string, z.ZodTypeAny> = {};

  for (const f of fields) {
    let base: z.ZodTypeAny;

    switch (f.type) {
      case "email": {
        let e = z.email();
        if (f.maxLength != null) e = e.max(f.maxLength);
        base = e;
        break;
      }
      case "url": {
        let u = z.url();
        if (f.maxLength != null) u = u.max(f.maxLength);
        base = u;
        break;
      }
      case "number": {
        let n = z.coerce.number();
        if (f.min != null) n = n.min(f.min);
        if (f.max != null) n = n.max(f.max);
        base = n;
        break;
      }
      case "select": {
        base = f.options?.length
          ? z.enum(f.options as [string, ...string[]])
          : z.string();
        break;
      }
      default: {
        // text | textarea | tel
        let s = z.string().trim();
        // A required string must be non-empty; an explicit minLength wins.
        const min = f.minLength ?? (f.required ? 1 : undefined);
        if (min != null) s = s.min(min);
        if (f.maxLength != null) s = s.max(f.maxLength);
        if (f.pattern != null) s = s.regex(new RegExp(f.pattern));
        base = s;
      }
    }

    // Optional: accept the field being omitted, or posted as "".
    shape[f.name] = f.required ? base : z.union([base, z.literal("")]).optional();
  }

  return z.object(shape);
}

/** The browser-safe projection of a field's rules — no Zod, just data. */
export interface FormClientRule {
  name: string;
  type: FormFieldType;
  required?: boolean;
  minLength?: number;
  maxLength?: number;
  min?: number;
  max?: number;
  pattern?: string;
}

/**
 * Projects fields to the rule list the runtime embeds for its client validator.
 *
 * Deliberately Zod-free and JSON-serialisable: the client enhancer is an inline
 * script with no module system, so it cannot run Zod — it interprets these rules
 * directly. They are the SAME rules `buildFormSchema` enforces, so client and
 * server never disagree.
 */
export function toClientRules(fields: FormField[]): FormClientRule[] {
  return fields.map((f) => ({
    name: f.name,
    type: f.type,
    ...(f.required ? { required: true } : {}),
    ...(f.minLength != null ? { minLength: f.minLength } : {}),
    ...(f.maxLength != null ? { maxLength: f.maxLength } : {}),
    ...(f.min != null ? { min: f.min } : {}),
    ...(f.max != null ? { max: f.max } : {}),
    ...(f.pattern != null ? { pattern: f.pattern } : {}),
  }));
}

/**
 * The contact form's fields — the first form declared through this layer, and the
 * single source both cms-api (validation) and site-runtime (the client enhancer)
 * read. Mirrors what the old bespoke `ContactSubmissionSchema` checked.
 */
export const CONTACT_FORM_FIELDS: FormField[] = [
  { name: "name", type: "text", required: true, maxLength: 200 },
  { name: "company", type: "text", maxLength: 200 },
  { name: "email", type: "email", required: true, maxLength: 320 },
  { name: "need", type: "text", maxLength: 200 },
  { name: "message", type: "textarea", required: true, maxLength: 5000 },
];
