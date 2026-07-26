import { beforeEach, describe, expect, it, vi } from "vitest";
import { BadRequestException, ForbiddenException } from "@nestjs/common";

const holder = vi.hoisted(() => ({ db: null as any, sys: null as any }));
vi.mock("@zcmsorg/database", () => ({
  db: () => holder.db,
  // resolvePluginTable reads the installed manifest through the system client.
  getSystemDb: () => holder.sys,
  // withTenant binds the query to the token's tenant; we run the callback directly.
  withTenant: (_tid: string, fn: any) => fn({ db: holder.db }),
}));

import { PluginGatewayController } from "../plugin-gateway.controller";

function makeDb() {
  return {
    pluginData: {
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
      deleteMany: vi.fn().mockResolvedValue({}),
    },
    content: {
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
    },
    // The raw executors the db.* dispatch uses once a table has been resolved as
    // the plugin's own. A spy so a test can prove they were NEVER reached when the
    // table is refused.
    $queryRawUnsafe: vi.fn().mockResolvedValue([{ id: "row-1" }]),
    $executeRawUnsafe: vi.fn().mockResolvedValue(1),
  };
}

/**
 * The system client resolvePluginTable reads. By default it returns a first-party
 * install whose manifest owns exactly one table, `p_zsoft_seo__leads`. A test that
 * wants a community plugin or a different table set overrides it.
 */
function makeSys(over: { isCore?: boolean; tables?: unknown[] } = {}) {
  const install = {
    plugin: { isCore: over.isCore ?? true },
    version: {
      manifest: {
        database: {
          tables: over.tables ?? [
            { name: "p_zsoft_seo__leads", columns: [{ name: "email", type: "text" }] },
          ],
        },
      },
    },
  };
  return {
    sitePlugin: { findFirst: vi.fn().mockResolvedValue(install) },
    orgPlugin: { findFirst: vi.fn().mockResolvedValue(null) },
  };
}

const tokens = { verify: vi.fn(), mint: vi.fn() };
const queue = { enqueue: vi.fn().mockResolvedValue(undefined) };
const plugins = { runJob: vi.fn().mockResolvedValue({ ok: true }) };
const mail = { enqueue: vi.fn().mockResolvedValue({ queued: true }) };
const egress = { fetch: vi.fn().mockResolvedValue({ status: 200, headers: {}, body: "{}" }) };

function makeController() {
  return new PluginGatewayController(
    tokens as any,
    queue as any,
    plugins as any,
    mail as any,
    egress as any,
  );
}

/** A verified plugin token. `scopes` is what the admin granted at install. */
function claims(over: Record<string, unknown> = {}) {
  return {
    plg: "zsoft-seo",
    pid: "plugin-1",
    tid: "t1",
    sid: "s1",
    scopes: [],
    ...over,
  };
}

describe("PluginGatewayController", () => {
  beforeEach(() => {
    holder.db = makeDb();
    holder.sys = makeSys();
    tokens.verify.mockReset();
    queue.enqueue.mockClear();
    mail.enqueue.mockClear();
  });

  describe("call", () => {
    it("refuses a request that carries no plugin token", async () => {
      // @Public bypasses the user guard, not authentication — the token IS the
      // credential, so its absence is a hard refusal.
      await expect(
        makeController().call(undefined, { method: "storage.get", params: { key: "k" } }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("rejects a method that is not in the capability table", async () => {
      // The METHOD_SCOPES table IS the policy: a method absent from it does not
      // exist for plugins, so it cannot be a backdoor.
      tokens.verify.mockResolvedValue(claims());

      await expect(
        makeController().call("Bearer tok", { method: "users.delete", params: {} }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("refuses a scoped method the plugin was not granted", async () => {
      // The plugin asked for content:read but the admin never granted it. This is
      // the check that makes the consent screen mean something.
      tokens.verify.mockResolvedValue(claims({ scopes: [] }));

      await expect(
        makeController().call("Bearer tok", { method: "content.get", params: { contentId: "c1" } }),
      ).rejects.toBeInstanceOf(ForbiddenException);

      expect(holder.db.content.findFirst).not.toHaveBeenCalled();
    });

    it("allows a scoped method once the plugin holds the scope", async () => {
      tokens.verify.mockResolvedValue(claims({ scopes: ["content:read"] }));

      await makeController().call("Bearer tok", { method: "content.get", params: { contentId: "c1" } });

      expect(holder.db.content.findFirst).toHaveBeenCalledTimes(1);
    });

    it("scopes content reads to the site named in the token, not a body parameter", async () => {
      // A plugin cannot reach another site's content: the siteId comes from the
      // signed token, and the plugin has no parameter that can override it.
      tokens.verify.mockResolvedValue(claims({ sid: "s1", scopes: ["content:read"] }));

      await makeController().call("Bearer tok", {
        method: "content.get",
        params: { contentId: "c1", siteId: "victim-site" },
      });

      const where = holder.db.content.findFirst.mock.calls[0][0].where;
      expect(where.siteId).toBe("s1");
    });

    it("keys plugin storage by the token's site and plugin id, never by the params", async () => {
      // A plugin cannot read or write another plugin's namespace or another site's
      // data — it has no way to name a different sid/pid at all.
      tokens.verify.mockResolvedValue(claims({ sid: "s1", pid: "plugin-1" }));

      await makeController().call("Bearer tok", {
        method: "storage.get",
        params: { key: "settings", siteId: "victim", pluginId: "other-plugin" },
      });

      const where = holder.db.pluginData.findFirst.mock.calls[0][0].where;
      expect(where.siteId).toBe("s1");
      expect(where.pluginId).toBe("plugin-1");
    });

    it("caps a plugin's content.list page size regardless of what it asks for", async () => {
      // An unbounded perPage from plugin code would be a cheap way to pull the whole
      // table in one call; it is clamped to 50.
      tokens.verify.mockResolvedValue(claims({ scopes: ["content:read"] }));

      await makeController().call("Bearer tok", {
        method: "content.list",
        params: { query: { perPage: 100000 } },
      });

      expect(holder.db.content.findMany.mock.calls[0][0].take).toBe(50);
    });
  });

  describe("http.fetch", () => {
    it("refuses a plugin that was not granted network:fetch", async () => {
      // The scope gate, before any of the egress service's own rules get a say.
      // A plugin the admin never let near the internet does not reach it by
      // naming the method.
      tokens.verify.mockResolvedValue(claims({ scopes: ["content:read"] }));

      await expect(
        makeController().call("Bearer tok", {
          method: "http.fetch",
          params: { request: { url: "https://api.deepl.com/v2/translate" } },
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);

      expect(egress.fetch).not.toHaveBeenCalled();
    });

    it("hands the request to the egress service under the token's identity", async () => {
      // The controller passes the CLAIMS, not the params. Which site's settings the
      // secret comes out of, and which manifest's host list is enforced, are both
      // decided by the signed token — a plugin cannot borrow another plugin's
      // allowlist or another site's API key by forging a parameter, because those
      // ids are not parameters.
      const verified = claims({ tid: "t1", sid: "s1", plg: "zsoft-seo", scopes: ["network:fetch"] });
      tokens.verify.mockResolvedValue(verified);

      const result = await makeController().call("Bearer tok", {
        method: "http.fetch",
        params: {
          tenantId: "victim-tenant",
          siteId: "victim-site",
          request: { url: "https://api.deepl.com/v2/translate" },
        },
      });

      expect(egress.fetch).toHaveBeenCalledWith(
        expect.objectContaining({ tid: "t1", sid: "s1", plg: "zsoft-seo" }),
        expect.objectContaining({ request: { url: "https://api.deepl.com/v2/translate" } }),
      );
      expect(result).toEqual({ data: { status: 200, headers: {}, body: "{}" } });
    });
  });

  describe("mail.send", () => {
    it("refuses a plugin that was not granted mail:send", async () => {
      // The whole point of the scope. A plugin the admin never let near the mail
      // server does not get to reach it by naming the method.
      tokens.verify.mockResolvedValue(claims({ scopes: ["content:read"] }));

      await expect(
        makeController().call("Bearer tok", {
          method: "mail.send",
          params: { message: { to: "a@b.co", subject: "Hi", text: "Hi" } },
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);

      expect(mail.enqueue).not.toHaveBeenCalled();
    });

    it("queues the send once the plugin holds the scope", async () => {
      tokens.verify.mockResolvedValue(claims({ scopes: ["mail:send"] }));

      const result = await makeController().call("Bearer tok", {
        method: "mail.send",
        params: { message: { to: "a@b.co", subject: "Hi", text: "Hi" } },
      });

      expect(result).toEqual({ data: { queued: true } });
    });

    it("takes the tenant, site and sender from the token, never from the params", async () => {
      // A plugin that forges every parameter it can still cannot mail on another
      // site's behalf, or pin the blame for its mail on a different plugin: all
      // three identifiers are read off the signed token.
      tokens.verify.mockResolvedValue(
        claims({ tid: "t1", sid: "s1", plg: "zsoft-seo", scopes: ["mail:send"] }),
      );

      await makeController().call("Bearer tok", {
        method: "mail.send",
        params: {
          tenantId: "victim-tenant",
          siteId: "victim-site",
          pluginKey: "some-trusted-plugin",
          message: { to: "a@b.co", subject: "Hi", text: "Hi" },
        },
      });

      expect(mail.enqueue).toHaveBeenCalledWith("t1", "s1", "zsoft-seo", {
        to: "a@b.co",
        subject: "Hi",
        text: "Hi",
      });
    });
  });

  describe("runJob", () => {
    it("refuses a run-job request missing its identifying fields", async () => {
      await expect(
        makeController().runJob({ tenantId: "t1", siteId: "s1" }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("dispatches a well-formed job to the plugins service", async () => {
      await makeController().runJob({
        tenantId: "t1",
        siteId: "s1",
        pluginKey: "zsoft-seo",
        name: "reindex",
        payload: { a: 1 },
      });

      expect(plugins.runJob).toHaveBeenCalledWith("t1", "s1", "zsoft-seo", "reindex", { a: 1 });
    });
  });

  // The two guarantees a plugin's own tables rest on, exercised from the attacker's
  // side: it may reach ITS tables and no others, and it never sees a connection.
  describe("db.* — the plugin's own tables only", () => {
    const withDb = { scopes: ["data:own"] as string[] };

    it("REFUSES a write to a core table it does not own, and never runs SQL", async () => {
      // The land-grab: a plugin points db.insert at `content`. Its manifest does not
      // declare `content`, so resolvePluginTable refuses it before any SQL is built.
      tokens.verify.mockResolvedValue(claims(withDb));
      await expect(
        makeController().call("Bearer x", {
          method: "db.insert",
          params: { table: "content", row: { title: "hijacked" } },
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(holder.db.$queryRawUnsafe).not.toHaveBeenCalled();
      expect(holder.db.$executeRawUnsafe).not.toHaveBeenCalled();
    });

    it("REFUSES a write to another plugin's prefixed table", async () => {
      tokens.verify.mockResolvedValue(claims(withDb));
      await expect(
        makeController().call("Bearer x", {
          method: "db.update",
          params: { table: "p_other_plugin__secrets", patch: { x: 1 }, where: {} },
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(holder.db.$queryRawUnsafe).not.toHaveBeenCalled();
    });

    it("REFUSES db.* to a community (non-first-party) plugin, even for its own table", async () => {
      // Owning tables is a first-party privilege. Even declaring the table and
      // holding the scope, a non-isCore plugin is refused.
      holder.sys = makeSys({ isCore: false });
      tokens.verify.mockResolvedValue(claims(withDb));
      await expect(
        makeController().call("Bearer x", {
          method: "db.select",
          params: { table: "p_zsoft_seo__leads", options: {} },
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(holder.db.$queryRawUnsafe).not.toHaveBeenCalled();
    });

    it("REFUSES db.* without the data:own scope the admin must grant", async () => {
      // The scope gate in front of everything: no data:own, no tables at all.
      tokens.verify.mockResolvedValue(claims({ scopes: [] }));
      await expect(
        makeController().call("Bearer x", {
          method: "db.insert",
          params: { table: "p_zsoft_seo__leads", row: { email: "a@x.com" } },
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(holder.db.$queryRawUnsafe).not.toHaveBeenCalled();
    });

    it("allows a write to its OWN declared table, scoped to the token's tenant and site", async () => {
      tokens.verify.mockResolvedValue(claims(withDb));
      await makeController().call("Bearer x", {
        method: "db.insert",
        params: { table: "p_zsoft_seo__leads", row: { email: "a@x.com" } },
      });

      expect(holder.db.$queryRawUnsafe).toHaveBeenCalledTimes(1);
      const [sql, ...values] = holder.db.$queryRawUnsafe.mock.calls[0];
      expect(sql).toContain('INSERT INTO "p_zsoft_seo__leads"');
      // tenant/site come from the token (t1/s1), never from the plugin's params.
      expect(values.slice(0, 2)).toEqual(["t1", "s1"]);
      expect(values).toContain("a@x.com");
    });
  });
});
