import { describe, expect, it } from "vitest";
import {
  ContentStatusSchema,
  ContentTypeFieldSchema,
  CreateContentSchema,
  CreateContentTypeSchema,
  FieldTypeSchema,
  SeoSchema,
  SlugSchema,
  UpdateContentSchema,
  buildContentDataSchema,
  type ContentTypeField,
} from "../content";

/**
 * content.ts is the write path for every page in the CMS. A CreateContent body
 * that parses becomes a database row; a slug that parses becomes part of a URL.
 * These tests assert the defaults (a silently changed default is an API break)
 * and that hostile slugs / keys / oversize strings are refused at the boundary.
 */

const UUID = "11111111-1111-4111-8111-111111111111";
const NUL = String.fromCharCode(0);

/** The minimum a CreateContent body needs; everything else is defaulted. */
function minimalCreate(overrides: Record<string, unknown> = {}) {
  return { contentTypeId: UUID, title: "Hello", slug: "hello", ...overrides };
}

describe("FieldTypeSchema", () => {
  it("accepts each declared field type", () => {
    for (const t of [
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
    ]) {
      expect(FieldTypeSchema.parse(t)).toBe(t);
    }
  });

  it("rejects a field type outside the small allowed set", () => {
    // The set is small on purpose; "html" or "raw" would be a new rendering path.
    expect(FieldTypeSchema.safeParse("html").success).toBe(false);
  });
});

describe("ContentTypeFieldSchema", () => {
  it("defaults required to false when it is omitted", () => {
    // A field that becomes required-by-default would make every existing content
    // row for that type fail validation on its next save.
    const parsed = ContentTypeFieldSchema.parse({ key: "title", type: "text", label: "Title" });

    expect(parsed.required).toBe(false);
  });

  it("accepts a valid identifier key", () => {
    expect(ContentTypeFieldSchema.parse({ key: "sub_title2", type: "text", label: "L" }).key).toBe(
      "sub_title2",
    );
  });

  it("rejects a key that starts with a digit", () => {
    // The key becomes an object property and often a column-like identifier; it
    // must be a safe identifier, not "1; DROP".
    expect(
      ContentTypeFieldSchema.safeParse({ key: "1bad", type: "text", label: "L" }).success,
    ).toBe(false);
  });

  it("rejects a key containing a hyphen", () => {
    expect(
      ContentTypeFieldSchema.safeParse({ key: "sub-title", type: "text", label: "L" }).success,
    ).toBe(false);
  });

  it("rejects a key containing a newline", () => {
    // Regex anchors ^$ in JS match line boundaries only with the m flag, but a raw
    // ^...$ still lets a trailing newline slip past in many engines. This asserts
    // the schema actually refuses it.
    expect(
      ContentTypeFieldSchema.safeParse({ key: "ok\nevil", type: "text", label: "L" }).success,
    ).toBe(false);
  });

  it("reports the issue path pointing at the key", () => {
    const result = ContentTypeFieldSchema.safeParse({ key: "1", type: "text", label: "L" });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.path).toEqual(["key"]);
  });

  it("rejects an empty label", () => {
    expect(
      ContentTypeFieldSchema.safeParse({ key: "k", type: "text", label: "" }).success,
    ).toBe(false);
  });

  it("keeps select options when supplied", () => {
    const parsed = ContentTypeFieldSchema.parse({
      key: "size",
      type: "select",
      label: "Size",
      options: [{ value: "s", label: "Small" }],
    });

    expect(parsed.options).toEqual([{ value: "s", label: "Small" }]);
  });

  it("strips unknown keys rather than passing them through", () => {
    // This object is stored as part of a content type definition. An unknown key
    // must not survive the parse into that stored shape.
    const parsed = ContentTypeFieldSchema.parse({
      key: "k",
      type: "text",
      label: "L",
      evil: "x",
    }) as Record<string, unknown>;

    expect("evil" in parsed).toBe(false);
  });
});

describe("ContentStatusSchema", () => {
  it("accepts each lifecycle status", () => {
    for (const s of ["DRAFT", "IN_REVIEW", "SCHEDULED", "PUBLISHED", "ARCHIVED"]) {
      expect(ContentStatusSchema.parse(s)).toBe(s);
    }
  });

  it("rejects a status that is not part of the lifecycle", () => {
    expect(ContentStatusSchema.safeParse("DELETED").success).toBe(false);
  });

  it("rejects a lowercase status", () => {
    expect(ContentStatusSchema.safeParse("draft").success).toBe(false);
  });
});

describe("SeoSchema", () => {
  it("accepts an empty object, since every field is optional", () => {
    expect(SeoSchema.parse({})).toEqual({});
  });

  it("rejects a title longer than 70 characters", () => {
    // A cap that regresses would let an over-long <title> through into the head.
    expect(SeoSchema.safeParse({ title: "a".repeat(71) }).success).toBe(false);
  });

  it("accepts a title of exactly 70 characters", () => {
    expect(SeoSchema.safeParse({ title: "a".repeat(70) }).success).toBe(true);
  });

  it("rejects a description longer than 200 characters", () => {
    expect(SeoSchema.safeParse({ description: "a".repeat(201) }).success).toBe(false);
  });

  it("strips unknown SEO keys rather than passing them through", () => {
    const parsed = SeoSchema.parse({ title: "T", evil: 1 }) as Record<string, unknown>;

    expect("evil" in parsed).toBe(false);
  });
});

describe("SlugSchema", () => {
  it("accepts a lowercase hyphenated slug", () => {
    expect(SlugSchema.parse("blog-post-1")).toBe("blog-post-1");
  });

  it("accepts the empty string as the homepage slug", () => {
    // Documented contract: "" is the homepage. If this regresses, the homepage
    // becomes uncreatable.
    expect(SlugSchema.parse("")).toBe("");
  });

  it("rejects a slug containing a path separator", () => {
    // A "/" in a stored slug is routing information the router does not expect and
    // a way to point one page at another's path.
    expect(SlugSchema.safeParse("blog/post").success).toBe(false);
  });

  it("rejects a slug containing a path traversal", () => {
    // The single most important case in this file: "../" in a slug that is later
    // joined into a filesystem or cache path is directory traversal.
    expect(SlugSchema.safeParse("../../etc/passwd").success).toBe(false);
  });

  it("rejects a slug with a leading hyphen", () => {
    expect(SlugSchema.safeParse("-evil").success).toBe(false);
  });

  it("rejects a slug with a trailing hyphen", () => {
    expect(SlugSchema.safeParse("evil-").success).toBe(false);
  });

  it("rejects a slug with consecutive hyphens", () => {
    expect(SlugSchema.safeParse("a--b").success).toBe(false);
  });

  it("rejects an uppercase slug", () => {
    expect(SlugSchema.safeParse("Hello").success).toBe(false);
  });

  it("rejects a slug containing whitespace", () => {
    expect(SlugSchema.safeParse("hello world").success).toBe(false);
  });

  it("rejects a slug containing a NUL byte", () => {
    // "safe\0../../evil" reads as "safe" to a validator that stops at NUL but as
    // the traversal to a C-backed path consumer.
    expect(SlugSchema.safeParse(`safe${NUL}evil`).success).toBe(false);
  });

  it("rejects a slug that is only a newline, despite the empty-string branch", () => {
    // The regex allows "" (empty) as an alternative; a bare newline must NOT be
    // treated as equivalent to empty.
    expect(SlugSchema.safeParse("\n").success).toBe(false);
  });
});

describe("CreateContentSchema", () => {
  it("fills every documented default when only the required fields are given", () => {
    // Locks the default output shape. data:{}, blocks:[], seo:{}, status:DRAFT are
    // an API contract that admin-web and cms-api both rely on.
    const parsed = CreateContentSchema.parse(minimalCreate());

    expect(parsed.data).toEqual({});
    expect(parsed.blocks).toEqual([]);
    expect(parsed.seo).toEqual({});
    expect(parsed.status).toBe("DRAFT");
  });

  it("does NOT default the locale, so the API resolves the site default", () => {
    // Regression guard for a documented past bug: locale used to default to "vi",
    // which mis-filed English pages. It must arrive undefined here.
    const parsed = CreateContentSchema.parse(minimalCreate());

    expect(parsed.locale).toBeUndefined();
  });

  it("requires a contentTypeId that is a UUID", () => {
    expect(CreateContentSchema.safeParse(minimalCreate({ contentTypeId: "not-a-uuid" })).success).toBe(
      false,
    );
  });

  it("rejects a missing title", () => {
    const body = minimalCreate();
    delete (body as Record<string, unknown>).title;

    expect(CreateContentSchema.safeParse(body).success).toBe(false);
  });

  it("rejects an empty title", () => {
    expect(CreateContentSchema.safeParse(minimalCreate({ title: "" })).success).toBe(false);
  });

  it("rejects a title longer than 300 characters", () => {
    expect(CreateContentSchema.safeParse(minimalCreate({ title: "a".repeat(301) })).success).toBe(
      false,
    );
  });

  it("rejects a hostile slug embedded in an otherwise valid body", () => {
    // The whole body is the attack surface, not the slug in isolation.
    expect(CreateContentSchema.safeParse(minimalCreate({ slug: "../secret" })).success).toBe(
      false,
    );
  });

  it("rejects a locale shorter than the two-character minimum", () => {
    expect(CreateContentSchema.safeParse(minimalCreate({ locale: "e" })).success).toBe(false);
  });

  it("rejects a locale longer than ten characters", () => {
    expect(CreateContentSchema.safeParse(minimalCreate({ locale: "x".repeat(11) })).success).toBe(
      false,
    );
  });

  it("rejects an excerpt longer than 500 characters", () => {
    expect(CreateContentSchema.safeParse(minimalCreate({ excerpt: "a".repeat(501) })).success).toBe(
      false,
    );
  });

  it("rejects a translationGroupId that is not a UUID", () => {
    expect(
      CreateContentSchema.safeParse(minimalCreate({ translationGroupId: "nope" })).success,
    ).toBe(false);
  });

  it("rejects a non-ISO publishedAt", () => {
    expect(CreateContentSchema.safeParse(minimalCreate({ publishedAt: "yesterday" })).success).toBe(
      false,
    );
  });

  it("accepts an ISO datetime for publishedAt", () => {
    expect(
      CreateContentSchema.safeParse(minimalCreate({ publishedAt: "2026-07-12T10:00:00Z" }))
        .success,
    ).toBe(true);
  });

  it("strips unknown top-level keys rather than writing them through", () => {
    // MASS-ASSIGNMENT GUARD on the primary write path. If an extra field like
    // authorId or siteId survived this parse it would flow into the create() call.
    // z.object strips by default — this asserts it, so a switch to .passthrough()
    // (or a .catchall) is caught immediately.
    const parsed = CreateContentSchema.parse(
      minimalCreate({ authorId: "attacker", siteId: "other-tenant" }),
    ) as Record<string, unknown>;

    expect("authorId" in parsed).toBe(false);
    expect("siteId" in parsed).toBe(false);
  });

  it("validates nested blocks and rejects a malformed one", () => {
    expect(
      CreateContentSchema.safeParse(
        minimalCreate({ blocks: [{ id: "a", type: "no-namespace", props: {} }] }),
      ).success,
    ).toBe(false);
  });
});

describe("UpdateContentSchema", () => {
  it("accepts an empty body but still applies the field defaults", () => {
    // CHARACTERISATION: .partial() makes every top-level key optional, yet the
    // fields that carry .default() (data, blocks, seo, status) still MATERIALISE
    // their defaults on an empty PATCH. See the bug note returned with these tests:
    // a blind PATCH {} would reset status to DRAFT and wipe blocks/seo/data unless
    // the service copies from `existing` (it does). This test pins that behaviour.
    const parsed = UpdateContentSchema.parse({});

    expect(parsed).toEqual({ data: {}, blocks: [], seo: {}, status: "DRAFT" });
  });

  it("does not accept contentTypeId, because the content type cannot change", () => {
    // omit() must actually remove it: allowing it back would let an edit re-home a
    // page onto a different content type.
    const parsed = UpdateContentSchema.parse({ contentTypeId: UUID }) as Record<string, unknown>;

    expect("contentTypeId" in parsed).toBe(false);
  });

  it("does not accept translationGroupId, because re-parenting is not an edit", () => {
    // Documented: re-parenting silently rewires which URLs point at each other and
    // needs its own confirmed endpoint. A PATCH must not carry it along.
    const parsed = UpdateContentSchema.parse({ translationGroupId: UUID }) as Record<
      string,
      unknown
    >;

    expect("translationGroupId" in parsed).toBe(false);
  });

  it("accepts a partial update of a single field", () => {
    const parsed = UpdateContentSchema.parse({ title: "New title" });

    expect(parsed.title).toBe("New title");
  });

  it("still rejects a hostile slug on the update path", () => {
    expect(UpdateContentSchema.safeParse({ slug: "../escape" }).success).toBe(false);
  });
});

describe("CreateContentTypeSchema", () => {
  it("applies the routing and structure defaults", () => {
    // These defaults decide whether a content type has URLs and blocks at all.
    const parsed = CreateContentTypeSchema.parse({ key: "post", name: "Post", pluralName: "Posts" });

    expect(parsed.isSingleton).toBe(false);
    expect(parsed.isRoutable).toBe(true);
    expect(parsed.routePrefix).toBe("");
    expect(parsed.hasBlocks).toBe(true);
    expect(parsed.fields).toEqual([]);
  });

  it("rejects a key that is not lowercase kebab-case", () => {
    expect(CreateContentTypeSchema.safeParse({ key: "Post", name: "n", pluralName: "p" }).success).toBe(
      false,
    );
  });

  it("rejects a key with a leading hyphen", () => {
    expect(CreateContentTypeSchema.safeParse({ key: "-x", name: "n", pluralName: "p" }).success).toBe(
      false,
    );
  });

  it("rejects a routePrefix that is a path traversal", () => {
    // routePrefix is joined into every URL of the type; "../" here would poison all
    // of them at once.
    expect(
      CreateContentTypeSchema.safeParse({
        key: "post",
        name: "n",
        pluralName: "p",
        routePrefix: "../admin",
      }).success,
    ).toBe(false);
  });

  it("rejects an empty name", () => {
    expect(CreateContentTypeSchema.safeParse({ key: "post", name: "", pluralName: "p" }).success).toBe(
      false,
    );
  });

  it("rejects an empty pluralName", () => {
    expect(CreateContentTypeSchema.safeParse({ key: "post", name: "n", pluralName: "" }).success).toBe(
      false,
    );
  });

  it("rejects a field whose key is invalid, deep inside the fields array", () => {
    expect(
      CreateContentTypeSchema.safeParse({
        key: "post",
        name: "n",
        pluralName: "p",
        fields: [{ key: "1bad", type: "text", label: "L" }],
      }).success,
    ).toBe(false);
  });
});

describe("buildContentDataSchema", () => {
  const field = (o: Partial<ContentTypeField> & Pick<ContentTypeField, "key" | "type">) =>
    ({ label: o.key, required: false, ...o }) as ContentTypeField;

  it("coerces a number field to reject a string", () => {
    const schema = buildContentDataSchema([field({ key: "n", type: "number", required: true })]);

    expect(schema.safeParse({ n: 42 }).success).toBe(true);
    expect(schema.safeParse({ n: "42" }).success).toBe(false);
  });

  it("requires a required field and rejects the body that omits it", () => {
    const schema = buildContentDataSchema([field({ key: "n", type: "number", required: true })]);

    const result = schema.safeParse({});
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.path).toEqual(["n"]);
  });

  it("treats an optional field as safe to omit", () => {
    const schema = buildContentDataSchema([field({ key: "n", type: "number", required: false })]);

    expect(schema.safeParse({}).success).toBe(true);
  });

  it("validates a boolean field", () => {
    const schema = buildContentDataSchema([field({ key: "b", type: "boolean", required: true })]);

    expect(schema.safeParse({ b: true }).success).toBe(true);
    expect(schema.safeParse({ b: "true" }).success).toBe(false);
  });

  it("validates a date field as ISO datetime", () => {
    const schema = buildContentDataSchema([field({ key: "d", type: "date", required: true })]);

    expect(schema.safeParse({ d: "2026-07-12T10:00:00Z" }).success).toBe(true);
    expect(schema.safeParse({ d: "not-a-date" }).success).toBe(false);
  });

  it("constrains a select field to its declared option values", () => {
    // A select with options is an enum: a value outside the list is a value the
    // editor never offered.
    const schema = buildContentDataSchema([
      field({
        key: "size",
        type: "select",
        required: true,
        options: [
          { value: "s", label: "Small" },
          { value: "l", label: "Large" },
        ],
      }),
    ]);

    expect(schema.safeParse({ size: "s" }).success).toBe(true);
    expect(schema.safeParse({ size: "xl" }).success).toBe(false);
  });

  it("falls back to a free string for a select with no options", () => {
    // CHARACTERISATION: an options-less select cannot build an enum, so it accepts
    // any string. Worth pinning so a future 'reject empty-option selects' change is
    // a conscious one.
    const schema = buildContentDataSchema([
      field({ key: "s", type: "select", required: true, options: [] }),
    ]);

    expect(schema.safeParse({ s: "anything" }).success).toBe(true);
  });

  it("requires media and reference fields to be UUIDs", () => {
    const schema = buildContentDataSchema([
      field({ key: "img", type: "media", required: true }),
      field({ key: "rel", type: "reference", required: true }),
    ]);

    expect(schema.safeParse({ img: UUID, rel: UUID }).success).toBe(true);
    expect(schema.safeParse({ img: "not-uuid", rel: UUID }).success).toBe(false);
  });

  it("accepts any JSON value for a json field", () => {
    const schema = buildContentDataSchema([field({ key: "j", type: "json", required: true })]);

    expect(schema.safeParse({ j: { nested: [1, 2, 3] } }).success).toBe(true);
  });

  it("treats text and unknown-typed fields as strings", () => {
    const schema = buildContentDataSchema([field({ key: "t", type: "text", required: true })]);

    expect(schema.safeParse({ t: "hello" }).success).toBe(true);
    expect(schema.safeParse({ t: 5 }).success).toBe(false);
  });

  it("strips unknown data keys instead of rejecting the row", () => {
    // Documented contract: removing a field from a content type must not make every
    // existing row un-saveable, so extra keys are stripped, not refused. This is a
    // DELIBERATE relaxation of the mass-assignment stance elsewhere — asserted here
    // so the trade-off stays visible and intentional.
    const schema = buildContentDataSchema([field({ key: "t", type: "text", required: false })]);

    const result = schema.safeParse({ t: "hi", removedField: "old value" });
    expect(result.success).toBe(true);
    if (result.success) expect("removedField" in result.data).toBe(false);
  });

  it("produces an empty object schema for a type with no fields", () => {
    const schema = buildContentDataSchema([]);

    expect(schema.safeParse({}).success).toBe(true);
  });
});
