import { beforeEach, describe, expect, it, vi } from "vitest";
import { installCorePlugins } from "./core-plugins";

/**
 * The contract a new site's plugins arrive under: present, but OFF and ungranted.
 *
 * Both halves are the decision, and each one is wrong without the other. Installed,
 * because zAI is part of what z-cms is and hiding it in a catalogue helps nobody.
 * INACTIVE with nothing granted, because the alternative is a site that boots with a
 * plugin holding `network:fetch` and the site's API keys, approved by no one.
 */

const plugin = { findMany: vi.fn() };
const sitePlugin = { findFirst: vi.fn(), create: vi.fn() };
const db = { plugin, sitePlugin } as never;

function core(key: string, versionId = "v1") {
  return {
    id: `p-${key}`,
    key,
    isCore: true,
    versions: [{ id: versionId, createdAt: new Date() }],
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  sitePlugin.findFirst.mockResolvedValue(null);
  sitePlugin.create.mockResolvedValue({});
});

describe("installCorePlugins", () => {
  it("installs a core plugin switched OFF, with nothing granted", async () => {
    plugin.findMany.mockResolvedValue([core("vn.zsoft.plugin.zai")]);

    const installed = await installCorePlugins(db, "t1", "s1");

    expect(installed).toEqual(["vn.zsoft.plugin.zai"]);
    expect(sitePlugin.create).toHaveBeenCalledWith({
      data: {
        tenantId: "t1",
        siteId: "s1",
        pluginId: "p-vn.zsoft.plugin.zai",
        versionId: "v1",
        // The two that matter. A plugin nobody approved does not run, and until an
        // admin grants a scope the gateway refuses every scoped method it tries.
        status: "INACTIVE",
        grantedPermissions: [],
        settings: {},
      },
    });
  });

  it("only ever touches core plugins", async () => {
    // A marketplace plugin does not get installed on every new site by existing.
    plugin.findMany.mockResolvedValue([]);
    await installCorePlugins(db, "t1", "s1");
    expect(plugin.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { isCore: true } }),
    );
  });

  it("leaves an existing install alone — including one an admin already granted", async () => {
    // Idempotence, and it is a security property rather than a convenience: re-running
    // the seed must never reset a site's grants back to none, and must never switch a
    // plugin the admin turned on back off.
    plugin.findMany.mockResolvedValue([core("vn.zsoft.plugin.zai")]);
    sitePlugin.findFirst.mockResolvedValue({
      id: "existing",
      status: "ACTIVE",
      grantedPermissions: ["network:fetch"],
    });

    const installed = await installCorePlugins(db, "t1", "s1");

    expect(installed).toEqual([]);
    expect(sitePlugin.create).not.toHaveBeenCalled();
  });

  it("skips a core plugin with no published version rather than failing the site", async () => {
    // A broken seed is not a reason someone cannot create a site.
    plugin.findMany.mockResolvedValue([
      { id: "p-x", key: "vn.zsoft.plugin.x", isCore: true, versions: [] },
    ]);

    await expect(installCorePlugins(db, "t1", "s1")).resolves.toEqual([]);
    expect(sitePlugin.create).not.toHaveBeenCalled();
  });
});
