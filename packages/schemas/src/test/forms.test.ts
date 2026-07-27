import { describe, expect, it } from "vitest";
import {
  CONTACT_FORM_FIELDS,
  buildFormSchema,
  toClientRules,
  toPublicForm,
  validateFormDefinitions,
  type FormField,
} from "../forms";

describe("buildFormSchema", () => {
  const schema = buildFormSchema(CONTACT_FORM_FIELDS);

  it("accepts a complete valid submission", () => {
    expect(
      schema.safeParse({
        name: "Jane",
        company: "Acme",
        email: "jane@example.com",
        need: "A website",
        message: "Hello there",
      }).success,
    ).toBe(true);
  });

  it("accepts blank optionals (forms post empty strings for blanks)", () => {
    const r = schema.safeParse({
      name: "Jane",
      company: "",
      email: "jane@example.com",
      need: "",
      message: "Hi",
    });
    expect(r.success).toBe(true);
  });

  it("rejects a loose email the browser's type=email would accept (aa@aa)", () => {
    const r = schema.safeParse({ name: "Jane", email: "aa@aa", message: "Hi" });
    expect(r.success).toBe(false);
    expect(r.success ? [] : r.error.issues.map((i) => i.path.join("."))).toContain("email");
  });

  it("requires the required fields to be present and non-empty", () => {
    expect(schema.safeParse({ email: "jane@example.com", message: "Hi" }).success).toBe(false); // no name
    expect(
      schema.safeParse({ name: "Jane", email: "jane@example.com", message: "" }).success,
    ).toBe(false); // empty message
  });

  it("enforces maxLength", () => {
    expect(
      schema.safeParse({
        name: "Jane",
        email: "jane@example.com",
        message: "x".repeat(5001),
      }).success,
    ).toBe(false);
  });

  it("strips unknown keys rather than rejecting them", () => {
    const r = schema.safeParse({
      name: "Jane",
      email: "jane@example.com",
      message: "Hi",
      injected: "nope",
    });
    expect(r.success).toBe(true);
    expect(r.success && "injected" in r.data).toBe(false);
  });

  it("handles number bounds, select options and patterns generically", () => {
    const fields: FormField[] = [
      { name: "age", type: "number", required: true, min: 18, max: 120 },
      { name: "plan", type: "select", required: true, options: ["free", "pro"] },
      { name: "code", type: "text", pattern: "^[A-Z]{3}$" },
    ];
    const s = buildFormSchema(fields);
    expect(s.safeParse({ age: 30, plan: "pro", code: "ABC" }).success).toBe(true);
    expect(s.safeParse({ age: 10, plan: "pro" }).success).toBe(false); // below min
    expect(s.safeParse({ age: 30, plan: "enterprise" }).success).toBe(false); // not an option
    expect(s.safeParse({ age: 30, plan: "free", code: "abc" }).success).toBe(false); // pattern
  });
});

describe("toPublicForm + validateFormDefinitions", () => {
  it("projects a declared form to browser-safe JSON (round-trips)", () => {
    const pub = toPublicForm({
      id: "feedback",
      title: "Send feedback",
      fields: [
        { name: "name", type: "text", required: true, maxLength: 120, label: "Name" },
        { name: "message", type: "textarea", required: true, minLength: 10 },
      ],
    });
    expect(JSON.parse(JSON.stringify(pub))).toEqual(pub);
    expect(pub.fields.map((f) => f.name)).toEqual(["name", "message"]);
  });

  it("accepts a valid declaration and rejects bad ones", () => {
    expect(validateFormDefinitions(undefined)).toEqual([]); // no forms is fine
    expect(
      validateFormDefinitions([{ id: "ok", fields: [{ name: "a", type: "text" }] }]),
    ).toEqual([]);
    expect(validateFormDefinitions([{ id: "Bad Id", fields: [] }]).length).toBeGreaterThan(0);
    // duplicate field names + bad pattern are reported
    const errs = validateFormDefinitions([
      { id: "dup", fields: [{ name: "a", type: "text" }, { name: "a", type: "text", pattern: "(" }] },
    ]);
    expect(errs.length).toBeGreaterThan(0);
  });
});

describe("toClientRules", () => {
  it("projects fields to a JSON-serialisable rule list matching the schema", () => {
    const rules = toClientRules(CONTACT_FORM_FIELDS);
    // Round-trips through JSON (it is embedded in an inline script).
    expect(JSON.parse(JSON.stringify(rules))).toEqual(rules);
    const email = rules.find((r) => r.name === "email");
    expect(email).toMatchObject({ type: "email", required: true, maxLength: 320 });
    const company = rules.find((r) => r.name === "company");
    expect(company).toMatchObject({ type: "text", maxLength: 200 });
    expect(company).not.toHaveProperty("required");
  });
});
