import { describe, expect, it } from "vitest";
import {
  inferFieldInput,
  validateAdminContribution,
  type PluginAdminContribution,
} from "../admin";
import type { PluginTableSchema } from "../table-schema";

const PREFIX = "p_vn_zsoft_plugin_crm__";

const leads: PluginTableSchema = {
  name: `${PREFIX}leads`,
  columns: [
    { name: "email", type: "text" },
    { name: "score", type: "integer" },
    { name: "stage", type: "text" },
  ],
};

const valid: PluginAdminContribution = {
  resources: [
    {
      key: "leads",
      label: "Leads",
      table: `${PREFIX}leads`,
      list: {
        columns: [
          { column: "email", label: "Email" },
          { column: "score", label: "Score" },
          { column: "created_at", label: "Added" },
        ],
        orderBy: { column: "created_at", direction: "desc" },
      },
      form: {
        fields: [
          { column: "email", label: "Email" },
          { column: "stage", label: "Stage", input: "select", options: ["new", "won"] },
        ],
      },
      permissions: { read: "x:vn_zsoft_plugin_crm:lead:read", write: "x:vn_zsoft_plugin_crm:lead:manage" },
    },
  ],
  nav: [
    {
      label: "Leads",
      icon: "users",
      resource: "leads",
      permission: "x:vn_zsoft_plugin_crm:lead:read",
    },
  ],
};

describe("validateAdminContribution", () => {
  it("accepts a contribution whose every reference resolves", () => {
    expect(validateAdminContribution(valid, [leads])).toEqual([]);
  });

  it("treats an absent contribution as no violations", () => {
    expect(validateAdminContribution(undefined, [leads])).toEqual([]);
  });

  it("REFUSES a resource backed by a table the plugin never declared", () => {
    // The whole safety story: a resource can only read a table the plugin owns.
    const bad = {
      ...valid,
      resources: [{ ...valid.resources![0], table: "orders" }],
    };
    const v = validateAdminContribution(bad, [leads]);
    expect(v).toContainEqual({ where: "resource:leads", reason: "unknown-table", detail: "orders" });
  });

  it("REFUSES a list column the backing table does not have", () => {
    const bad = {
      ...valid,
      resources: [
        {
          ...valid.resources![0],
          list: { columns: [{ column: "salary", label: "Salary" }] },
        },
      ],
    };
    const v = validateAdminContribution(bad, [leads]);
    expect(v).toContainEqual({ where: "resource:leads", reason: "unknown-column", detail: "salary" });
  });

  it("allows a list/form on a reserved core column like created_at", () => {
    // Every plugin table has id/tenant_id/site_id/created_at/updated_at.
    expect(validateAdminContribution(valid, [leads])).toEqual([]);
  });

  it("REFUSES a resource with no read permission", () => {
    const bad = {
      resources: [
        {
          ...valid.resources![0],
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          permissions: {} as any,
        },
      ],
    };
    const v = validateAdminContribution(bad, [leads]);
    expect(v).toContainEqual({ where: "resource:leads", reason: "missing-read-permission" });
  });

  it("REFUSES a duplicate resource key", () => {
    const bad = { resources: [valid.resources![0], valid.resources![0]] };
    const v = validateAdminContribution(bad, [leads]);
    expect(v).toContainEqual({ where: "resource:leads", reason: "duplicate-resource-key", detail: "leads" });
  });

  it("REFUSES a resource key that is not a slug", () => {
    const bad = { resources: [{ ...valid.resources![0], key: "Leads!" }] };
    const v = validateAdminContribution(bad, [leads]);
    expect(v).toContainEqual({ where: "resource:Leads!", reason: "invalid-resource-key", detail: "Leads!" });
  });

  it("REFUSES a nav entry that opens a resource the plugin did not define", () => {
    const bad = {
      resources: valid.resources,
      nav: [{ label: "Ghost", resource: "phantom", permission: "x:vn_zsoft_plugin_crm:lead:read" }],
    };
    const v = validateAdminContribution(bad, [leads]);
    expect(v).toContainEqual({ where: "nav:phantom", reason: "nav-unknown-resource", detail: "phantom" });
  });

  it("REFUSES a nav entry with no permission to gate it", () => {
    const bad = {
      resources: valid.resources,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      nav: [{ label: "Leads", resource: "leads", permission: "" } as any],
    };
    const v = validateAdminContribution(bad, [leads]);
    expect(v).toContainEqual({ where: "nav:leads", reason: "nav-missing-permission" });
  });
});

describe("inferFieldInput", () => {
  it("maps numeric column types to a number input", () => {
    expect(inferFieldInput("integer")).toBe("number");
    expect(inferFieldInput("numeric")).toBe("number");
  });

  it("maps boolean and timestamptz to their inputs", () => {
    expect(inferFieldInput("boolean")).toBe("boolean");
    expect(inferFieldInput("timestamptz")).toBe("date");
  });

  it("falls back to text for anything else", () => {
    expect(inferFieldInput("text")).toBe("text");
    expect(inferFieldInput("jsonb")).toBe("text");
  });
});
