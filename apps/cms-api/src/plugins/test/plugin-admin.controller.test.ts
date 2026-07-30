import { beforeEach, describe, expect, it, vi } from "vitest";
import { ForbiddenException, NotFoundException } from "@nestjs/common";

const holder = vi.hoisted(() => ({ db: null as any }));
vi.mock("@zcmsorg/database", () => ({
  db: () => holder.db,
}));

import { PluginAdminController } from "../plugin-admin.controller";
import type { RequestActor } from "../../common/request-context";

const TABLE = {
  name: "p_vn_zsoft_plugin_medical__requests",
  columns: [
    { name: "patient_name", type: "text" },
    { name: "phone", type: "text" },
    { name: "internal_notes", type: "text", nullable: true },
  ],
} as const;

const RESOURCE = {
  key: "appointment-requests",
  label: "Appointment requests",
  table: TABLE.name,
  list: { columns: [{ column: "patient_name", label: "Patient" }] },
  form: { fields: [{ column: "patient_name", label: "Patient name" }] },
  permissions: {
    read: "x:vn_zsoft_plugin_medical:requests:read",
    write: "x:vn_zsoft_plugin_medical:requests:manage",
  },
} as const;

const ROW_ID = "3f1c9d2e-5a7b-4c8d-9e0f-1a2b3c4d5e6f";

function makeDb(rows: Record<string, unknown>[] = []) {
  return {
    $queryRawUnsafe: vi.fn().mockResolvedValue(rows),
    $executeRawUnsafe: vi.fn().mockResolvedValue(1),
  };
}

/** A caller holding exactly the permissions listed. */
function actor(...permissions: string[]): RequestActor {
  return {
    userId: "u1",
    tenantId: "t1",
    role: "EDITOR",
    permissions,
  } as unknown as RequestActor;
}

function make(resource: unknown = RESOURCE) {
  const plugins = {
    adminResourceFor: vi.fn().mockResolvedValue(
      resource === null ? null : { resource, table: TABLE },
    ),
    dispatchActionTo: vi.fn().mockResolvedValue(undefined),
  };
  return {
    controller: new PluginAdminController(plugins as never),
    plugins,
  };
}

describe("PluginAdminController.detail", () => {
  beforeEach(() => {
    holder.db = makeDb([{ id: ROW_ID, patient_name: "Nguyễn Minh Anh", internal_notes: "x" }]);
  });

  it("returns the row and the descriptor to a caller holding the READ permission", async () => {
    const { controller } = make();

    const result = await controller.detail(
      actor(RESOURCE.permissions.read),
      "s1",
      "vn.zsoft.plugin.medical",
      RESOURCE.key,
      ROW_ID,
    );

    expect(result.row).toMatchObject({ id: ROW_ID, patient_name: "Nguyễn Minh Anh" });
    // The descriptor rides along so the screen can label the fields without a
    // second request for something the list already returns.
    expect(result.resource).toMatchObject(RESOURCE);
    // …and with it the DECLARED type of every column, reserved ones included, so
    // the screen reads a value as the plugin meant it. Guessing from the shape of
    // the string made a phone number ("0908999888") render as an amount.
    expect(result.resource.columnTypes).toEqual({
      patient_name: "text",
      phone: "text",
      internal_notes: "text",
      id: "uuid",
      tenant_id: "uuid",
      site_id: "uuid",
      created_at: "timestamptz",
      updated_at: "timestamptz",
    });
  });

  it("reads only within the caller's tenant and the requested site", async () => {
    const { controller } = make();

    await controller.detail(
      actor(RESOURCE.permissions.read),
      "s1",
      "vn.zsoft.plugin.medical",
      RESOURCE.key,
      ROW_ID,
    );

    const [text, ...values] = holder.db.$queryRawUnsafe.mock.calls[0];
    expect(text).toContain(`FROM "${TABLE.name}"`);
    expect(text).toContain(`"tenant_id" = $1`);
    expect(text).toContain(`"site_id" = $2`);
    expect(text).toContain(`"id" = $3`);
    expect(values).toEqual(["t1", "s1", ROW_ID]);
  });

  it("is gated by read, NOT by write — a read-only role may open a record", async () => {
    const { controller } = make();

    await expect(
      controller.detail(
        actor(RESOURCE.permissions.read),
        "s1",
        "vn.zsoft.plugin.medical",
        RESOURCE.key,
        ROW_ID,
      ),
    ).resolves.toBeDefined();
  });

  it("refuses a caller without the resource's read permission", async () => {
    const { controller } = make();

    await expect(
      controller.detail(
        actor("content:read"),
        "s1",
        "vn.zsoft.plugin.medical",
        RESOURCE.key,
        ROW_ID,
      ),
    ).rejects.toThrow(ForbiddenException);
    expect(holder.db.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  it("404s a row that does not exist here — another tenant's row is not found, not forbidden", async () => {
    holder.db = makeDb([]);
    const { controller } = make();

    await expect(
      controller.detail(
        actor(RESOURCE.permissions.read),
        "s1",
        "vn.zsoft.plugin.medical",
        RESOURCE.key,
        ROW_ID,
      ),
    ).rejects.toThrow(NotFoundException);
  });

  it("404s a malformed id without letting it reach Postgres", async () => {
    const { controller } = make();

    for (const id of ["abc", "1", "' OR 1=1 --", `${ROW_ID}x`]) {
      await expect(
        controller.detail(
          actor(RESOURCE.permissions.read),
          "s1",
          "vn.zsoft.plugin.medical",
          RESOURCE.key,
          id,
        ),
      ).rejects.toThrow(NotFoundException);
    }
    // A uuid column compared against "abc" is a type error, i.e. a 500 for a URL
    // somebody mistyped. The guard is what keeps that from being the answer.
    expect(holder.db.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  it("404s an unknown resource before any permission is considered", async () => {
    const { controller } = make(null);

    await expect(
      controller.detail(actor(RESOURCE.permissions.read), "s1", "p", "nope", ROW_ID),
    ).rejects.toThrow(NotFoundException);
  });
});

describe("PluginAdminController.list: what the pager needs", () => {
  /**
   * The list issues two queries — a page of rows and a total. They are told apart
   * by the SQL, because that is what the screen's two different needs look like at
   * this layer.
   */
  function pagedDb(rows: Record<string, unknown>[], count: unknown) {
    return {
      $queryRawUnsafe: vi.fn(async (text: string) =>
        text.includes("count(*)") ? [{ count }] : rows,
      ),
      $executeRawUnsafe: vi.fn(),
    };
  }

  beforeEach(() => {
    holder.db = pagedDb([{ id: ROW_ID }], 42n);
  });

  it("returns the total, the page and the page size the server settled on", async () => {
    const { controller } = make();

    const result = await controller.list(
      actor(RESOURCE.permissions.read),
      "s1",
      "vn.zsoft.plugin.medical",
      RESOURCE.key,
      {},
      "3",
      undefined,
    );

    expect(result).toMatchObject({ total: 42, page: 3, perPage: 20 });
    expect(result.rows).toHaveLength(1);
  });

  it("narrows a bigint count to a number, whichever way the driver hands it over", async () => {
    // `count(*)` is a bigint: a BigInt cannot be JSON-serialized at all, and some
    // drivers hand it back as a string instead. Both must reach the screen as 7.
    for (const raw of [7n, "7", 7]) {
      holder.db = pagedDb([], raw);
      const { controller } = make();
      const result = await controller.list(
        actor(RESOURCE.permissions.read),
        "s1",
        "p",
        RESOURCE.key,
        {},
        undefined,
        undefined,
      );
      expect(result.total).toBe(7);
      expect(() => JSON.stringify(result)).not.toThrow();
    }
  });

  it("counts within the tenant and site, and without a LIMIT", async () => {
    const { controller } = make();

    await controller.list(
      actor(RESOURCE.permissions.read),
      "s1",
      "p",
      RESOURCE.key,
      {},
      undefined,
      undefined,
    );

    const countCall = holder.db.$queryRawUnsafe.mock.calls.find((c: unknown[]) =>
      String(c[0]).includes("count(*)"),
    );
    expect(countCall?.[0]).toContain(`"tenant_id" = $1`);
    expect(countCall?.[0]).toContain(`"site_id" = $2`);
    expect(countCall?.[0]).not.toContain("LIMIT");
    expect(countCall?.slice(1)).toEqual(["t1", "s1"]);
  });

  it("caps the page size rather than refusing a caller who asks for more", async () => {
    const { controller } = make();

    const result = await controller.list(
      actor(RESOURCE.permissions.read),
      "s1",
      "p",
      RESOURCE.key,
      {},
      "0",
      "5000",
    );

    expect(result.perPage).toBe(100);
    expect(result.page).toBe(1);
    const pageCall = holder.db.$queryRawUnsafe.mock.calls.find(
      (c: unknown[]) => !String(c[0]).includes("count(*)"),
    );
    expect(pageCall?.[0]).toContain("LIMIT 100");
    // Page 1 has no offset to apply.
    expect(pageCall?.[0]).not.toContain("OFFSET");
  });

  it("offsets by whole pages", async () => {
    const { controller } = make();

    await controller.list(
      actor(RESOURCE.permissions.read),
      "s1",
      "p",
      RESOURCE.key,
      {},
      "4",
      "10",
    );

    const pageCall = holder.db.$queryRawUnsafe.mock.calls.find(
      (c: unknown[]) => !String(c[0]).includes("count(*)"),
    );
    expect(pageCall?.[0]).toContain("LIMIT 10 OFFSET 30");
  });

  it("counts nothing for a caller who may not read the resource", async () => {
    const { controller } = make();

    await expect(
      controller.list(actor("content:read"), "s1", "p", RESOURCE.key, {}, undefined, undefined),
    ).rejects.toThrow(ForbiddenException);
    expect(holder.db.$queryRawUnsafe).not.toHaveBeenCalled();
  });
});

describe("PluginAdminController.list: ordering comes from a closed set", () => {
  /** A resource listing two of its table's columns, with a declared default order. */
  const SORTABLE = {
    ...RESOURCE,
    list: {
      columns: [
        { column: "patient_name", label: "Patient" },
        { column: "phone", label: "Phone" },
      ],
      orderBy: { column: "patient_name", direction: "desc" as const },
    },
  };

  function pageSql(): string {
    const call = holder.db.$queryRawUnsafe.mock.calls.find(
      (c: unknown[]) => !String(c[0]).includes("count(*)"),
    );
    return String(call?.[0]);
  }

  beforeEach(() => {
    holder.db = {
      $queryRawUnsafe: vi.fn(async (text: string) =>
        text.includes("count(*)") ? [{ count: 1n }] : [{ id: ROW_ID }],
      ),
      $executeRawUnsafe: vi.fn(),
    };
  });

  async function list(sort?: string, dir?: string, resource: unknown = SORTABLE) {
    const { controller } = make(resource);
    return controller.list(
      actor(RESOURCE.permissions.read),
      "s1",
      "vn.zsoft.plugin.medical",
      RESOURCE.key,
      {},
      undefined,
      undefined,
      sort,
      dir,
    );
  }

  it("sorts by a column the plugin listed, ascending unless told otherwise", async () => {
    const result = await list("phone");

    expect(pageSql()).toContain(`ORDER BY "phone" ASC`);
    expect(result.order).toEqual({ column: "phone", direction: "asc" });
  });

  it("honours a descending request", async () => {
    const result = await list("phone", "desc");

    expect(pageSql()).toContain(`ORDER BY "phone" DESC`);
    expect(result.order).toEqual({ column: "phone", direction: "desc" });
  });

  it("falls back to the plugin's declared ordering when nothing was asked for", async () => {
    const result = await list();

    expect(pageSql()).toContain(`ORDER BY "patient_name" DESC`);
    expect(result.order).toEqual({ column: "patient_name", direction: "desc" });
  });

  it("IGNORES a sort naming a column the plugin did not list, even a real one", async () => {
    // `internal_notes` exists on the table but the plugin surfaced it nowhere. A
    // caller must not be able to order by it and read its order off the rows.
    const result = await list("internal_notes");

    expect(pageSql()).not.toContain("internal_notes");
    expect(pageSql()).toContain(`ORDER BY "patient_name" DESC`);
    expect(result.order).toEqual({ column: "patient_name", direction: "desc" });
  });

  it("ignores a sort on a column that does not exist at all, rather than erroring", async () => {
    // A stale bookmark should show the list, not a 400.
    await expect(list("nope")).resolves.toBeDefined();
    expect(pageSql()).toContain(`ORDER BY "patient_name" DESC`);
  });

  it("never lets a sort value reach the SQL as text", async () => {
    await list(`patient_name"; DROP TABLE users; --`);

    expect(pageSql()).not.toContain("DROP TABLE");
    expect(pageSql()).toContain(`ORDER BY "patient_name" DESC`);
  });

  it("treats an unknown direction as ascending, not as an error", async () => {
    const result = await list("phone", "sideways");

    expect(result.order).toEqual({ column: "phone", direction: "asc" });
  });

  it("leaves the query unordered when the resource declares no default and asks for none", async () => {
    const result = await list(undefined, undefined, {
      ...RESOURCE,
      list: { columns: [{ column: "patient_name", label: "Patient" }] },
    });

    expect(pageSql()).not.toContain("ORDER BY");
    expect(result.order).toBeNull();
  });
});

describe("PluginAdminController.list: searching and filtering", () => {
  /** A resource whose form declares a select and a boolean over listed columns. */
  const FILTERABLE = {
    ...RESOURCE,
    list: {
      columns: [
        { column: "patient_name", label: "Patient" },
        { column: "phone", label: "Phone" },
        { column: "status", label: "Status" },
        { column: "confirmed", label: "Confirmed" },
        { column: "visit_at", label: "When" },
      ],
    },
    form: {
      fields: [
        { column: "patient_name", label: "Patient name" },
        {
          column: "status",
          label: "Status",
          input: "select",
          options: [
            { value: "new", label: "New" },
            { value: "done", label: "Done" },
          ],
        },
        { column: "confirmed", label: "Confirmed", input: "boolean" },
        // Declared as a select but NOT one of the listed columns.
        {
          column: "internal_notes",
          label: "Notes",
          input: "select",
          options: [{ value: "flagged", label: "Flagged" }],
        },
      ],
    },
  };

  const WIDE_TABLE = {
    name: TABLE.name,
    columns: [
      { name: "patient_name", type: "text" },
      { name: "phone", type: "text" },
      { name: "status", type: "text" },
      { name: "internal_notes", type: "text" },
      { name: "confirmed", type: "boolean" },
      { name: "visit_at", type: "timestamptz" },
    ],
  };

  function wide(resource: unknown = FILTERABLE) {
    const plugins = {
      adminResourceFor: vi.fn().mockResolvedValue({ resource, table: WIDE_TABLE }),
      dispatchActionTo: vi.fn().mockResolvedValue(undefined),
    };
    return new PluginAdminController(plugins as never);
  }

  function sql(kind: "page" | "count"): { text: string; values: unknown[] } {
    const call = holder.db.$queryRawUnsafe.mock.calls.find((c: unknown[]) =>
      kind === "count" ? String(c[0]).includes("count(*)") : !String(c[0]).includes("count(*)"),
    );
    return { text: String(call?.[0]), values: (call ?? []).slice(1) };
  }

  beforeEach(() => {
    holder.db = {
      $queryRawUnsafe: vi.fn(async (text: string) =>
        text.includes("count(*)") ? [{ count: 3n }] : [{ id: ROW_ID }],
      ),
      $executeRawUnsafe: vi.fn(),
    };
  });

  async function list(query: Record<string, unknown>, resource?: unknown) {
    return wide(resource).list(
      actor(RESOURCE.permissions.read),
      "s1",
      "vn.zsoft.plugin.medical",
      RESOURCE.key,
      query,
      undefined,
      undefined,
      undefined,
      undefined,
      typeof query.q === "string" ? query.q : undefined,
    );
  }

  it("searches the listed TEXT columns, in one OR group, with one bound term", async () => {
    const result = await list({ q: "anh" });

    const { text, values } = sql("page");
    expect(text).toContain(
      `("patient_name"::text ILIKE $3 OR "phone"::text ILIKE $3 OR "status"::text ILIKE $3)`,
    );
    // One placeholder, one value — not one copy of the term per column.
    expect(values).toEqual(["t1", "s1", "%anh%"]);
    expect(result.searchable).toEqual(["patient_name", "phone", "status"]);
  });

  it("never searches a column the plugin did not list, nor a non-text one", async () => {
    const { text } = (await list({ q: "anh" }), sql("page"));

    expect(text).not.toContain("internal_notes");
    expect(text).not.toContain("confirmed");
    expect(text).not.toContain("visit_at");
  });

  it("counts the SAME filtered set, or the pager walks off the end of it", async () => {
    await list({ q: "anh", "f.status": "new" });

    const count = sql("count");
    expect(count.text).toContain("ILIKE");
    expect(count.text).toContain(`"status" = `);
    expect(count.values).toEqual(["t1", "s1", "new", "%anh%"]);
  });

  it("treats a blank search as no search at all", async () => {
    await list({ q: "   " });

    expect(sql("page").text).not.toContain("ILIKE");
  });

  it("escapes LIKE wildcards so a term is a substring, not a pattern", async () => {
    await list({ q: "100%_x" });

    const value = sql("page").values.at(-1);
    expect(value).toBe("%100\\%\\_x%");
  });

  it("binds a hostile term as a parameter, never as SQL", async () => {
    await list({ q: "'; DROP TABLE users; --" });

    expect(sql("page").text).not.toContain("DROP TABLE");
    expect(sql("page").values).toContain("%'; DROP TABLE users; --%");
  });

  it("caps the term rather than passing an unbounded string to the database", async () => {
    await list({ q: "x".repeat(5000) });

    const value = String(sql("page").values.at(-1));
    // %…% around 200 characters.
    expect(value.length).toBe(202);
  });

  it("applies a select filter whose value the plugin declared", async () => {
    const result = await list({ "f.status": "done" });

    expect(sql("page").text).toContain(`"status" = $3`);
    expect(sql("page").values).toEqual(["t1", "s1", "done"]);
    expect(result.filters).toEqual({ status: "done" });
  });

  it("coerces a boolean filter to a real boolean", async () => {
    const result = await list({ "f.confirmed": "false" });

    expect(result.filters).toEqual({ confirmed: false });
    expect(sql("page").values).toEqual(["t1", "s1", false]);
  });

  it("DROPS a value the plugin never declared", async () => {
    const result = await list({ "f.status": "' OR 1=1 --" });

    expect(result.filters).toEqual({});
    expect(sql("page").text).not.toContain("status");
  });

  it("DROPS a filter on a column the plugin declared but did not list", async () => {
    // `internal_notes` is a select in the form, but not a listed column — the screen
    // does not show it, so it is not a lens to sift the table through either.
    const result = await list({ "f.internal_notes": "flagged" });

    expect(result.filters).toEqual({});
  });

  it("DROPS a filter on a column with no select/boolean declaration", async () => {
    // A free-text column has no knowable set of values, so it gets the search box,
    // not a dropdown that pretends to be exhaustive.
    const result = await list({ "f.patient_name": "Anh" });

    expect(result.filters).toEqual({});
  });

  it("ignores an unprefixed parameter that happens to share a column's name", async () => {
    const result = await list({ status: "new" });

    expect(result.filters).toEqual({});
  });

  it("reports no searchable columns when the resource lists none that are text", async () => {
    const result = await list(
      { q: "anh" },
      { ...FILTERABLE, list: { columns: [{ column: "confirmed", label: "Confirmed" }] } },
    );

    expect(result.searchable).toEqual([]);
    expect(sql("page").text).not.toContain("ILIKE");
  });
});

describe("PluginAdminController: the id guard covers the write routes too", () => {
  beforeEach(() => {
    holder.db = makeDb([{ id: ROW_ID }]);
  });

  it("404s an update with a malformed id, and writes nothing", async () => {
    const { controller } = make();

    await expect(
      controller.update(
        actor(RESOURCE.permissions.read, RESOURCE.permissions.write),
        "s1",
        "vn.zsoft.plugin.medical",
        RESOURCE.key,
        "not-a-uuid",
        { patient_name: "X" },
      ),
    ).rejects.toThrow(NotFoundException);
    expect(holder.db.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  it("404s a delete with a malformed id, and deletes nothing", async () => {
    const { controller } = make();

    await expect(
      controller.remove(
        actor(RESOURCE.permissions.read, RESOURCE.permissions.write),
        "s1",
        "vn.zsoft.plugin.medical",
        RESOURCE.key,
        "not-a-uuid",
      ),
    ).rejects.toThrow(NotFoundException);
    expect(holder.db.$executeRawUnsafe).not.toHaveBeenCalled();
  });
});

/**
 * The generic CRUD screen writes what the form posted and has no idea what it
 * means. `admin.record.changed` is how the plugin that owns the table finds out —
 * so a stock movement typed at the counter moves the same balance as one its own
 * code inserted.
 */
describe("PluginAdminController: telling the plugin a human changed its rows", () => {
  const write = () => actor(RESOURCE.permissions.read, RESOURCE.permissions.write);

  beforeEach(() => {
    holder.db = makeDb([{ id: ROW_ID, patient_name: "Nguyễn Minh Anh" }]);
  });

  it("fires at the owning plugin after a create, with the row that was written", async () => {
    const { controller, plugins } = make();

    await controller.create(write(), "s1", "vn.zsoft.plugin.medical", RESOURCE.key, {
      patient_name: "Nguyễn Minh Anh",
      phone: "0901 234 567",
    });

    const [tenantId, siteId, pluginKey, action, payload] =
      plugins.dispatchActionTo.mock.calls[0]!;
    expect([tenantId, siteId, pluginKey, action]).toEqual([
      "t1",
      "s1",
      "vn.zsoft.plugin.medical",
      "admin.record.changed",
    ]);
    expect(payload).toMatchObject({
      resource: RESOURCE.key,
      table: TABLE.name,
      operation: "created",
      rowId: ROW_ID,
      previous: null,
    });
    expect(payload.row).toMatchObject({ patient_name: "Nguyễn Minh Anh" });
  });

  it("carries the row as it was, as well as as it is, on an update", async () => {
    const { controller, plugins } = make();
    holder.db.$queryRawUnsafe = vi
      .fn()
      .mockResolvedValueOnce([{ id: ROW_ID, patient_name: "Before" }])
      .mockResolvedValueOnce([{ id: ROW_ID, patient_name: "After" }]);

    await controller.update(write(), "s1", "vn.zsoft.plugin.medical", RESOURCE.key, ROW_ID, {
      patient_name: "After",
    });

    const payload = plugins.dispatchActionTo.mock.calls[0]![4];
    expect(payload.operation).toBe("updated");
    // Without the old value a handler cannot reverse what the edit undid.
    expect(payload.previous).toMatchObject({ patient_name: "Before" });
    expect(payload.row).toMatchObject({ patient_name: "After" });
  });

  it("carries only the vanished row on a delete", async () => {
    const { controller, plugins } = make();

    await controller.remove(write(), "s1", "vn.zsoft.plugin.medical", RESOURCE.key, ROW_ID);

    const payload = plugins.dispatchActionTo.mock.calls[0]![4];
    expect(payload).toMatchObject({ operation: "deleted", row: null });
    expect(payload.previous).toMatchObject({ id: ROW_ID });
  });

  it("says nothing when the delete removed nothing", async () => {
    const { controller, plugins } = make();
    holder.db.$executeRawUnsafe = vi.fn().mockResolvedValue(0);

    await controller.remove(write(), "s1", "vn.zsoft.plugin.medical", RESOURCE.key, ROW_ID);

    expect(plugins.dispatchActionTo).not.toHaveBeenCalled();
  });

  it("saves the row even when the plugin's handler is broken", async () => {
    const { controller, plugins } = make();
    plugins.dispatchActionTo.mockRejectedValue(new Error("the plugin exploded"));

    const result = await controller.create(
      write(),
      "s1",
      "vn.zsoft.plugin.medical",
      RESOURCE.key,
      { patient_name: "Nguyễn Minh Anh", phone: "0901 234 567" },
    );

    // The write already happened; an action is a notification, not a gate.
    expect(result.row).toMatchObject({ id: ROW_ID });
  });
});

/**
 * The picker behind a `reference`, and the rows that belong to a record.
 *
 * Both are listings of a resource OTHER than the one on screen, which is the whole
 * reason they need their own permission check: a shift form must not become a way
 * to read the staff table, and a menu item must not become a way to read costs.
 */
describe("PluginAdminController: references and children", () => {
  const STAFF_TABLE = {
    name: "p_vn_zsoft_plugin_medical__staff",
    columns: [{ name: "full_name", type: "text" }],
  } as const;

  const SHIFTS = {
    key: "shifts",
    label: "Shifts",
    table: TABLE.name,
    list: { columns: [{ column: "patient_name", label: "Staff" }] },
    form: {
      fields: [
        {
          column: "phone",
          label: "Staff",
          input: "reference",
          refTable: STAFF_TABLE.name,
          refValue: "id",
          refLabel: "full_name",
        },
      ],
    },
    permissions: { read: "x:p:shifts:read", write: "x:p:shifts:manage" },
  };
  const STAFF = {
    key: "staff",
    label: "Staff",
    table: STAFF_TABLE.name,
    list: { columns: [{ column: "full_name", label: "Name" }] },
    permissions: { read: "x:p:staff:read" },
  };

  /**
   * The plugin as the controller sees it: the resource on screen, plus its
   * siblings — which is the point, since a reference and a child both name one.
   */
  function withSiblings(resource: { key: string } = SHIFTS) {
    const own = resource.key === STAFF.key ? STAFF_TABLE : TABLE;
    const siblings = [
      { resource: SHIFTS, table: TABLE },
      { resource: STAFF, table: STAFF_TABLE },
    ].filter((entry) => entry.resource.key !== resource.key);

    const plugins = {
      adminResourceFor: vi.fn().mockResolvedValue({ resource, table: own }),
      adminResourcesFor: vi
        .fn()
        .mockResolvedValue([{ resource, table: own }, ...siblings]),
      dispatchActionTo: vi.fn().mockResolvedValue(undefined),
    };
    return { controller: new PluginAdminController(plugins as never), plugins };
  }

  beforeEach(() => {
    // `phone` is this fixture's reference column, so the row has to point at
    // something for there to be anything to name.
    holder.db = makeDb([{ id: ROW_ID, full_name: "Nguyễn Thảo Vy", phone: ROW_ID }]);
  });

  it("answers a reference with {value,label} from the table it points at", async () => {
    const { controller } = withSiblings();

    const result = await controller.options(
      actor("x:p:shifts:read", "x:p:staff:read"),
      "s1",
      "vn.zsoft.plugin.medical",
      "shifts",
      "phone",
      "vy",
    );

    expect(result.options).toEqual([{ value: ROW_ID, label: "Nguyễn Thảo Vy" }]);
    // Searched on the label column, in the referenced table — not this one.
    const [text] = holder.db.$queryRawUnsafe.mock.calls[0];
    expect(text).toContain(`FROM "${STAFF_TABLE.name}"`);
    expect(text).toContain("ILIKE");
  });

  it("resolves ONE stored value to its label, for a form opening on a saved row", async () => {
    const { controller } = withSiblings();

    const result = await controller.options(
      actor("x:p:shifts:read", "x:p:staff:read"),
      "s1",
      "vn.zsoft.plugin.medical",
      "shifts",
      "phone",
      undefined,
      ROW_ID,
    );

    expect(result.options).toEqual([{ value: ROW_ID, label: "Nguyễn Thảo Vy" }]);
    // A lookup, not a search: an equality on the stored column, not an ILIKE.
    const [text, ...values] = holder.db.$queryRawUnsafe.mock.calls[0];
    expect(text).not.toContain("ILIKE");
    expect(values).toContain(ROW_ID);
  });

  it("names a record's references, so a read screen shows a person not a uuid", async () => {
    const { controller } = withSiblings();

    const result = await controller.detail(
      actor("x:p:shifts:read", "x:p:staff:read"),
      "s1",
      "vn.zsoft.plugin.medical",
      "shifts",
      ROW_ID,
    );

    expect(result.references).toEqual({ phone: "Nguyễn Thảo Vy" });
  });

  it("leaves a reference unnamed for a reader who may not read its table", async () => {
    const { controller } = withSiblings();

    const result = await controller.detail(
      actor("x:p:shifts:read"),
      "s1",
      "vn.zsoft.plugin.medical",
      "shifts",
      ROW_ID,
    );

    // The record still opens; the name simply is not theirs to be told.
    expect(result.references).toEqual({});
    expect(result.row).toMatchObject({ id: ROW_ID });
  });

  it("refuses the picker to someone who may not read the referenced resource", async () => {
    const { controller } = withSiblings();

    // Holds the shift screen's own permission, but not the staff screen's. A form
    // is not a side door onto a table.
    await expect(
      controller.options(
        actor("x:p:shifts:read"),
        "s1",
        "vn.zsoft.plugin.medical",
        "shifts",
        "phone",
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it("404s a column that is not a reference at all", async () => {
    const { controller } = withSiblings();

    await expect(
      controller.options(
        actor("x:p:shifts:read", "x:p:staff:read"),
        "s1",
        "vn.zsoft.plugin.medical",
        "shifts",
        "patient_name",
      ),
    ).rejects.toThrow(NotFoundException);
  });

  it("returns a record's child rows, filtered by the parent's own value", async () => {
    const parent = {
      ...STAFF,
      children: [{ resource: "shifts", foreignColumn: "phone", localColumn: "id", label: "Shifts" }],
    };
    const { controller } = withSiblings(parent);

    const result = await controller.detail(
      actor("x:p:staff:read", "x:p:shifts:read"),
      "s1",
      "vn.zsoft.plugin.medical",
      "staff",
      ROW_ID,
    );

    expect(result.children).toHaveLength(1);
    expect(result.children[0]).toMatchObject({ resource: "shifts", label: "Shifts" });
    // The join is the parent's value, bound as a parameter like any other filter.
    const childQuery = holder.db.$queryRawUnsafe.mock.calls.at(-1)!;
    expect(String(childQuery[0])).toContain('"phone" = $3');
    expect(childQuery).toContain(ROW_ID);
  });

  it("omits a child the reader may not see, and still shows them the record", async () => {
    const parent = {
      ...STAFF,
      children: [{ resource: "shifts", foreignColumn: "phone", localColumn: "id", label: "Shifts" }],
    };
    const { controller } = withSiblings(parent);

    const result = await controller.detail(
      actor("x:p:staff:read"),
      "s1",
      "vn.zsoft.plugin.medical",
      "staff",
      ROW_ID,
    );

    // Omitted, not refused: the record is theirs to read, the child is not.
    expect(result.children).toEqual([]);
    expect(result.row).toMatchObject({ id: ROW_ID });
  });
});
