import { beforeEach, describe, expect, it, vi } from "vitest";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import type { RequestActor } from "../../common/request-context";

const holder = vi.hoisted(() => ({ db: null as any, systemDb: null as any }));
vi.mock("@zcmsorg/database", () => ({
  db: () => holder.db,
  getSystemDb: () => holder.systemDb,
}));

import { OrgPluginsController } from "../org-plugins.controller";

function makeDb() {
  return {
    orgPlugin: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
    },
    site: { findMany: vi.fn().mockResolvedValue([{ id: "s1" }, { id: "s2" }]) },
  };
}

function makeSystemDb() {
  return {
    plugin: { findUnique: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
    pluginVersion: { findUnique: vi.fn() },
  };
}

const cache = { invalidateSite: vi.fn().mockResolvedValue(undefined) };
const audit = { record: vi.fn().mockResolvedValue(undefined) };
const plugins = { bustProvidedPermissions: vi.fn() };

function makeController() {
  return new OrgPluginsController(cache as any, audit as any, plugins as any);
}

const actor: RequestActor = {
  userId: "u1",
  tenantId: "t1",
  email: "a@x.com",
  role: "ADMIN",
  permissions: ["plugin:install"],
};

function pluginWith(permissions: string[], scope: "SITE" | "ORG" = "ORG") {
  return {
    id: "plugin-1",
    key: "acme-analytics",
    scope,
    versions: [{ id: "ver-1", permissions, manifest: {} }],
  };
}

describe("OrgPluginsController", () => {
  beforeEach(() => {
    holder.db = makeDb();
    holder.systemDb = makeSystemDb();
    cache.invalidateSite.mockClear();
  });

  describe("install", () => {
    it("refuses a SITE-scoped plugin at the organization tier", async () => {
      // The mirror of the per-site guard: a per-site plugin cannot be turned on for
      // a whole organization.
      holder.systemDb.plugin.findUnique.mockResolvedValue(
        pluginWith(["content:read"], "SITE"),
      );

      await expect(
        makeController().install(actor, "acme-analytics", { grantedPermissions: [] }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(holder.db.orgPlugin.create).not.toHaveBeenCalled();
    });

    it("rejects granting a permission the plugin never requested", async () => {
      holder.systemDb.plugin.findUnique.mockResolvedValue(pluginWith(["content:read"]));

      await expect(
        makeController().install(actor, "acme-analytics", {
          grantedPermissions: ["content:read", "content:update"],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(holder.db.orgPlugin.create).not.toHaveBeenCalled();
    });

    it("persists an org-tier install keyed by tenant, not site", async () => {
      holder.systemDb.plugin.findUnique.mockResolvedValue(
        pluginWith(["content:read", "content:update"]),
      );

      const res = await makeController().install(actor, "acme-analytics", {
        grantedPermissions: ["content:read"],
      });

      expect(res.granted).toEqual(["content:read"]);
      const data = holder.db.orgPlugin.create.mock.calls[0][0].data;
      expect(data.grantedPermissions).toEqual(["content:read"]);
      expect(data.tenantId).toBe("t1");
      expect(data).not.toHaveProperty("siteId");
    });
  });

  describe("activate", () => {
    it("flips the org install to ACTIVE and rolls every tenant site's cache", async () => {
      holder.systemDb.plugin.findUnique.mockResolvedValue({ id: "plugin-1", key: "acme-analytics" });
      holder.db.orgPlugin.findFirst.mockResolvedValue({
        id: "op1",
        pluginId: "plugin-1",
        versionId: "ver-1",
        grantedPermissions: ["content:read"],
        version: { version: "1.0.0", bundleUrl: null },
      });

      const res = await makeController().activate(actor, "acme-analytics");

      expect(res.ok).toBe(true);
      expect(holder.db.orgPlugin.update.mock.calls[0][0].data.status).toBe("ACTIVE");
      // Both of the tenant's sites had their render cache invalidated.
      expect(cache.invalidateSite).toHaveBeenCalledTimes(2);
      expect(cache.invalidateSite).toHaveBeenCalledWith("s1");
      expect(cache.invalidateSite).toHaveBeenCalledWith("s2");
    });

    it("404s when the plugin is not installed for the organization", async () => {
      holder.systemDb.plugin.findUnique.mockResolvedValue({ id: "plugin-1", key: "acme-analytics" });
      holder.db.orgPlugin.findFirst.mockResolvedValue(null);

      await expect(makeController().activate(actor, "acme-analytics")).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});
