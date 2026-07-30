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
  /**
   * A calendar day, `YYYY-MM-DD`. The browser gets `<input type="date">` — its own
   * native picker, in the visitor's own locale and calendar — which is the whole
   * reason this is a TYPE and not a `text` field with a pattern: a pattern can
   * reject "next tuesday", it cannot offer a calendar. Validated as a real date on
   * both sides, so "2026-02-30" is refused rather than stored.
   */
  "date",
  "select",
] as const;
export type FormFieldType = (typeof FORM_FIELD_TYPES)[number];

/** A field name is the submitted key and must be a plain identifier. */
export const FIELD_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_]*$/;
/** A form id is a stable, url-safe slug (it appears in `/forms/<id>/submit`). */
export const FORM_ID_RE = /^[a-z][a-z0-9-]{1,63}$/;
/** `YYYY-MM-DD` — the shape `<input type="date">` submits. */
export const DATE_VALUE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Author-facing text, in one language or several: `"Phone number"`, or
 * `{ en: "Phone number", vi: "Số điện thoại" }`.
 *
 * A plugin ships ONE manifest to every site, so a form whose labels are a plain
 * string is a form that is English on a Vietnamese clinic's website — the visitor
 * side of the localized-admin-labels problem, and the same answer: the declaration
 * carries every language, and the RENDER side picks one. Resolution happens in
 * `toPublicForm`, server-side, so the browser is handed a single language and
 * `FormIsland` never has to know this shape exists.
 */
function localized(max: number) {
  return z.union([
    z.string().max(max),
    // Keys are BCP-47-ish locale codes; the values are what a visitor reads.
    z.record(z.string().regex(/^[a-z]{2}(?:-[A-Za-z0-9]{2,8})*$/), z.string().max(max)),
  ]);
}

export const LocalizedFormTextSchema = localized(500);
export type LocalizedFormText = z.infer<typeof LocalizedFormTextSchema>;

/**
 * One choice of a `select`: a bare value (label = value), or a value with its own
 * localizable label.
 *
 * The VALUE is what gets submitted, validated and stored, so it stays stable across
 * languages — a Vietnamese visitor and an English one choosing the same service
 * produce the same row, and the label is presentation only.
 */
export const FormOptionSchema = z.union([
  z.string().max(200),
  z.object({ value: z.string().max(200), label: localized(200).optional() }),
]);
export type FormOption = z.infer<typeof FormOptionSchema>;

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
  options: z.array(FormOptionSchema).max(200).optional(),
  /** Human label (rendering); optional because a theme may label its own inputs. */
  label: localized(200).optional(),
});

export type FormField = z.infer<typeof FormFieldSchema>;

/**
 * A declared form: a stable id plus its fields. Plugins (and core) declare these;
 * cms-api validates a submission against `buildFormSchema(fields)` and the runtime
 * validates the same rules client-side via `toClientRules`.
 */
export const FormDefinitionSchema = z.object({
  id: z.string().regex(FORM_ID_RE),
  title: localized(200).optional(),
  fields: z.array(FormFieldSchema).min(1).max(50),
  submitLabel: localized(80).optional(),
  /** A short success message key/text the handler confirms with (optional). */
  successMessage: localized(500).optional(),
});

export type FormDefinition = z.infer<typeof FormDefinitionSchema>;

/**
 * One language out of a localizable declaration.
 *
 * Falls back deliberately rather than returning nothing: the exact locale, then its
 * base language ("vi" for "vi-VN"), then English, then whatever the author did
 * write. A form with a label in one language must still render a label everywhere —
 * an untranslated field is a smaller problem than a nameless input.
 */
export function resolveFormText(
  text: LocalizedFormText | undefined,
  locale: string,
): string | undefined {
  if (text == null) return undefined;
  if (typeof text === "string") return text;
  const base = locale.split("-")[0] ?? locale;
  return text[locale] ?? text[base] ?? text.en ?? Object.values(text)[0];
}

/** The value a select option submits — what validation and storage see. */
export function optionValue(option: FormOption): string {
  return typeof option === "string" ? option : option.value;
}

/** A select field's allowed values, whichever option shape the author used. */
export function optionValues(field: Pick<FormField, "options">): string[] {
  return (field.options ?? []).map(optionValue);
}

/**
 * A form projected for the browser — what the render payload carries and a
 * `core/form` block renders.
 *
 * A declaration has no secrets (every field is presentational; the plugin's HANDLER
 * lives in `calls`, never in the manifest), so nothing is *stripped* here. What the
 * projection does is RESOLVE: every localizable text becomes one string, in the
 * locale being rendered, and every option becomes a `{value,label}` pair. So the
 * browser is handed one language and one option shape, and the renderer stays a
 * renderer — no locale fallback logic, no union types, in a client component.
 *
 * It remains the "core decides what reaches the page" boundary, the same role a
 * capability projector plays, and the place to narrow further if a private field is
 * ever added to a declaration.
 */
export interface PublicFormOption {
  value: string;
  label: string;
}

export interface PublicFormField {
  name: string;
  type: FormFieldType;
  required?: boolean;
  minLength?: number;
  maxLength?: number;
  min?: number;
  max?: number;
  pattern?: string;
  options?: PublicFormOption[];
  label?: string;
}

export interface PublicFormDef {
  id: string;
  title?: string;
  fields: PublicFormField[];
  submitLabel?: string;
  successMessage?: string;
}

/** The public projection as a schema, for the OpenAPI document. */
export const PublicFormDefSchema = z.object({
  id: z.string(),
  title: z.string().optional(),
  fields: z.array(
    z.object({
      name: z.string(),
      type: z.enum(FORM_FIELD_TYPES),
      required: z.boolean().optional(),
      minLength: z.int().optional(),
      maxLength: z.int().optional(),
      min: z.number().optional(),
      max: z.number().optional(),
      pattern: z.string().optional(),
      options: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
      label: z.string().optional(),
    }),
  ),
  submitLabel: z.string().optional(),
  successMessage: z.string().optional(),
});

/**
 * The projection boundary: a declared form as the browser may see it, in one locale.
 *
 * `locale` defaults to English so a caller that has no locale to hand (a test, a
 * tool) still gets a usable form rather than having to invent one.
 */
export function toPublicForm(def: FormDefinition, locale = "en"): PublicFormDef {
  const parsed = FormDefinitionSchema.parse(def);
  const text = (value: LocalizedFormText | undefined) => resolveFormText(value, locale);

  return {
    id: parsed.id,
    ...(text(parsed.title) ? { title: text(parsed.title)! } : {}),
    ...(text(parsed.submitLabel) ? { submitLabel: text(parsed.submitLabel)! } : {}),
    ...(text(parsed.successMessage)
      ? { successMessage: text(parsed.successMessage)! }
      : {}),
    fields: parsed.fields.map((field) => {
      const { label, options, ...rest } = field;
      return {
        ...rest,
        ...(text(label) ? { label: text(label)! } : {}),
        ...(options
          ? {
              options: options.map((option) => ({
                value: optionValue(option),
                label:
                  (typeof option === "string" ? undefined : text(option.label)) ??
                  optionValue(option),
              })),
            }
          : {}),
      };
    }),
  };
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
 * Is `YYYY-MM-DD` a day that exists? Parsed as UTC and compared back, so no
 * timezone can shift a date across a boundary and no month can overflow silently
 * (`new Date("2026-02-30")` is happy to become 2 March).
 */
export function isRealCalendarDate(value: string): boolean {
  const [y, m, d] = value.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return (
    date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d
  );
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
      case "date": {
        // Shape first, then reality: "2026-02-30" matches the pattern and is not a
        // date. `Date.UTC` round-trips it, which is the cheapest honest check.
        base = z
          .string()
          .regex(DATE_VALUE_RE)
          .refine(isRealCalendarDate, { message: "Not a valid calendar date." });
        break;
      }
      case "select": {
        const values = optionValues(f);
        base = values.length ? z.enum(values as [string, ...string[]]) : z.string();
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
