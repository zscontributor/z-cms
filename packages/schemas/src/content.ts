import { z } from "zod";
import { BlockDocumentSchema } from "./blocks";

/**
 * Is a URL safe to place in an `href`/`src` a browser will act on?
 *
 * `z.url()` validates URL *syntax*, which happily accepts `javascript:alert(1)`
 * and `data:text/html,...` — both of which execute script the moment the value
 * lands in a rendered attribute. Author-controlled SEO tags and profile avatars
 * flow to exactly those places, so the SCHEME is allowlisted here, at the
 * validation boundary, rather than trusting every renderer to remember.
 *
 * A relative URL (no scheme) is fine — it resolves against the site's own
 * origin and cannot carry a `javascript:` payload. Anything with a scheme must
 * be http or https. Control characters and spaces are stripped before the check
 * because browsers strip them too: `java\tscript:` is `javascript:` to them, and
 * would be to us if we did not.
 */
export function isBrowserSafeUrl(raw: string): boolean {
  const normalised = raw.replace(/[\u0000-\u0020]+/g, "").toLowerCase();
  const scheme = /^([a-z][a-z0-9+.-]*):/.exec(normalised)?.[1];
  return scheme === undefined || scheme === "http" || scheme === "https";
}

/** A string constrained to a browser-safe URL (relative, or http/https). */
export const SafeUrlSchema = z.string().refine(isBrowserSafeUrl, {
  message: "URL must be relative or use the http/https scheme.",
});

/** Field types a content type may declare. Kept small on purpose. */
export const FieldTypeSchema = z.enum([
  "text",
  "textarea",
  "richtext",
  "number",
  "boolean",
  "date",
  "select",
  "media",
  "reference",
  "json",
]);
export type FieldType = z.infer<typeof FieldTypeSchema>;

export const ContentTypeFieldSchema = z.object({
  key: z
    .string()
    .regex(/^[a-zA-Z][a-zA-Z0-9_]*$/, "Field key must be a valid identifier."),
  type: FieldTypeSchema,
  label: z.string().min(1),
  required: z.boolean().default(false),
  description: z.string().optional(),
  // For "select".
  options: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
  // For "reference": which content type key it points at.
  refContentType: z.string().optional(),
  defaultValue: z.unknown().optional(),
});
export type ContentTypeField = z.infer<typeof ContentTypeFieldSchema>;

export const ContentStatusSchema = z.enum([
  "DRAFT",
  "IN_REVIEW",
  "SCHEDULED",
  "PUBLISHED",
  "ARCHIVED",
]);
export type ContentStatus = z.infer<typeof ContentStatusSchema>;

export const SeoSchema = z.object({
  title: z.string().max(70).optional(),
  description: z.string().max(200).optional(),
  ogImage: SafeUrlSchema.optional(),
  noindex: z.boolean().optional(),
  canonical: SafeUrlSchema.optional(),
});

/**
 * Slugs are stored without a leading slash, and the homepage is the empty
 * string. The router turns "/" into "" and "/blog/x" into "x" under the "blog"
 * prefix, so a slug never carries routing information of its own.
 */
export const SlugSchema = z
  .string()
  .regex(/^$|^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message:
      'Slug must be lowercase words separated by hyphens, or empty for the homepage.',
  });

export const CreateContentSchema = z.object({
  contentTypeId: z.uuid(),
  title: z.string().min(1).max(300),
  slug: SlugSchema,
  /**
   * Omitted means "the site's default locale" — resolved by the API, which is the
   * only side that knows what that is.
   *
   * This used to default to "vi" here, which was a landmine: a site whose default
   * locale is English would silently file the entry as Vietnamese, and the router
   * would then serve it at /vi/… and nowhere else. The page would exist, be
   * PUBLISHED, and be invisible at the URL its author expected. A default that is
   * wrong for most sites is worse than no default at all.
   */
  locale: z.string().min(2).max(10).optional(),
  /**
   * Links this entry to the other language versions of the same page.
   *
   * Omitted for a genuinely new page — the database mints a fresh group, and the
   * page is the only member of it. Supplied when creating a *translation*: the
   * caller passes the group of the page being translated, and that is what makes
   * /about and /vi/gioi-thieu one page rather than two unrelated ones.
   */
  translationGroupId: z.uuid().optional(),
  excerpt: z.string().max(500).optional(),
  data: z.record(z.string(), z.unknown()).default({}),
  blocks: BlockDocumentSchema.default([]),
  seo: SeoSchema.default({}),
  status: ContentStatusSchema.default("DRAFT"),
  publishedAt: z.iso.datetime().optional(),
});
export type CreateContentInput = z.infer<typeof CreateContentSchema>;

/**
 * `translationGroupId` is not updatable, and that is deliberate.
 *
 * Re-parenting a page into another group is a real operation ("this Vietnamese
 * page is actually the translation of that English one"), but it is not an *edit*:
 * it silently changes which URLs point at each other, on both sides, including on
 * a page nobody is looking at. It needs its own endpoint and its own confirmation,
 * not a field that a form can carry along by accident.
 */
export const UpdateContentSchema = CreateContentSchema.partial().omit({
  contentTypeId: true,
  translationGroupId: true,
});
export type UpdateContentInput = z.infer<typeof UpdateContentSchema>;

export const CreateContentTypeSchema = z.object({
  key: z
    .string()
    .regex(/^[a-z][a-z0-9-]*$/, "Content type key must be lowercase kebab-case."),
  name: z.string().min(1),
  pluralName: z.string().min(1),
  description: z.string().optional(),
  isSingleton: z.boolean().default(false),
  isRoutable: z.boolean().default(true),
  routePrefix: z
    .string()
    .regex(/^$|^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .default(""),
  hasBlocks: z.boolean().default(true),
  icon: z.string().optional(),
  fields: z.array(ContentTypeFieldSchema).default([]),
});
export type CreateContentTypeInput = z.infer<typeof CreateContentTypeSchema>;

/**
 * Validates a content's `data` against the field definitions of its type.
 * Built at runtime because the shape is defined by the customer, not by us.
 */
export function buildContentDataSchema(fields: ContentTypeField[]) {
  const shape: Record<string, z.ZodTypeAny> = {};

  for (const field of fields) {
    let schema: z.ZodTypeAny;
    switch (field.type) {
      case "number":
        schema = z.number();
        break;
      case "boolean":
        schema = z.boolean();
        break;
      case "date":
        schema = z.iso.datetime();
        break;
      case "select":
        schema = field.options?.length
          ? z.enum(field.options.map((o) => o.value) as [string, ...string[]])
          : z.string();
        break;
      case "media":
      case "reference":
        schema = z.uuid();
        break;
      case "json":
        schema = z.unknown();
        break;
      default:
        schema = z.string();
    }
    shape[field.key] = field.required ? schema : schema.optional();
  }

  // Unknown keys are stripped rather than rejected: removing a field from a
  // content type must not make every existing row un-saveable.
  return z.object(shape);
}
