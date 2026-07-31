import { beforeEach, describe, expect, it, vi } from "vitest";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import type { RequestActor } from "../../common/request-context";

const holder = vi.hoisted(() => ({ db: null as any, systemDb: null as any }));
vi.mock("@zcmsorg/database", () => ({
  db: () => holder.db,
  getSystemDb: () => holder.systemDb,
}));

import { PluginsController } from "../plugins.controller";

function makeDb() {
  return {
    sitePlugin: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
    },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  };
}

function makeSystemDb() {
  return {
    plugin: { findUnique: vi.fn() },
    pluginVersion: { findUnique: vi.fn() },
  };
}

const plugins = {
  runSetup: vi.fn().mockResolvedValue(undefined),
  ensurePluginTables: vi.fn().mockResolvedValue(undefined),
  runTeardown: vi.fn().mockResolvedValue({ ok: true }),
  bustProvidedPermissions: vi.fn(),
};
const cache = { invalidateSite: vi.fn().mockResolvedValue(undefined) };
const audit = { record: vi.fn().mockResolvedValue(undefined) };

function makeController() {
  return new PluginsController(plugins as any, cache as any, audit as any);
}

const actor: RequestActor = {
  userId: "u1",
  tenantId: "t1",
  email: "a@x.com",
  role: "ADMIN",
  permissions: ["plugin:install"],
  siteId: "s1",
};

function pluginWith(permissions: string[], scope: "SITE" | "ORG" = "SITE") {
  return {
    id: "plugin-1",
    key: "zsoft-seo",
    scope,
    versions: [{ id: "ver-1", permissions, manifest: {} }],
  };
}

describe("PluginsController", () => {
  beforeEach(() => {
    holder.db = makeDb();
    holder.systemDb = makeSystemDb();
    plugins.runSetup.mockReset().mockResolvedValue(undefined);
    plugins.ensurePluginTables.mockReset().mockResolvedValue(undefined);
    plugins.bustProvidedPermissions.mockClear();
    cache.invalidateSite.mockClear();
  });

  describe("install", () => {
    it("404s a plugin that does not exist", async () => {
      holder.systemDb.plugin.findUnique.mockResolvedValue(null);

      await expect(
        makeController().install(actor, "s1", "ghost", { grantedPermissions: [] }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("rejects granting a permission the platform does not define", async () => {
      holder.systemDb.plugin.findUnique.mockResolvedValue(pluginWith(["content:read"]));

      await expect(
        makeController().install(actor, "s1", "zsoft-seo", {
          grantedPermissions: ["not:a:real:permission"],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(holder.db.sitePlugin.create).not.toHaveBeenCalled();
    });

    it("rejects granting a permission the plugin never requested", async () => {
      // A plugin's privileges must not grow behind its manifest's back — a
      // compromised admin UI cannot quietly hand it more than the user saw.
      holder.systemDb.plugin.findUnique.mockResolvedValue(pluginWith(["content:read"]));

      await expect(
        makeController().install(actor, "s1", "zsoft-seo", {
          grantedPermissions: ["content:read", "content:update"],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(holder.db.sitePlugin.create).not.toHaveBeenCalled();
    });

    it("refuses an ORG-scoped plugin at the per-site tier", async () => {
      // A plugin belongs to one tier. An org-wide plugin is installed on the
      // organization screen; installing it per-site too would give it two install
      // rows and two consent states for the same plugin.
      holder.systemDb.plugin.findUnique.mockResolvedValue(
        pluginWith(["content:read"], "ORG"),
      );

      await expect(
        makeController().install(actor, "s1", "zsoft-seo", { grantedPermissions: [] }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(holder.db.sitePlugin.create).not.toHaveBeenCalled();
    });

    it("persists a granted subset of what the plugin requested", async () => {
      // An admin may narrow the grant; a plugin granted only read will be refused
      // at the gateway the first time it tries to write.
      holder.systemDb.plugin.findUnique.mockResolvedValue(
        pluginWith(["content:read", "content:update"]),
      );

      const res = await makeController().install(actor, "s1", "zsoft-seo", {
        grantedPermissions: ["content:read"],
      });

      expect(res.granted).toEqual(["content:read"]);
      expect(holder.db.sitePlugin.create.mock.calls[0][0].data.grantedPermissions).toEqual([
        "content:read",
      ]);
      expect(holder.db.sitePlugin.create.mock.calls[0][0].data.siteId).toBe("s1");
    });

    /**
     * Upgrading a RUNNING plugin.
     *
     * The DDL and `setup()` run on activation, and nobody activates a plugin that
     * is already active — so before this, a new version's table simply never came
     * into being and the screen over it answered "no such thing". An upgrade that
     * installed cleanly and then did not work.
     */
    it("runs the new version's tables and setup when the plugin was already active", async () => {
      holder.systemDb.plugin.findUnique.mockResolvedValue(pluginWith(["content:read"]));
      holder.db.sitePlugin.findFirst.mockResolvedValue({
        id: "sp-1",
        status: "ACTIVE",
        versionId: "ver-0",
      });

      await makeController().install(actor, "s1", "zsoft-seo", {
        grantedPermissions: ["content:read"],
      });

      expect(plugins.ensurePluginTables).toHaveBeenCalledWith("zsoft-seo");
      expect(plugins.runSetup).toHaveBeenCalledWith("t1", "s1", "zsoft-seo");
      expect(holder.db.sitePlugin.update.mock.calls[0][0].data.versionId).toBe("ver-1");
      // A new version may declare new capabilities and new permissions, and both
      // are read from caches keyed on the ACTIVE manifest.
      expect(cache.invalidateSite).toHaveBeenCalledWith("s1");
      expect(plugins.bustProvidedPermissions).toHaveBeenCalledWith("t1");
    });

    it("leaves an inactive install alone — activation is still where it starts", async () => {
      holder.systemDb.plugin.findUnique.mockResolvedValue(pluginWith(["content:read"]));
      holder.db.sitePlugin.findFirst.mockResolvedValue({
        id: "sp-1",
        status: "INACTIVE",
        versionId: "ver-0",
      });

      await makeController().install(actor, "s1", "zsoft-seo", {
        grantedPermissions: ["content:read"],
      });

      expect(plugins.ensurePluginTables).not.toHaveBeenCalled();
      expect(plugins.runSetup).not.toHaveBeenCalled();
    });

    it("does not re-run anything when the installed version did not change", async () => {
      holder.systemDb.plugin.findUnique.mockResolvedValue(pluginWith(["content:read"]));
      // Re-consenting to the same version is a permission change, not an upgrade.
      holder.db.sitePlugin.findFirst.mockResolvedValue({
        id: "sp-1",
        status: "ACTIVE",
        versionId: "ver-1",
      });

      await makeController().install(actor, "s1", "zsoft-seo", {
        grantedPermissions: ["content:read"],
      });

      expect(plugins.ensurePluginTables).not.toHaveBeenCalled();
      expect(plugins.runSetup).not.toHaveBeenCalled();
    });

    it("marks the plugin FAILED and reports when the upgraded version cannot start", async () => {
      holder.systemDb.plugin.findUnique.mockResolvedValue(pluginWith(["content:read"]));
      holder.db.sitePlugin.findFirst.mockResolvedValue({
        id: "sp-1",
        status: "ACTIVE",
        versionId: "ver-0",
      });
      plugins.runSetup.mockRejectedValue(new Error("setup() blew up"));

      const res = await makeController().install(actor, "s1", "zsoft-seo", {
        grantedPermissions: ["content:read"],
      });

      // The version installed; it is the plugin that could not start on it. Saying
      // "ok" and nothing else would hide a broken plugin behind a clean upgrade.
      expect(res).toMatchObject({ ok: true, error: "setup() blew up" });
      const failed = holder.db.sitePlugin.update.mock.calls.at(-1)![0].data;
      expect(failed).toMatchObject({ status: "FAILED", lastError: "setup() blew up" });
    });
  });

  describe("activate", () => {
    it("only flips a plugin to ACTIVE after its setup runs cleanly", async () => {
      holder.systemDb.plugin.findUnique.mockResolvedValue({ id: "plugin-1", key: "zsoft-seo" });
      holder.db.sitePlugin.findFirst.mockResolvedValue({
        id: "sp1",
        pluginId: "plugin-1",
        versionId: "ver-1",
        settings: {},
        grantedPermissions: ["content:read"],
        version: { version: "1.0.0", origin: "BUILTIN" },
      });

      const res = await makeController().activate(actor, "s1", "zsoft-seo");

      expect(res.ok).toBe(true);
      expect(holder.db.sitePlugin.update.mock.calls[0][0].data.status).toBe("ACTIVE");
    });

    it("marks the plugin FAILED and returns ok:false when setup throws", async () => {
      // The reverse order — ACTIVE, then setup — would advertise a plugin whose
      // setup is about to fail. A plugin is active because it started, not before.
      holder.systemDb.plugin.findUnique.mockResolvedValue({ id: "plugin-1", key: "zsoft-seo" });
      holder.db.sitePlugin.findFirst.mockResolvedValue({
        id: "sp1",
        pluginId: "plugin-1",
        versionId: "ver-1",
        settings: {},
        grantedPermissions: [],
        version: { version: "1.0.0", origin: "BUILTIN" },
      });
      plugins.runSetup.mockRejectedValue(new Error("boom"));

      const res = await makeController().activate(actor, "s1", "zsoft-seo");

      expect(res.ok).toBe(false);
      expect(holder.db.sitePlugin.update.mock.calls[0][0].data.status).toBe("FAILED");
    });
  });

  describe("settings", () => {
    it("drops keys the plugin's schema does not declare before persisting", async () => {
      // The settings blob is written by an admin and read by plugin code inside the
      // sandbox — an injection surface. Undeclared keys must not survive.
      holder.systemDb.plugin.findUnique.mockResolvedValue({ id: "plugin-1", key: "zsoft-seo" });
      holder.db.sitePlugin.findFirst.mockResolvedValue({
        id: "sp1",
        pluginId: "plugin-1",
        versionId: "ver-1",
        version: { version: "1.0.0", origin: "BUILTIN" },
      });
      holder.systemDb.pluginVersion.findUnique.mockResolvedValue({
        manifest: { settingsSchema: { properties: { title: { type: "string" } } } },
      });

      await makeController().settings(actor, "s1", "zsoft-seo", {
        title: "SEO",
        __proto__pollution: "evil",
        unknownKey: "x",
      });

      const saved = holder.db.sitePlugin.update.mock.calls[0][0].data.settings;
      expect(saved).toEqual({ title: "SEO" });
    });
  });
});
