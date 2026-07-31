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
      count: vi.fn().mockResolvedValue(0),
    },
    // The org tier is unioned into every active-plugin read; default to empty so a
    // test that only cares about site plugins is unaffected.
    orgPlugin: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
      count: vi.fn().mockResolvedValue(0),
    },
    plugin: { findUnique: vi.fn().mockResolvedValue(null) },
    site: { findFirst: vi.fn().mockResolvedValue({ id: "s1", name: "Main", defaultLocale: "en" }) },
    pluginData: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    $executeRawUnsafe: vi.fn().mockResolvedValue(0),
    // `to_regclass` — the existence probe purge runs before each DELETE. The
    // default is "the table is there", which is the normal case.
    $queryRawUnsafe: vi.fn().mockResolvedValue([{ oid: "p_vn_zsoft_testdb__notes" }]),
  };
}

/** A verified plugin owning one table, as plugin.findUnique returns it. */
function tableOwningPlugin(origin = "BUILTIN") {
  return {
    id: "plugin-1",
    key: "vn.zsoft.testdb",
    isCore: true,
    versions: [
      {
        origin,
        manifest: {
          database: {
            tables: [
              { name: "p_vn_zsoft_testdb__notes", columns: [{ name: "body", type: "text" }] },
            ],
          },
        },
      },
    ],
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

    it("unions in the capabilities of org-wide plugins", async () => {
      // A plugin the tenant activated org-wide contributes to every site, so its
      // capabilities must appear even when the site has no plugins of its own.
      holder.systemDb.sitePlugin.findMany.mockResolvedValue([]);
      holder.systemDb.orgPlugin.findMany.mockResolvedValue([
        { version: { manifest: { capabilities: ["analytics.track"] } } },
      ]);

      const caps = await makeService().capabilitiesFor("t1", "s1");

      expect(caps).toEqual(["analytics.track"]);
      // The org read is tenant-scoped and status-filtered, with no siteId.
      const where = holder.systemDb.orgPlugin.findMany.mock.calls[0][0].where;
      expect(where).toEqual({ tenantId: "t1", status: "ACTIVE" });
    });
  });

  describe("publicFormsFor", () => {
    const localizedForm = {
      id: "medical-appointment",
      title: { en: "Request an appointment", vi: "Yêu cầu đặt lịch" },
      submitLabel: { en: "Send", vi: "Gửi" },
      fields: [
        {
          name: "service",
          type: "select",
          required: true,
          label: { en: "Service", vi: "Dịch vụ" },
          options: [{ value: "general", label: { en: "General medicine", vi: "Nội tổng quát" } }],
        },
      ],
    };

    function activeWithForm() {
      holder.systemDb.sitePlugin.findMany.mockResolvedValue([
        activeRow({
          version: {
            version: "1.0.0",
            origin: "MARKETPLACE",
            manifest: { forms: [localizedForm] },
          },
        }),
      ]);
    }

    it("resolves a plugin's localized labels to the locale being rendered", async () => {
      activeWithForm();

      const forms = await makeService().publicFormsFor("t1", "s1", "vi");

      const form = forms["medical-appointment"]!;
      expect(form.title).toBe("Yêu cầu đặt lịch");
      expect(form.submitLabel).toBe("Gửi");
      expect(form.fields[0]?.label).toBe("Dịch vụ");
      // The value stays stable across languages; only the label is translated.
      expect(form.fields[0]?.options).toEqual([
        { value: "general", label: "Nội tổng quát" },
      ]);
    });

    it("falls back to English for a locale the plugin has no translation for", async () => {
      activeWithForm();

      const forms = await makeService().publicFormsFor("t1", "s1", "ja");

      expect(forms["medical-appointment"]?.title).toBe("Request an appointment");
    });
  });

  describe("aiAssistantFor", () => {
    it("returns only public presentation settings, never provider credentials", async () => {
      holder.systemDb.sitePlugin.findFirst.mockResolvedValue({
        settings: {
          assistantName: "Help bot",
          welcomeMessage: "Hello",
          openaiApiKey: "secret",
          openaiEnabled: true,
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

    it("does not expose assistant chrome until a provider is enabled and keyed", async () => {
      holder.systemDb.sitePlugin.findFirst.mockResolvedValue({
        settings: {
          assistantName: "Help bot",
          welcomeMessage: "Hello",
          openaiApiKey: "secret",
          openaiEnabled: false,
        },
      });
      await expect(makeService().aiAssistantFor("t1", "s1")).resolves.toBeUndefined();

      holder.systemDb.sitePlugin.findFirst.mockResolvedValue({
        settings: {
          assistantName: "Help bot",
          welcomeMessage: "Hello",
          openaiEnabled: true,
        },
      });
      await expect(makeService().aiAssistantFor("t1", "s1")).resolves.toBeUndefined();
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
            openaiEnabled: true,
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

    it("does not project the public AI integration until a provider is enabled and keyed", async () => {
      holder.systemDb.sitePlugin.findMany.mockResolvedValue([
        {
          plugin: { key: "vn.zsoft.plugin.zai" },
          version: { version: "0.3.0", manifest: { capabilities: ["ai.assistant"] } },
          settings: { assistantName: "Help bot", openaiEnabled: true },
        },
      ]);

      await expect(makeService().renderContributionsFor("t1", "s1"))
        .resolves.toEqual({ capabilities: ["ai.assistant"], integrations: {} });

      holder.systemDb.sitePlugin.findMany.mockResolvedValue([
        {
          plugin: { key: "vn.zsoft.plugin.zai" },
          version: { version: "0.3.0", manifest: { capabilities: ["ai.assistant"] } },
          settings: { assistantName: "Help bot", geminiEnabled: true, geminiApiKey: "configured" },
        },
      ]);

      await expect(makeService().renderContributionsFor("t1", "s1"))
        .resolves.toMatchObject({
          integrations: {
            "ai.assistant": {
              data: { name: "Help bot" },
            },
          },
        });
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

    it("runs a registered CORE projector without any plugin active, gated by the theme", async () => {
      holder.systemDb.sitePlugin.findMany.mockResolvedValue([]);
      const service = makeService();
      service.registerCapabilityProjector("commerce.checkout", {
        provider: { kind: "core", version: "1.0.0" },
        resolve: ({ themeCapabilities }) =>
          themeCapabilities.includes("commerce.checkout") ? { currency: "USD" } : null,
      });

      // Theme cannot render a storefront -> nothing is contributed.
      await expect(service.renderContributionsFor("t1", "s1", [])).resolves.toEqual({
        capabilities: [],
        integrations: {},
      });

      // Theme opts in -> the core capability is live and stamped "core".
      const opted = await service.renderContributionsFor("t1", "s1", ["commerce.checkout"]);
      expect(opted.capabilities).toEqual(["commerce.checkout"]);
      expect(opted.integrations["commerce.checkout"]).toEqual({
        capability: "commerce.checkout",
        provider: { pluginKey: "core", version: "1.0.0" },
        data: { currency: "USD" },
      });
    });
  });

  describe("purgePluginSiteData", () => {
    it("deletes only this site's rows from the plugin's own table", async () => {
      holder.systemDb.plugin.findUnique.mockResolvedValue(tableOwningPlugin());

      await makeService().purgePluginSiteData("t1", "s1", "vn.zsoft.testdb");

      const [sql, ...values] = holder.systemDb.$executeRawUnsafe.mock.calls[0]!;
      expect(sql).toContain('DELETE FROM "p_vn_zsoft_testdb__notes"');
      expect(values).toEqual(expect.arrayContaining(["t1", "s1"]));
    });

    it("skips a declared table that was never created, so uninstall still works", async () => {
      // How a site gets here: a new version declares a table and is installed over
      // a RUNNING plugin, so the DDL (which runs on activation) never ran. Before
      // this, `DELETE FROM <missing>` was a 42P01 the admin saw as "Internal server
      // error" — and uninstall is the way OUT of a broken install, so the one
      // action that could fix it was the one that could not run.
      holder.systemDb.plugin.findUnique.mockResolvedValue(tableOwningPlugin());
      holder.systemDb.$queryRawUnsafe.mockResolvedValue([{ oid: null }]);

      await expect(
        makeService().purgePluginSiteData("t1", "s1", "vn.zsoft.testdb"),
      ).resolves.toBeUndefined();

      expect(holder.systemDb.$executeRawUnsafe).not.toHaveBeenCalled();
    });
  });

  describe("dropPluginTablesIfUnused", () => {
    it("DROPS the table only when no site or org still holds the plugin", async () => {
      holder.systemDb.plugin.findUnique.mockResolvedValue(tableOwningPlugin());
      holder.systemDb.sitePlugin.count.mockResolvedValue(0);
      holder.systemDb.orgPlugin.count.mockResolvedValue(0);

      await makeService().dropPluginTablesIfUnused("vn.zsoft.testdb");

      const calls = holder.systemDb.$executeRawUnsafe.mock.calls.map((c: unknown[]) => c[0]);
      expect(calls.some((s: string) => s.includes('DROP TABLE IF EXISTS "p_vn_zsoft_testdb__notes"'))).toBe(true);
    });

    it("does NOT drop while another SITE still holds the plugin — no data nuked", async () => {
      // The guarantee: a shared table survives until the LAST install goes.
      holder.systemDb.plugin.findUnique.mockResolvedValue(tableOwningPlugin());
      holder.systemDb.sitePlugin.count.mockResolvedValue(1);
      holder.systemDb.orgPlugin.count.mockResolvedValue(0);

      await makeService().dropPluginTablesIfUnused("vn.zsoft.testdb");
      expect(holder.systemDb.$executeRawUnsafe).not.toHaveBeenCalled();
    });

    it("does NOT drop while an ORG install remains", async () => {
      holder.systemDb.plugin.findUnique.mockResolvedValue(tableOwningPlugin());
      holder.systemDb.sitePlugin.count.mockResolvedValue(0);
      holder.systemDb.orgPlugin.count.mockResolvedValue(1);

      await makeService().dropPluginTablesIfUnused("vn.zsoft.testdb");
      expect(holder.systemDb.$executeRawUnsafe).not.toHaveBeenCalled();
    });

    it("never drops for an unreviewed sideload", async () => {
      holder.systemDb.plugin.findUnique.mockResolvedValue(tableOwningPlugin("SIDELOAD"));
      await makeService().dropPluginTablesIfUnused("vn.zsoft.testdb");
      expect(holder.systemDb.$executeRawUnsafe).not.toHaveBeenCalled();
    });

    it("drops a reviewed marketplace plugin's table after its last install is removed", async () => {
      holder.systemDb.plugin.findUnique.mockResolvedValue(tableOwningPlugin("MARKETPLACE"));
      holder.systemDb.sitePlugin.count.mockResolvedValue(0);
      holder.systemDb.orgPlugin.count.mockResolvedValue(0);

      await makeService().dropPluginTablesIfUnused("vn.zsoft.testdb");

      expect(holder.systemDb.$executeRawUnsafe).toHaveBeenCalled();
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

    it("keeps the runtime error body when setup dispatch fails", async () => {
      holder.systemDb.sitePlugin.findFirst.mockResolvedValue(activeRow());
      (fetch as any).mockResolvedValue({
        ok: false,
        status: 404,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({ message: "No signed package found for plugin zsoft-seo." }),
      });

      await expect(makeService().runSetup("t1", "s1", "zsoft-seo")).rejects.toThrow(
        "plugin-runtime HTTP 404: No signed package found for plugin zsoft-seo.",
      );
    });

    it("fails activation when the plugin's own setup() throws in the sandbox", async () => {
      // The runtime answered 200 — the dispatch was fine — but the plugin's setup
      // handler threw (its ctx.db seeding was refused, say). That is a failed
      // activation, not a clean one: runSetup must raise it so the caller does not
      // flip the plugin ACTIVE having never finished setting up.
      holder.systemDb.sitePlugin.findFirst.mockResolvedValue(activeRow());
      (fetch as any).mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({ ok: false, error: "seed refused: tableNotOwned" }),
      });

      await expect(makeService().runSetup("t1", "s1", "zsoft-seo")).rejects.toThrow(
        /seed refused/,
      );
    });
  });

  describe("runTeardown", () => {
    it("returns — never raises — when the runtime answers a non-2xx", async () => {
      // Deactivation is best-effort by contract: the controller flips the plugin to
      // INACTIVE from a returned failure and does NOT wrap this in a try/catch. A
      // runtime that is down or returns an HTTP error must therefore come back as
      // { ok: false }, not throw — otherwise the deactivate 500s and the plugin is
      // stranded ACTIVE, unable to be turned off.
      holder.systemDb.sitePlugin.findFirst.mockResolvedValue(activeRow());
      (fetch as any).mockResolvedValue({
        ok: false,
        status: 503,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({ message: "runtime unavailable" }),
      });

      const res = await makeService().runTeardown("t1", "s1", "zsoft-seo");

      expect(res.ok).toBe(false);
      expect(res.error).toContain("plugin-runtime HTTP 503");
    });

    it("returns — never raises — when the fetch itself rejects", async () => {
      holder.systemDb.sitePlugin.findFirst.mockResolvedValue(activeRow());
      (fetch as any).mockRejectedValue(new Error("network down"));

      const res = await makeService().runTeardown("t1", "s1", "zsoft-seo");

      expect(res.ok).toBe(false);
      expect(res.error).toContain("network down");
    });

    it("passes a plugin's own teardown() failure straight through", async () => {
      // The runtime answered 200 but the handler threw — surfaced for the audit log.
      holder.systemDb.sitePlugin.findFirst.mockResolvedValue(activeRow());
      (fetch as any).mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({ ok: false, error: "teardown threw" }),
      });

      const res = await makeService().runTeardown("t1", "s1", "zsoft-seo");

      expect(res).toEqual({ ok: false, error: "teardown threw" });
    });
  });
});
