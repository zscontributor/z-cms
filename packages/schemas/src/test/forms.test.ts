import { describe, expect, it } from "vitest";
import {
  CONTACT_FORM_FIELDS,
  buildFormSchema,
  checkFormField,
  checkFormValues,
  formPickSlots,
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

describe("buildFormSchema: date fields", () => {
  const schema = buildFormSchema([
    { name: "day", type: "date", required: true },
    { name: "maybe", type: "date" },
  ]);

  it("accepts a real calendar day and a blank optional", () => {
    expect(schema.safeParse({ day: "2026-08-03", maybe: "" }).success).toBe(true);
  });

  it("rejects a wrong shape and a day that does not exist", () => {
    expect(schema.safeParse({ day: "03/08/2026" }).success).toBe(false);
    expect(schema.safeParse({ day: "2026-2-3" }).success).toBe(false);
    expect(schema.safeParse({ day: "2026-02-30" }).success).toBe(false);
    expect(schema.safeParse({ day: "2026-13-01" }).success).toBe(false);
  });

  it("still requires a required date", () => {
    expect(schema.safeParse({ day: "" }).success).toBe(false);
  });
});

describe("localized declarations", () => {
  const form = {
    id: "appointment",
    title: { en: "Request an appointment", vi: "Yêu cầu đặt lịch" },
    submitLabel: { en: "Send", vi: "Gửi" },
    successMessage: { en: "Thank you.", vi: "Cảm ơn bạn." },
    fields: [
      {
        name: "phone",
        type: "tel" as const,
        required: true,
        label: { en: "Phone number", vi: "Số điện thoại" },
      },
      {
        name: "service",
        type: "select" as const,
        required: true,
        label: { en: "Service", vi: "Dịch vụ" },
        options: [
          { value: "general", label: { en: "General medicine", vi: "Nội tổng quát" } },
          "other",
        ],
      },
    ],
  };

  it("is a valid declaration", () => {
    expect(validateFormDefinitions([form])).toEqual([]);
  });

  it("resolves every text to the rendered locale, options to value+label pairs", () => {
    const vi = toPublicForm(form, "vi");
    expect(vi.title).toBe("Yêu cầu đặt lịch");
    expect(vi.submitLabel).toBe("Gửi");
    expect(vi.successMessage).toBe("Cảm ơn bạn.");
    expect(vi.fields[0]?.label).toBe("Số điện thoại");
    expect(vi.fields[1]?.options).toEqual([
      { value: "general", label: "Nội tổng quát" },
      { value: "other", label: "other" },
    ]);
  });

  it("falls back: region → base language → en → whatever exists", () => {
    expect(toPublicForm(form, "vi-VN").fields[0]?.label).toBe("Số điện thoại");
    expect(toPublicForm(form, "ja").fields[0]?.label).toBe("Phone number");
    const viOnly = { id: "vi-only", fields: [{ name: "a", type: "text" as const, label: { vi: "Tên" } }] };
    expect(toPublicForm(viOnly, "ja").fields[0]?.label).toBe("Tên");
  });

  it("validates the option VALUE, so the stored row is locale-independent", () => {
    const schema = buildFormSchema(form.fields);
    expect(schema.safeParse({ phone: "0901234567", service: "general" }).success).toBe(true);
    // The Vietnamese label is a label, not an accepted value.
    expect(schema.safeParse({ phone: "0901234567", service: "Nội tổng quát" }).success).toBe(
      false,
    );
  });

  it("keeps a plain string declaration working unchanged", () => {
    const pub = toPublicForm(
      { id: "plain", title: "Contact", fields: [{ name: "a", type: "text", label: "Name" }] },
      "vi",
    );
    expect(pub.title).toBe("Contact");
    expect(pub.fields[0]?.label).toBe("Name");
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

/**
 * `checkFormField` explains a refusal; `buildFormSchema` decides one. They are two
 * readings of the same declaration, so the tests that matter are the ones that pin
 * them to each other — a rule the schema enforces and the checker cannot name is
 * exactly how a visitor ends up with "check the fields" and no idea which.
 */
describe("checkFormField", () => {
  const quantity: FormField = { name: "quantity1", type: "number", required: true, min: 1 };

  it("catches the negative quantity the browser used to wave through", () => {
    expect(checkFormField(quantity, "-2")).toBe("min");
    expect(checkFormField(quantity, "0")).toBe("min");
    expect(checkFormField(quantity, "2")).toBeNull();
  });

  it("tells a value that is out of range apart from one that is not a number", () => {
    // Two different sentences for the visitor: "enter a number" vs "enter 1 or more".
    expect(checkFormField(quantity, "abc")).toBe("number");
    expect(checkFormField({ name: "n", type: "number", max: 10 }, "11")).toBe("max");
  });

  it("keeps length and value apart", () => {
    // "at least 1" on a quantity is a value; on a name it is a character count.
    expect(checkFormField({ name: "t", type: "text", minLength: 3 }, "ab")).toBe("minLength");
    expect(checkFormField({ name: "t", type: "text", maxLength: 3 }, "abcd")).toBe("maxLength");
  });

  it("reports an empty required field as required, whatever its type", () => {
    for (const type of ["text", "email", "number", "date", "select"] as const) {
      expect(checkFormField({ name: "f", type, required: true }, "")).toBe("required");
      expect(checkFormField({ name: "f", type }, "")).toBeNull();
    }
    // Whitespace is empty: a space bar is not an answer.
    expect(checkFormField({ name: "f", type: "text", required: true }, "   ")).toBe("required");
  });

  it("refuses a choice the form never offered", () => {
    const field: FormField = {
      name: "orderType",
      type: "select",
      options: ["takeaway", { value: "delivery", label: "Delivery" }],
    };
    expect(checkFormField(field, "delivery")).toBeNull();
    expect(checkFormField(field, "dine-in")).toBe("invalid");
  });

  it("names a field for every submission the authoritative schema refuses", () => {
    const fields: FormField[] = [
      { name: "customerName", type: "text", required: true, maxLength: 5 },
      { name: "email", type: "email" },
      { name: "quantity1", type: "number", required: true, min: 1 },
      { name: "pickupDate", type: "date" },
    ];
    const schema = buildFormSchema(fields);

    const bad = [
      { customerName: "", quantity1: "2" },
      { customerName: "Linh", quantity1: "-2" },
      { customerName: "Linh", quantity1: "1", email: "nope" },
      { customerName: "Linh", quantity1: "1", pickupDate: "2026-02-30" },
      { customerName: "much too long", quantity1: "1" },
    ];

    for (const values of bad) {
      expect(schema.safeParse(values).success).toBe(false);
      // The point: something was refused AND the visitor can be told where.
      expect(Object.keys(checkFormValues(fields, values))).not.toEqual([]);
    }

    const good = { customerName: "Linh", quantity1: "3", email: "a@b.co", pickupDate: "2026-08-01" };
    expect(schema.safeParse(good).success).toBe(true);
    expect(checkFormValues(fields, good)).toEqual({});
  });
});

/**
 * Optional groups: rendering only.
 *
 * A declared form is a flat field list because that is what a server validates and
 * a plugin handler reads. Groups let the RENDERER hold some of it back until the
 * visitor asks — so the rules here are the ones that keep "held back" from turning
 * into "impossible to fill in".
 */
describe("form groups", () => {
  const form = {
    id: "cafe-order",
    fields: [
      { name: "item1", type: "text", required: true },
      { name: "item2", type: "text", group: "more" },
      { name: "quantity2", type: "number", group: "more", min: 1, defaultValue: "1", step: 1 },
    ],
    groups: [{ id: "more", addLabel: { vi: "+ Thêm món", en: "+ Add item" } }],
  };

  it("accepts a form whose optional fields live in a declared group", () => {
    expect(validateFormDefinitions([form])).toEqual([]);
  });

  it("refuses a field pointing at a group that does not exist", () => {
    const broken = { ...form, groups: [] };
    // A field in an undeclared group renders nowhere. Better to refuse the
    // manifest than to ship a form with an invisible box in it.
    expect(validateFormDefinitions([broken])).toEqual([
      'forms.cafe-order.item2: unknown group "more"',
      'forms.cafe-order.quantity2: unknown group "more"',
    ]);
  });

  it("refuses a REQUIRED field inside a group nobody has to open", () => {
    const broken = {
      ...form,
      fields: [...form.fields, { name: "why", type: "text", required: true, group: "more" }],
    };
    expect(validateFormDefinitions([broken])).toContain(
      "forms.cafe-order.why: a required field cannot live in an optional group",
    );
  });

  it("leaves validation alone: an unopened group submits empty and passes", () => {
    const schema = buildFormSchema(form.fields as FormField[]);
    expect(schema.safeParse({ item1: "CF-02" }).success).toBe(true);
    expect(schema.safeParse({ item1: "CF-02", item2: "", quantity2: "" }).success).toBe(true);
    // And an opened one is validated exactly as before.
    expect(schema.safeParse({ item1: "CF-02", item2: "BK-02", quantity2: "0" }).success).toBe(false);
  });

  it("hands the browser the group labels in one language", () => {
    const pub = toPublicForm(form as never, "vi");
    expect(pub.groups).toEqual([{ id: "more", addLabel: "+ Thêm món" }]);
    expect(pub.fields.find((f) => f.name === "quantity2")).toMatchObject({
      group: "more",
      defaultValue: "1",
      step: 1,
      min: 1,
    });
  });
});

/**
 * Whose basket is it? Z-CMS is a platform: the cafe plugin is one instance of a
 * form-as-a-basket, not the definition of one. A plugin that names nothing the
 * same way must get the same behaviour by SAYING what its fields are.
 */
describe("formPickSlots", () => {
  it("takes a plugin at its word, whatever the fields are called", () => {
    const basket = formPickSlots({
      fields: [
        { name: "khach", type: "text" },
        { name: "sanPhamA", type: "select", role: "pick", options: [{ value: "P1", label: "Áo" }] },
        { name: "sanPhamB", type: "select", role: "pick", options: [{ value: "P2", label: "Quần" }] },
        // Declared far from their slots, and in the "wrong" order — adjacency
        // would pair none of these, which is the point of naming the partner.
        { name: "slB", type: "number", quantityFor: "sanPhamB" },
        { name: "slA", type: "number", quantityFor: "sanPhamA" },
      ],
    });

    expect(basket.declared).toBe(true);
    expect(basket.slots.map((f) => f.name)).toEqual(["sanPhamA", "sanPhamB"]);
    expect(basket.quantities.sanPhamA?.name).toBe("slA");
    expect(basket.quantities.sanPhamB?.name).toBe("slB");
    expect(basket.values).toEqual(["P1", "P2"]);
  });

  it("declared slots need not offer the same list as each other", () => {
    // Inference could never see this as one basket; a declaration says it is.
    const basket = formPickSlots({
      fields: [
        { name: "drink", type: "select", role: "pick", options: [{ value: "CF", label: "Cà phê" }] },
        { name: "cake", type: "select", role: "pick", options: [{ value: "BK", label: "Bánh" }] },
      ],
    });

    expect(basket.slots.map((f) => f.name)).toEqual(["drink", "cake"]);
    expect(basket.values).toEqual(["CF", "BK"]);
  });

  it("falls back to the shape for a form that declares nothing", () => {
    const drinks = [{ value: "CF-04", label: "Cà phê muối" }];
    const basket = formPickSlots({
      fields: [
        { name: "orderType", type: "select", options: [{ value: "takeaway", label: "Mang đi" }] },
        { name: "item1", type: "select", options: drinks },
        { name: "quantity1", type: "number" },
        { name: "item2", type: "select", options: drinks },
        { name: "quantity2", type: "number" },
      ],
    });

    expect(basket.declared).toBe(false);
    expect(basket.slots.map((f) => f.name)).toEqual(["item1", "item2"]);
    expect(basket.quantities.item1?.name).toBe("quantity1");
    // "How would you like it?" repeats nothing, so it is not a line.
    expect(basket.slots.some((f) => f.name === "orderType")).toBe(false);
  });

  it("infers no basket from a lone select, rather than guessing wrong", () => {
    // One select is "how will you pay?" far more often than it is a shopping
    // list. A form that means the latter says role: "pick".
    const basket = formPickSlots({
      fields: [
        { name: "payment", type: "select", options: [{ value: "cash", label: "Tiền mặt" }] },
        { name: "note", type: "textarea" },
      ],
    });

    expect(basket.slots).toEqual([]);
  });
});

describe("validateFormDefinitions — declared baskets", () => {
  const form = (fields: unknown[]) => [{ id: "order", fields }];

  it("refuses a pick that offers nothing to pick", () => {
    const errors = validateFormDefinitions(
      form([{ name: "item", type: "text", role: "pick" }]),
    );
    expect(errors.join(" ")).toContain('role "pick" needs a select with options');
  });

  it("refuses a quantity pointing at a field that is not a pick", () => {
    const errors = validateFormDefinitions(
      form([
        { name: "item", type: "select", options: ["A"] },
        { name: "qty", type: "number", quantityFor: "item" },
      ]),
    );
    expect(errors.join(" ")).toContain('is not a role "pick" field');
  });

  it("refuses two quantities counting one line", () => {
    const errors = validateFormDefinitions(
      form([
        { name: "item", type: "select", role: "pick", options: ["A"] },
        { name: "qty", type: "number", quantityFor: "item" },
        { name: "qtyAgain", type: "number", quantityFor: "item" },
      ]),
    );
    expect(errors.join(" ")).toContain("already has a quantity field");
  });

  it("accepts a well-declared basket", () => {
    expect(
      validateFormDefinitions(
        form([
          { name: "item", type: "select", role: "pick", options: ["A"] },
          { name: "qty", type: "number", quantityFor: "item" },
        ]),
      ),
    ).toEqual([]);
  });
});
