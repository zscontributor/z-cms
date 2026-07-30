import { BadRequestException, NotFoundException } from "@nestjs/common";
import type { FormDefinition } from "@zcmsorg/schemas";
import { beforeEach, describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({ domain: null as any }));

vi.mock("@zcmsorg/database", () => ({
  getSystemDb: () => ({
    domain: { findUnique: vi.fn().mockResolvedValue(holder.domain) },
  }),
}));

import { FormsService } from "../forms.service";

const SITE = { id: "site-1", tenantId: "tenant-1", name: "Acme", status: "PUBLISHED" };

const FEEDBACK: FormDefinition = {
  id: "feedback",
  fields: [
    { name: "email", type: "email" },
    { name: "message", type: "textarea", required: true, minLength: 10, maxLength: 2000 },
  ],
};

function make(over: { form?: FormDefinition | null; result?: unknown } = {}) {
  const plugins = {
    findForm: vi
      .fn()
      .mockResolvedValue(
        over.form === undefined ? { pluginKey: "vn.zsoft.plugin.feedback", form: FEEDBACK } : over.form
          ? { pluginKey: "vn.zsoft.plugin.feedback", form: over.form }
          : null,
      ),
    callPlugin: vi.fn().mockResolvedValue(over.result === undefined ? { ok: true } : over.result),
  };
  const service = new FormsService(plugins as any);
  return { service, plugins };
}

describe("FormsService", () => {
  beforeEach(() => {
    holder.domain = { hostname: "acme.com", site: { ...SITE } };
  });

  it("validates against the declared fields and dispatches to the owning plugin", async () => {
    const { service, plugins } = make();
    const res = await service.submit("acme.com", "feedback", {
      email: "jane@example.com",
      message: "Hello, this is long enough",
    });
    expect(res).toEqual({ ok: true });
    expect(plugins.findForm).toHaveBeenCalledWith("tenant-1", "site-1", "feedback");
    const [tenantId, siteId, pluginKey, name, payload] = plugins.callPlugin.mock.calls[0]!;
    expect([tenantId, siteId, pluginKey, name]).toEqual([
      "tenant-1",
      "site-1",
      "vn.zsoft.plugin.feedback",
      "forms.submit",
    ]);
    expect(payload).toEqual({
      formId: "feedback",
      values: { email: "jane@example.com", message: "Hello, this is long enough" },
    });
  });

  it("404s a form no active plugin declares", async () => {
    const { service, plugins } = make({ form: null });
    await expect(service.submit("acme.com", "feedback", { message: "long enough here" })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(plugins.callPlugin).not.toHaveBeenCalled();
  });

  it("rejects values that fail the declared rules, without dispatching", async () => {
    const { service, plugins } = make();
    // message too short (minLength 10), and required
    await expect(service.submit("acme.com", "feedback", { message: "short" })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(service.submit("acme.com", "feedback", { email: "aa@aa", message: "long enough here" })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(plugins.callPlugin).not.toHaveBeenCalled();
  });

  it("says WHICH field was refused, as a code the browser can word itself", async () => {
    const { service } = make();

    // Before this, the only machine-readable part of a refusal was "400", so the
    // form could say no more than "check the fields and try again".
    const error = await service
      .submit("acme.com", "feedback", { email: "not-an-email", message: "short" })
      .catch((err: BadRequestException) => err);

    expect(error).toBeInstanceOf(BadRequestException);
    const body = (error as BadRequestException).getResponse() as {
      fields?: Record<string, string>;
      message?: string;
    };
    expect(body.fields).toMatchObject({ email: "email", message: "minLength" });
    // The operator's sentence survives alongside it, for the log.
    expect(typeof body.message).toBe("string");
  });

  it("relays a handler's handled rejection as { ok: false }", async () => {
    const { service } = make({ result: { ok: false } });
    const res = await service.submit("acme.com", "feedback", { message: "long enough here" });
    expect(res).toEqual({ ok: false });
  });

  it("treats a void handler return as success", async () => {
    const { service } = make({ result: undefined });
    const res = await service.submit("acme.com", "feedback", { message: "long enough here" });
    expect(res).toEqual({ ok: true });
  });

  it("rejects an unknown form id shape and a missing/unpublished site", async () => {
    const { service } = make();
    await expect(service.submit("acme.com", "Bad Id!", { message: "long enough here" })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    holder.domain = { hostname: "acme.com", site: { ...SITE, status: "DRAFT" } };
    await expect(service.submit("acme.com", "feedback", { message: "long enough here" })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("requires a hostname", async () => {
    const { service } = make();
    await expect(service.submit("", "feedback", { message: "long enough here" })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
