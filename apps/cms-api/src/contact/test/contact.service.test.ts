import { BadRequestException, NotFoundException } from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The only external I/O is the system database. Everything the service decides —
// who the mail goes to, what it refuses — is left real.
const holder = vi.hoisted(() => ({
  domain: null as any,
  themeSettings: null as any,
}));

vi.mock("@zcmsorg/database", () => ({
  getSystemDb: () => ({
    domain: { findUnique: vi.fn().mockResolvedValue(holder.domain) },
    siteTheme: {
      findFirst: vi.fn().mockResolvedValue(
        holder.themeSettings === null ? null : { settings: holder.themeSettings },
      ),
    },
  }),
}));

import { ContactService } from "../contact.service";

const SITE = {
  id: "site-1",
  tenantId: "tenant-1",
  name: "Acme",
  status: "PUBLISHED",
  defaultLocale: "en",
};

const VALID = {
  name: "Jane Doe",
  company: "Acme Corp",
  email: "jane@example.com",
  need: "A new website",
  message: "Please call me back.",
};

function make() {
  const mail = { enqueue: vi.fn().mockResolvedValue({ queued: true }) };
  const service = new ContactService(mail as any);
  return { service, mail };
}

describe("ContactService", () => {
  beforeEach(() => {
    holder.domain = { hostname: "acme.com", site: { ...SITE } };
    holder.themeSettings = { contactEmail: "owner@acme.com" };
  });

  it("mails the site's configured contact address, with the visitor as reply-to", async () => {
    const { service, mail } = make();
    await service.submit("acme.com", VALID);

    expect(mail.enqueue).toHaveBeenCalledTimes(1);
    const [tenantId, siteId, pluginKey, message] = mail.enqueue.mock.calls[0]!;
    expect(tenantId).toBe("tenant-1");
    expect(siteId).toBe("site-1");
    // CMS mail, not a plugin's — no plugin quota applies.
    expect(pluginKey).toBeNull();
    expect(message.to).toEqual(["owner@acme.com"]);
    expect(message.replyTo).toBe("jane@example.com");
    expect(message.subject).toContain("Jane Doe");
    expect(message.text).toContain("Please call me back.");
    // The body must never become the envelope: no `from` is ever set by the caller.
    expect(message).not.toHaveProperty("from");
  });

  it("takes the recipient from theme settings, never from the request", async () => {
    const { service, mail } = make();
    // A malicious client trying to redirect the mail elsewhere.
    await service.submit("acme.com", { ...VALID, to: "attacker@evil.com" } as any);

    const message = mail.enqueue.mock.calls[0]![3];
    expect(message.to).toEqual(["owner@acme.com"]);
  });

  it("rejects an invalid submission and sends nothing", async () => {
    const { service, mail } = make();
    await expect(service.submit("acme.com", { ...VALID, email: "not-an-email" })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(mail.enqueue).not.toHaveBeenCalled();
  });

  it("refuses when the theme has no valid contact email", async () => {
    holder.themeSettings = { contactEmail: "" };
    const { service, mail } = make();
    await expect(service.submit("acme.com", VALID)).rejects.toBeInstanceOf(BadRequestException);
    expect(mail.enqueue).not.toHaveBeenCalled();
  });

  it("404s an unknown or unpublished site", async () => {
    holder.domain = { hostname: "acme.com", site: { ...SITE, status: "DRAFT" } };
    const { service, mail } = make();
    await expect(service.submit("acme.com", VALID)).rejects.toBeInstanceOf(NotFoundException);

    holder.domain = null;
    await expect(service.submit("acme.com", VALID)).rejects.toBeInstanceOf(NotFoundException);
    expect(mail.enqueue).not.toHaveBeenCalled();
  });

  it("requires a hostname", async () => {
    const { service } = make();
    await expect(service.submit("", VALID)).rejects.toBeInstanceOf(BadRequestException);
  });
});
