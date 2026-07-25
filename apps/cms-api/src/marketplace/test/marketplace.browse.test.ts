import { beforeEach, describe, expect, it, vi } from "vitest";

// getSystemDb returns whatever `dbState.db` a test wires up. browse() reads only
// theme/plugin findMany, so those are the only fakes each test needs.
const dbState = vi.hoisted(() => ({ db: {} as any }));
vi.mock("@zcmsorg/database", () => ({ getSystemDb: () => dbState.db }));

import { MarketplaceService, type RegistryPackage } from "../marketplace.module";

/**
 * The "Installed" badge on the marketplace page must mean this instance actually
 * HOLDS a servable bundle — the same condition `fetchBundle` enforces — not merely
 * that a `theme` row with the key exists.
 *
 * The regression it guards: a private marketplace theme (z-soft) was registered as
 * a BUILTIN row with `bundleUrl = null` by `seed-themes` from a gitignored directory
 * that never ships in the deployed image. The old browse() counted the bare row as
 * "installed", which hid the Install button — so the theme could never be pulled
 * from the marketplace and every site rendering it fell back to the default theme.
 */
function service(): MarketplaceService {
  const config = {
    get: (key: string) => (key === "MARKETPLACE_URL" ? "https://market.test" : undefined),
  } as never;
  // browse() touches neither of these.
  return new MarketplaceService(config, {} as never, {} as never);
}

function catalogue(over: Partial<RegistryPackage>): RegistryPackage {
  return {
    kind: "theme",
    key: "k",
    name: "n",
    description: null,
    author: "a",
    publisher: null,
    latestVersion: "1.0.0",
    versions: ["1.0.0"],
    permissions: [],
    screenshots: [],
    video: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

describe("MarketplaceService.browse", () => {
  let themeFindManyArgs: any;

  beforeEach(() => {
    themeFindManyArgs = undefined;
    dbState.db = {
      theme: {
        findMany: vi.fn(async (args: any) => {
          themeFindManyArgs = args;
          // Rows AS PRISMA WOULD RETURN THEM once the `bundleUrl: { not: null }`
          // filter is applied: aurora holds a real bundle; the z-soft builtin stub
          // has only a null-bundle version, so its `versions` comes back empty.
          return [
            { key: "vn.zsoft.theme.aurora", versions: [{ version: "1.1.0" }] },
            { key: "vn.zsoft.theme.zsoft", versions: [] },
          ];
        }),
      },
      plugin: { findMany: vi.fn(async () => []) },
    };

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify([
              catalogue({ key: "vn.zsoft.theme.aurora", latestVersion: "1.1.0" }),
              catalogue({ key: "vn.zsoft.theme.zsoft", latestVersion: "1.0.0" }),
            ]),
            { status: 200 },
          ),
      ),
    );
  });

  it("counts only versions that hold a bundle as installed", async () => {
    await service().browse("theme");
    expect(themeFindManyArgs.select.versions.where).toEqual({ bundleUrl: { not: null } });
  });

  it("marks a theme with a held bundle installed, and a bundle-less builtin stub NOT installed", async () => {
    const out = await service().browse("theme");

    const aurora = out.find((p) => p.key === "vn.zsoft.theme.aurora")!;
    expect(aurora.installed).toBe(true);
    expect(aurora.installedVersion).toBe("1.1.0");

    // The bug: this was `true`, which hid the Install button.
    const zsoft = out.find((p) => p.key === "vn.zsoft.theme.zsoft")!;
    expect(zsoft.installed).toBe(false);
    expect(zsoft.installedVersion).toBeNull();
  });
});
