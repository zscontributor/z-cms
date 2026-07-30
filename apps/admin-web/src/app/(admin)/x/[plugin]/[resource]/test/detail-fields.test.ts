import { describe, expect, it } from "vitest";
import type { PluginResourceDescriptor } from "@/lib/api";
import { SYSTEM_COLUMNS, detailFields } from "../detail-fields";
import { formatCell, fromDateTimeLocal, toDateTimeLocal } from "../format-cell";
import { filterableColumns } from "../filterable";
import { sortHref } from "../list-url";

function descriptor(over: Partial<PluginResourceDescriptor> = {}): PluginResourceDescriptor {
  return {
    key: "appointment-requests",
    label: "Appointment requests",
    table: "p_vn_zsoft_plugin_medical__requests",
    list: { columns: [{ column: "patient_name", label: "Patient" }] },
    form: { fields: [{ column: "patient_name", label: "Patient name" }] },
    permissions: { read: "x:p:r:read", write: "x:p:r:manage" },
    ...over,
  };
}

describe("detailFields", () => {
  it("takes the plugin's form order, and the form's label when a column is in both", () => {
    const fields = detailFields(
      descriptor({
        form: {
          fields: [
            { column: "phone", label: "Phone number" },
            { column: "patient_name", label: "Patient name" },
          ],
        },
        list: {
          columns: [
            { column: "patient_name", label: "Patient" },
            { column: "phone", label: "Phone" },
          ],
        },
      }),
    );

    expect(fields.map((f) => [f.column, f.label])).toEqual([
      ["phone", "Phone number"],
      ["patient_name", "Patient name"],
    ]);
  });

  it("adds list columns the form leaves out, after the form's own", () => {
    const fields = detailFields(
      descriptor({
        form: { fields: [{ column: "patient_name", label: "Patient name" }] },
        list: {
          columns: [
            { column: "patient_name", label: "Patient" },
            { column: "status", label: "Status" },
          ],
        },
      }),
    );

    expect(fields.map((f) => f.column)).toEqual(["patient_name", "status"]);
  });

  it("still describes a read-only resource, which has a list but no form", () => {
    const fields = detailFields(
      descriptor({
        form: undefined,
        permissions: { read: "x:p:r:read" },
        list: {
          columns: [
            { column: "service", label: "Service" },
            { column: "fee", label: "Fee" },
          ],
        },
      }),
    );

    expect(fields.map((f) => f.column)).toEqual(["service", "fee"]);
  });

  it("shows no column the plugin declared nowhere, even though the row carries it", () => {
    // `SELECT *` hands the screen every column. A column the plugin put in neither
    // its form nor its list is one it chose not to show, and the detail screen is
    // not the place to overrule that for packages already published.
    const fields = detailFields(descriptor());

    expect(fields.map((f) => f.column)).toEqual(["patient_name"]);
    expect(fields.some((f) => f.column === "internal_notes")).toBe(false);
  });

  it("keeps the platform's own columns out of the declared fields", () => {
    const fields = detailFields(
      descriptor({
        form: {
          fields: [
            { column: "id", label: "Id" },
            { column: "tenant_id", label: "Tenant" },
            { column: "site_id", label: "Site" },
            { column: "created_at", label: "Created" },
            { column: "patient_name", label: "Patient name" },
          ],
        },
      }),
    );

    // They are rendered by the screen's own System card instead — and tenant/site
    // are not rendered at all: they are the same two values on every row.
    expect(fields.map((f) => f.column)).toEqual(["patient_name"]);
    expect(SYSTEM_COLUMNS).toEqual(["id", "created_at", "updated_at"]);
  });

  it("carries the declared input kind through, so the value can be rendered by type", () => {
    const fields = detailFields(
      descriptor({
        form: { fields: [{ column: "notes", label: "Notes", input: "textarea" }] },
      }),
    );

    expect(fields[0]).toMatchObject({ column: "notes", input: "textarea" });
  });

  it("never repeats a column, whichever way it was declared twice", () => {
    const fields = detailFields(
      descriptor({
        form: {
          fields: [
            { column: "phone", label: "Phone" },
            { column: "phone", label: "Phone again" },
          ],
        },
        list: { columns: [{ column: "phone", label: "Phone" }] },
      }),
    );

    expect(fields.map((f) => f.column)).toEqual(["phone"]);
  });
});

describe("formatCell is shared with the list, so both screens agree", () => {
  it("groups a stored decimal without rounding it", () => {
    expect(formatCell("300000.00", "en")).toBe("300,000.00");
    expect(formatCell("300000.00", "vi")).toBe("300.000,00");
  });

  it("leaves an identifier alone", () => {
    expect(formatCell("DV-NOI-01", "en")).toBe("DV-NOI-01");
    expect(formatCell("3f1c9d2e-5a7b-4c8d-9e0f-1a2b3c4d5e6f", "en")).toBe(
      "3f1c9d2e-5a7b-4c8d-9e0f-1a2b3c4d5e6f",
    );
  });

  it("renders an absent value as a dash and a boolean as a tick", () => {
    expect(formatCell(null, "en")).toBe("—");
    expect(formatCell(true, "en")).toBe("✓");
    expect(formatCell(false, "en")).toBe("—");
  });

  it("prints a text column exactly as stored, however much it looks like a number", () => {
    // The bug this exists for: a phone number is the exact shape of an integer, so
    // guessing from the shape grouped it like money and ate the leading zero.
    expect(formatCell("0908999888", "vi", "text")).toBe("0908999888");
    expect(formatCell("0908999888", "vi")).toBe("908.999.888"); // what guessing did
    expect(formatCell("84908999888", "en", "text")).toBe("84908999888");
  });

  it("groups only the columns the plugin declared as numbers", () => {
    expect(formatCell("300000.00", "vi", "numeric")).toBe("300.000,00");
    expect(formatCell("55000", "en", "integer")).toBe("55,000");
    expect(formatCell("55000", "en", "bigint")).toBe("55,000");
  });

  it("localizes a timestamptz and leaves a uuid alone", () => {
    expect(formatCell("2026-07-30T02:15:00.000Z", "en", "timestamptz")).toContain("2026");
    const id = "3f1c9d2e-5a7b-4c8d-9e0f-1a2b3c4d5e6f";
    expect(formatCell(id, "en", "uuid")).toBe(id);
  });

  it("still recognises shapes when the column type is unknown", () => {
    // A descriptor from a server that predates `columnTypes` must keep working.
    expect(formatCell("55000", "en")).toBe("55,000");
    expect(formatCell("DV-NOI-01", "en")).toBe("DV-NOI-01");
  });
});

describe("sortHref", () => {
  const base = { pathname: "/x/p/r", order: null as null | { column: string; direction: "asc" | "desc" } };

  it("sorts a fresh column ascending, and writes no dir for it", () => {
    expect(sortHref({ ...base, search: "", column: "phone" })).toBe("/x/p/r?sort=phone");
  });

  it("reverses the column already sorted ascending", () => {
    expect(
      sortHref({
        ...base,
        search: "sort=phone",
        column: "phone",
        order: { column: "phone", direction: "asc" },
      }),
    ).toBe("/x/p/r?sort=phone&dir=desc");
  });

  it("goes back to ascending from descending, dropping dir", () => {
    expect(
      sortHref({
        ...base,
        search: "sort=phone&dir=desc",
        column: "phone",
        order: { column: "phone", direction: "desc" },
      }),
    ).toBe("/x/p/r?sort=phone");
  });

  it("starts another column ascending, even while one is sorted descending", () => {
    expect(
      sortHref({
        ...base,
        search: "sort=phone&dir=desc",
        column: "patient_name",
        order: { column: "phone", direction: "desc" },
      }),
    ).toBe("/x/p/r?sort=patient_name");
  });

  it("drops page — row 1 of a re-sorted list is not on page 5", () => {
    const href = sortHref({ ...base, search: "page=5&perPage=50", column: "phone" });
    expect(href).not.toContain("page=5");
    expect(href).toContain("perPage=50");
  });

  it("keeps every other parameter it did not come to change", () => {
    const href = sortHref({ ...base, search: "perPage=100&q=anh", column: "phone" });
    expect(href).toContain("perPage=100");
    expect(href).toContain("q=anh");
  });
});

describe("filterableColumns", () => {
  it("offers a dropdown for a listed select column, with the plugin's own options", () => {
    const columns = filterableColumns(
      descriptor({
        list: { columns: [{ column: "status", label: "Status" }] },
        form: {
          fields: [
            {
              column: "status",
              label: "Status",
              input: "select",
              options: [
                { value: "new", label: "New" },
                { value: "done", label: "Done" },
              ],
            },
          ],
        },
      }),
    );

    expect(columns).toEqual([
      {
        column: "status",
        label: "Status",
        kind: "select",
        options: [
          { value: "new", label: "New" },
          { value: "done", label: "Done" },
        ],
      },
    ]);
  });

  it("offers yes/no for a boolean, which carries no options of its own", () => {
    const columns = filterableColumns(
      descriptor({
        list: { columns: [{ column: "active", label: "Active" }] },
        form: { fields: [{ column: "active", label: "Active", input: "boolean" }] },
      }),
    );

    expect(columns).toEqual([
      { column: "active", label: "Active", kind: "boolean", options: [] },
    ]);
  });

  it("offers nothing for a free-text column — its values are not a knowable set", () => {
    const columns = filterableColumns(
      descriptor({
        list: { columns: [{ column: "patient_name", label: "Patient" }] },
        form: { fields: [{ column: "patient_name", label: "Patient name" }] },
      }),
    );

    expect(columns).toEqual([]);
  });

  it("offers nothing for a select the resource does not list", () => {
    // A filter is a lens on what the screen shows; sifting by an unshown column is
    // a way to learn its contents sideways.
    const columns = filterableColumns(
      descriptor({
        list: { columns: [{ column: "patient_name", label: "Patient" }] },
        form: {
          fields: [
            {
              column: "internal_notes",
              label: "Notes",
              input: "select",
              options: [{ value: "flagged", label: "Flagged" }],
            },
          ],
        },
      }),
    );

    expect(columns).toEqual([]);
  });

  it("offers nothing at all for a resource with no form", () => {
    expect(filterableColumns(descriptor({ form: undefined }))).toEqual([]);
  });
});

/**
 * `<input type="datetime-local">` has a grammar of its own, and a `timestamptz`
 * does not speak it. A refused value renders as an empty box, so editing a shift
 * showed no date on a record whose whole subject is when somebody works.
 */
describe("timestamps a datetime-local input will accept", () => {
  it("drops the seconds, milliseconds and zone the control refuses", () => {
    const local = toDateTimeLocal("2026-07-31T07:56:12.000Z");
    expect(local).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    // Round-trips to the same instant, whatever zone this machine is in.
    expect(new Date(fromDateTimeLocal(local)!).getTime()).toBe(
      new Date("2026-07-31T07:56:00.000Z").getTime(),
    );
  });

  it("treats an absent or unparsable value as empty rather than as a date", () => {
    for (const value of [null, undefined, "", "not a date"]) {
      expect(toDateTimeLocal(value)).toBe("");
    }
    expect(fromDateTimeLocal("")).toBeNull();
    expect(fromDateTimeLocal("nonsense")).toBeNull();
  });
});
