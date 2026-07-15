import { beforeEach, describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({ systemDb: null as any, tenantDb: null as any }));
vi.mock("@zcmsorg/database", () => ({ getSystemDb: () => holder.systemDb, db: () => holder.tenantDb }));
import { AiController, AiService, IntegrationController } from "../ai.module";

const actor = {
  userId: "u1", tenantId: "t1", siteId: "s1", email: "a@z.test", role: "ADMIN",
  permissions: ["content:read", "content:create", "content:update", "content:delete", "content:publish"],
};
const types = [{ id: "11111111-1111-4111-8111-111111111111", key: "page", name: "Page", fields: [] }];

/**
 * Note what is NOT here any more: no `openaiApiKey`, no `defaultProvider`.
 *
 * Core no longer holds a provider key, no longer picks a model and no longer opens
 * a socket — the plugin does all three, in the sandbox, through `ctx.http` and the
 * hosts its manifest declares. What is left in core is the one setting core has to
 * enforce (may the AI drive content CRUD?) and the actor's permissions.
 */
const enabled = { contentManagementEnabled: true };

function setup() {
  const contents = {
    list: vi.fn().mockResolvedValue({ items: [], total: 0 }), findOne: vi.fn(), create: vi.fn(),
    update: vi.fn(), setPublished: vi.fn(), remove: vi.fn(),
  };
  const plugins = { callCapability: vi.fn() };
  const service = new AiService(contents as any, plugins as any);
  holder.systemDb = { sitePlugin: { findFirst: vi.fn().mockResolvedValue({ settings: enabled }) } };
  holder.tenantDb = {
    contentType: { findMany: vi.fn().mockResolvedValue(types) },
    siteTheme: { findFirst: vi.fn().mockResolvedValue({ theme: { key: "default" } }) },
    content: { findMany: vi.fn().mockResolvedValue([]) },
  };
  return { service, contents, plugins };
}

/** The plugin's answer. Core parses the command out of it; it never produced it. */
function aiReturns(plugins: { callCapability: ReturnType<typeof vi.fn> }, value: object) {
  plugins.callCapability.mockResolvedValue({
    answer: JSON.stringify(value),
    provider: "openai",
  });
}

describe("zAI core CRUD boundary", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("reaches the AI by CAPABILITY, and insists on the core plugin for content CRUD", async () => {
    // Two things at once, and both matter. Core asks for whoever provides
    // `ai.assistant` — it no longer knows zAI by name, so swapping the AI plugin is
    // an install rather than a patch. But the admin operator turns the model's reply
    // into content CRUD under the ACTOR's permissions, so this one call demands the
    // platform's own plugin: any marketplace package can claim the capability string
    // in its manifest, and `isCore` is a column only the platform can set.
    const { service, plugins } = setup();
    aiReturns(plugins, { action: "list", contentTypeKey: "page" });

    await service.adminChat(actor as any, "s1", [{ role: "user", content: "list" }], false);

    expect(plugins.callCapability).toHaveBeenCalledWith(
      "t1", "s1", "ai.assistant", "chat",
      expect.objectContaining({
        systemPrompt: expect.stringContaining("admin content operator"),
      }),
      { requireCore: true },
    );
  });

  it("refuses when the trusted core plugin is absent, or content management is OFF", async () => {
    const { service } = setup();
    holder.systemDb.sitePlugin.findFirst.mockResolvedValue(null);
    await expect(service.adminChat(actor as any, "s1", [{ role: "user", content: "list" }], false))
      .rejects.toThrow("trusted core AI plugin is not active");

    holder.systemDb.sitePlugin.findFirst.mockResolvedValue({ settings: { contentManagementEnabled: false } });
    await expect(service.adminChat(actor as any, "s1", [{ role: "user", content: "list" }], false))
      .rejects.toThrow("content management is disabled");
  });

  it("enforces the actor permission for the AI-selected action", async () => {
    const { service, contents, plugins } = setup(); aiReturns(plugins, { action: "delete", id: "x" });
    await expect(service.adminChat({ ...actor, permissions: ["content:read"] } as any, "s1", [{ role: "user", content: "delete" }], true))
      .rejects.toThrow("content:delete");
    expect(contents.remove).not.toHaveBeenCalled();
  });

  it("requires confirmation before delete and delegates only after confirmation", async () => {
    const { service, contents, plugins } = setup(); aiReturns(plugins, { action: "delete", id: "x" });
    const first = await service.adminChat(actor as any, "s1", [{ role: "user", content: "delete" }], false);
    expect(first.confirmationRequired).toBe(true); expect(contents.remove).not.toHaveBeenCalled();
    contents.findOne.mockResolvedValue({ contentType: { key: "page" } });
    await service.adminChat(actor as any, "s1", [{ role: "user", content: "delete" }], true);
    expect(contents.remove).toHaveBeenCalledWith(actor, "s1", "x");
  });

  it("validates create input and blocks ids belonging to other content types", async () => {
    const { service, contents, plugins } = setup();
    aiReturns(plugins, { action: "create", contentTypeKey: "page", input: { title: "About", slug: "about" } });
    contents.create.mockResolvedValue({ title: "About", status: "DRAFT" });
    await service.adminChat(actor as any, "s1", [{ role: "user", content: "create" }], false);
    expect(contents.create).toHaveBeenCalledWith(actor, "s1", expect.objectContaining({ contentTypeId: types[0]!.id, blocks: [], data: {} }));

    aiReturns(plugins, { action: "update", id: "p1", input: { title: "X" } });
    contents.findOne.mockResolvedValue({ contentType: { key: "product" } });
    await expect(service.adminChat(actor as any, "s1", [{ role: "user", content: "update" }], false))
      .rejects.toThrow("only manage page, post, and blog");
  });
});

describe("core holds no provider key", () => {
  it("the public chat is capability-only: any AI plugin may answer it", async () => {
    // The mirror image of the test above. Content CRUD demands the core plugin;
    // answering a visitor's question does not, so a site that installs a different
    // `ai.assistant` plugin gets a working chat bubble without core changing.
    const { service, plugins } = setup();
    holder.systemDb.domain = {
      findUnique: vi.fn().mockResolvedValue({
        site: { id: "s1", tenantId: "t1", status: "PUBLISHED" },
      }),
    };
    plugins.callCapability.mockResolvedValue({ answer: "Xin chào", provider: "gemini" });

    const res = await service.chat("example.com", [{ role: "user", content: "Hi" }]);

    expect(res).toEqual({ answer: "Xin chào", provider: "gemini" });
    expect(plugins.callCapability).toHaveBeenCalledWith(
      "t1", "s1", "ai.assistant", "chat",
      {
        messages: [{ role: "user", content: "Hi" }],
        systemPrompt: expect.stringContaining("PUBLISHED site content only"),
      },
      { requireCore: undefined },
    );
  });

  it("teaches the assistant that Z-CMS is authored by Z-SOFT Viet Nam", async () => {
    const { service, plugins } = setup();
    holder.systemDb.domain = {
      findUnique: vi.fn().mockResolvedValue({
        site: { id: "s1", tenantId: "t1", status: "PUBLISHED" },
      }),
    };
    plugins.callCapability.mockResolvedValue({
      answer: "Z-CMS được phát triển bởi Công ty Z-SOFT Việt Nam.",
      provider: "openai",
    });

    await service.chat("example.com", [{ role: "user", content: "Tác giả của Z-CMS là ai?" }]);

    const prompt = plugins.callCapability.mock.calls[0][4].systemPrompt;
    expect(prompt).toContain("Z-SOFT Viet Nam");
    expect(prompt).toContain("https://z-soft.com.vn");
    expect(prompt).toContain("Công ty Z-SOFT Việt Nam");
  });

  it("grounds public answers only on published site content", async () => {
    const { service, plugins } = setup();
    holder.systemDb.domain = {
      findUnique: vi.fn().mockResolvedValue({
        site: { id: "s1", tenantId: "t1", status: "PUBLISHED" },
      }),
    };
    holder.tenantDb.content.findMany.mockResolvedValue([
      {
        id: "c1",
        title: "Pricing",
        slug: "pricing",
        locale: "en",
        excerpt: "Public plans start at $19.",
        data: {},
        blocks: [{ id: "b1", type: "core/richtext", props: { html: "Annual plans include support." } }],
        seo: {},
        status: "PUBLISHED",
        updatedAt: new Date("2026-07-01T00:00:00.000Z"),
        contentType: { key: "page", name: "Page", routePrefix: "" },
      },
    ]);
    plugins.callCapability.mockResolvedValue({ answer: "Plans start at $19.", provider: "openai" });

    await service.chat("example.com", [{ role: "user", content: "pricing support" }]);

    expect(holder.tenantDb.content.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ siteId: "s1", status: "PUBLISHED" }),
    }));
    expect(plugins.callCapability.mock.calls[0][4].systemPrompt).toContain("Public plans start at $19.");
    expect(plugins.callCapability.mock.calls[0][4].systemPrompt).toContain("/pricing");
  });

  it("adds repository docs context for the default z-cms.org site", async () => {
    const { service, plugins } = setup();
    holder.systemDb.domain = {
      findUnique: vi.fn().mockResolvedValue({
        hostname: "z-cms.org",
        site: { id: "s1", tenantId: "t1", status: "PUBLISHED" },
      }),
    };
    plugins.callCapability.mockResolvedValue({
      answer: "Z-CMS plugins run in a sandbox.",
      provider: "openai",
    });

    await service.chat("z-cms.org", [{ role: "user", content: "Z-CMS plugin sandbox hoạt động thế nào?" }]);

    const prompt = plugins.callCapability.mock.calls[0][4].systemPrompt;
    expect(prompt).toContain("Z-CMS docs context:");
    expect(prompt).toContain("docs/plugins.md");
    expect(prompt).toContain("For questions about Z-CMS itself, prefer the Z-CMS docs context");
  });

  it("grounds admin requests on admin-visible content after the read permission gate", async () => {
    const { service, plugins } = setup();
    aiReturns(plugins, { action: "list", contentTypeKey: "page" });
    holder.tenantDb.content.findMany.mockResolvedValue([
      {
        id: "draft1",
        title: "Draft roadmap",
        slug: "roadmap",
        locale: "en",
        excerpt: "Private Q4 launch notes.",
        data: {},
        blocks: [],
        seo: {},
        status: "DRAFT",
        updatedAt: new Date("2026-07-02T00:00:00.000Z"),
        contentType: { key: "page", name: "Page", routePrefix: "" },
      },
    ]);

    await service.adminChat(actor as any, "s1", [{ role: "user", content: "roadmap" }], false);

    expect(holder.tenantDb.content.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.not.objectContaining({ status: "PUBLISHED" }),
    }));
    expect(plugins.callCapability.mock.calls[0][4].systemPrompt).toContain("Private Q4 launch notes.");
  });

  it("never reads an API key, and never names a provider host", async () => {
    // The whole point of the refactor, asserted rather than asserted-about. Core
    // used to fetch api.openai.com with `settings.openaiApiKey` in a header. If
    // anyone puts that back, this fails: the source no longer mentions either, and
    // the only thing core sends the plugin is the transcript.
    const fs = await import("node:fs");
    const path = await import("node:path");
    const source = fs.readFileSync(path.resolve(__dirname, "../ai.module.ts"), "utf8");
    const code = source.replace(/\/\*\*[\s\S]*?\*\/|\/\/.*$/gm, ""); // strip comments

    expect(code).not.toContain("api.openai.com");
    expect(code).not.toContain("api.anthropic.com");
    expect(code).not.toContain("generativelanguage");
    expect(code).not.toMatch(/ApiKey/);
    expect(code).not.toMatch(/\bfetch\s*\(/);
  });
});

describe("public integration action contract", () => {
  it("routes the stable capability action to zAI", async () => {
    const { service } = setup();
    const chat = vi.spyOn(service, "chat").mockResolvedValue({ answer: "Hello", provider: "openai" });
    const controller = new IntegrationController(service);

    await expect(controller.action(
      "ai.assistant",
      "chat",
      "example.com",
      { messages: [{ role: "user", content: "Hi" }] },
    )).resolves.toEqual({ answer: "Hello", provider: "openai" });
    expect(chat).toHaveBeenCalledWith("example.com", [{ role: "user", content: "Hi" }]);
  });

  it("rejects unknown capability actions instead of becoming an open proxy", () => {
    const { service } = setup();
    const controller = new IntegrationController(service);

    expect(() => controller.action("evil.proxy", "fetch", "example.com", { messages: [] }))
      .toThrow("Integration action not found");
  });
});

describe("zAI admin route metadata", () => {
  it("requires authenticated site scope and content:read", () => {
    const fn = Object.getOwnPropertyDescriptor(AiController.prototype, "adminChat")!.value;
    expect(Reflect.getMetadata("auth:site-scoped", fn)).toBe(true);
    expect(Reflect.getMetadata("auth:permissions", fn)).toEqual(["content:read"]);
    expect(Reflect.getMetadata("auth:public", fn)).not.toBe(true);
    expect(Reflect.getMetadata("auth:internal", fn)).not.toBe(true);
  });
});
