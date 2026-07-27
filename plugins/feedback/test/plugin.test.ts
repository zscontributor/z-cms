import { describe, expect, it, vi } from "vitest";
import plugin from "../src";

function makeCtx(initial: unknown[] = []) {
  let store: unknown[] = initial;
  const storage = {
    get: vi.fn(async () => store),
    set: vi.fn(async (_key: string, value: unknown) => {
      store = value as unknown[];
    }),
    delete: vi.fn(),
    list: vi.fn(),
  };
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { ctx: { storage, log, site: { id: "s1", name: "Acme", locale: "en" } } as never, storage, log, get: () => store };
}

describe("Feedback plugin", () => {
  it("declares the feedback form in its manifest", () => {
    expect(plugin.manifest.forms).toBeDefined();
    const form = plugin.manifest.forms!.find((f) => f.id === "feedback");
    expect(form).toBeDefined();
    expect(form!.fields.map((f) => f.name)).toEqual(["name", "email", "message"]);
  });

  it("stores a submission and returns ok", async () => {
    const { ctx, storage, get } = makeCtx();
    const res = await plugin.calls!["forms.submit"](
      { formId: "feedback", values: { name: "Jane", email: "jane@example.com", message: "Nice work!" } },
      ctx,
    );
    expect(res).toEqual({ ok: true });
    expect(storage.set).toHaveBeenCalledTimes(1);
    const saved = get() as Record<string, unknown>[];
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ name: "Jane", message: "Nice work!" });
    expect(typeof saved[0]!.at).toBe("string"); // timestamped
  });

  it("appends across submissions", async () => {
    const { ctx, get } = makeCtx([{ name: "Prior", message: "earlier", at: "x" }]);
    await plugin.calls!["forms.submit"]({ formId: "feedback", values: { name: "Bob", message: "second" } }, ctx);
    expect((get() as unknown[]).length).toBe(2);
  });

  it("rejects a form id it does not own", async () => {
    const { ctx, storage } = makeCtx();
    const res = await plugin.calls!["forms.submit"]({ formId: "other", values: {} }, ctx);
    expect(res).toEqual({ ok: false });
    expect(storage.set).not.toHaveBeenCalled();
  });
});
