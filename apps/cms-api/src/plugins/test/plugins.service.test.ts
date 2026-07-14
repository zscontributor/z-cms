import { beforeEach, describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({ systemDb: null as any }));
vi.mock("@zcmsorg/database", () => ({
  getSystemDb: () => holder.systemDb,
}));

import { PluginsService } from "../plugins.service";

function activeRow(over: Record<string, unknown> = {}) {
  return {
    plugin: { key: "zsoft-seo", id: "plugin-1" },
    version: {
      version: "1.0.0",
      origin: "BUILTIN",
      manifest: { capabilities: ["seo.metadata"], settingsSchema: { properties: {} } },
    },
    settings: {},
    grantedPermissions: ["content:read"],
    ...over,
  };
}

function makeSystemDb() {
  return {
    sitePlugin: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
    },
    site: { findFirst: vi.fn().mockResolvedValue({ id: "s1", name: "Main", defaultLocale: "en" }) },
  };
}

const config = {
  get: (k: string) => (k === "PLUGIN_RUNTIME_URL" ? "http://runtime" : undefined),
  getOrThrow: (_k: string) => "internal-token",
};
const tokens = {
  mint: vi.fn().mockResolvedValue({ token: "plugin-token", jti: "jti-1" }),
  retire: vi.fn().mockResolvedValue(undefined),
};

function makeService() {
  return new PluginsService(config as any, tokens as any);
}

describe("PluginsService", () => {
  beforeEach(() => {
    holder.systemDb = makeSystemDb();
    tokens.mint.mockClear();
    vi.stubGlobal("fetch", vi.fn());
  });

  describe("capabilitiesFor", () => {
    it("only considers the active plugins of the given tenant and site", async () => {
      // Cross-tenant leak guard: a plugin active on another tenant's site must not
      // contribute capabilities to this render payload.
      await makeService().capabilitiesFor("t1", "s1");

      const where = holder.systemDb.sitePlugin.findMany.mock.calls[0][0].where;
      expect(where.tenantId).toBe("t1");
      expect(where.siteId).toBe("s1");
      expect(where.status).toBe("ACTIVE");
    });

    it("collects and de-duplicates capabilities across plugins", async () => {
      holder.systemDb.sitePlugin.findMany.mockResolvedValue([
        { version: { manifest: { capabilities: ["seo.metadata", "sitemap"] } } },
        { version: { manifest: { capabilities: ["seo.metadata"] } } },
      ]);

      const caps = await makeService().capabilitiesFor("t1", "s1");

      expect([...caps].sort()).toEqual(["seo.metadata", "sitemap"]);
    });
  });

  describe("aiAssistantFor", () => {
    it("returns only public presentation settings, never provider credentials", async () => {
      holder.systemDb.sitePlugin.findFirst.mockResolvedValue({
        settings: {
          assistantName: "Help bot",
          welcomeMessage: "Hello",
          openaiApiKey: "secret",
        },
      });

      await expect(makeService().aiAssistantFor("t1", "s1")).resolves.toEqual({
        name: "Help bot",
        welcomeMessage: "Hello",
      });
    });

    it("does not expose assistant chrome when zAI is inactive", async () => {
      await expect(makeService().aiAssistantFor("t1", "s1")).resolves.toBeUndefined();
      expect(holder.systemDb.sitePlugin.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: "ACTIVE", plugin: { key: "vn.zsoft.plugin.zai" } }),
        }),
      );
    });
  });

  describe("renderContributionsFor", () => {
    it("projects public integration data and keeps credentials out of the payload", async () => {
      holder.systemDb.sitePlugin.findMany.mockResolvedValue([
        {
          plugin: { key: "vn.zsoft.plugin.zai" },
          version: { version: "0.2.0", manifest: { capabilities: ["ai.assistant"] } },
          settings: {
            assistantName: "Help bot",
            welcomeMessage: "Hello",
            openaiApiKey: "must-not-leak",
          },
        },
      ]);

      const result = await makeService().renderContributionsFor("t1", "s1");

      expect(result.capabilities).toEqual(["ai.assistant"]);
      expect(result.integrations["ai.assistant"]).toEqual({
        capability: "ai.assistant",
        provider: { pluginKey: "vn.zsoft.plugin.zai", version: "0.2.0" },
        data: { name: "Help bot", welcomeMessage: "Hello" },
      });
      expect(JSON.stringify(result)).not.toContain("must-not-leak");
    });

    it("does not let an unrelated plugin impersonate a core-owned integration", async () => {
      holder.systemDb.sitePlugin.findMany.mockResolvedValue([
        {
          plugin: { key: "example.plugin.evil" },
          version: { version: "1.0.0", manifest: { capabilities: ["ai.assistant"] } },
          settings: { assistantName: "Impostor" },
        },
      ]);

      const result = await makeService().renderContributionsFor("t1", "s1");

      expect(result.capabilities).toEqual(["ai.assistant"]);
      expect(result.integrations).toEqual({});
    });
  });

  describe("dispatchAction", () => {
    it("does nothing and makes no runtime call when the site has no active plugins", async () => {
      await makeService().dispatchAction("t1", "s1", "content.published", {});

      expect(fetch).not.toHaveBeenCalled();
    });

    it("swallows a plugin failure so a publish is never held up by broken plugin code", async () => {
      // A publish is user-facing; a third-party plugin must react to the CMS, never
      // gate it. A rejected fetch here must not surface to the caller.
      holder.systemDb.sitePlugin.findMany.mockResolvedValue([activeRow()]);
      (fetch as any).mockRejectedValue(new Error("runtime down"));

      await expect(
        makeService().dispatchAction("t1", "s1", "content.published", {}),
      ).resolves.toBeUndefined();
    });
  });

  describe("applyFilter", () => {
    it("returns the input unchanged when no plugin is active", async () => {
      const out = await makeService().applyFilter("t1", "s1", "content.seo", { title: "x" }, {});

      expect(out).toEqual({ title: "x" });
    });

    it("threads the value through a plugin that returns a result", async () => {
      holder.systemDb.sitePlugin.findMany.mockResolvedValue([activeRow()]);
      (fetch as any).mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true, result: { title: "rewritten" } }),
      });

      const out = await makeService().applyFilter("t1", "s1", "content.seo", { title: "x" }, {});

      expect(out).toEqual({ title: "rewritten" });
    });

    it("passes the previous value through untouched when a plugin filter fails", async () => {
      // A broken SEO plugin degrades the SEO of a page; it never blanks it.
      holder.systemDb.sitePlugin.findMany.mockResolvedValue([activeRow()]);
      (fetch as any).mockRejectedValue(new Error("timeout"));

      const out = await makeService().applyFilter("t1", "s1", "content.seo", { title: "keep" }, {});

      expect(out).toEqual({ title: "keep" });
    });
  });

  describe("runJob", () => {
    it("refuses a job for a plugin that is not active on the site", async () => {
      holder.systemDb.sitePlugin.findMany.mockResolvedValue([]);

      const res = await makeService().runJob("t1", "s1", "ghost-plugin", "reindex", {});

      expect(res.ok).toBe(false);
      expect(fetch).not.toHaveBeenCalled();
    });

    it("verifies the site belongs to the tenant before dispatching", async () => {
      // execute() looks the site up scoped by tenantId; a site that is not this
      // tenant's is a not-found, not a dispatch.
      holder.systemDb.sitePlugin.findMany.mockResolvedValue([activeRow()]);
      holder.systemDb.site.findFirst.mockResolvedValue(null);

      await expect(
        makeService().runJob("t1", "s1", "zsoft-seo", "reindex", {}),
      ).rejects.toBeTruthy();

      const where = holder.systemDb.site.findFirst.mock.calls[0][0].where;
      expect(where.tenantId).toBe("t1");
      expect(where.id).toBe("s1");
    });

    it("mints a token carrying only the granted scopes", async () => {
      // The plugin runs under the GRANTED scopes, not the ones it requested.
      holder.systemDb.sitePlugin.findMany.mockResolvedValue([activeRow({ grantedPermissions: ["content:read"] })]);
      (fetch as any).mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });

      await makeService().runJob("t1", "s1", "zsoft-seo", "reindex", {});

      expect(tokens.mint.mock.calls[0][0].scopes).toEqual(["content:read"]);
      expect(tokens.mint.mock.calls[0][0].tid).toBe("t1");
    });
  });
});
