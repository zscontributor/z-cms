import { beforeEach, describe, expect, it, vi } from "vitest";
import { ForbiddenException, NotFoundException } from "@nestjs/common";

const holder = vi.hoisted(() => ({ systemDb: null as any }));
vi.mock("@zcmsorg/database", () => ({
  getSystemDb: () => holder.systemDb,
}));

import { SideloadService } from "../sideload.module";

const actor = { userId: "u1", tenantId: "t1", email: "a@b.c", role: "OWNER", permissions: [] } as any;

const config = {
  get: (_k: string) => undefined,
  getOrThrow: (k: string) =>
    ({
      S3_BUCKET: "bucket",
      S3_ENDPOINT: "http://s3",
      S3_ACCESS_KEY: "ak",
      S3_SECRET_KEY: "sk",
    })[k] ?? "x",
};

/** A PackagesService stub: only applyRevocation/purgeRuntimes are reused by removeSideload. */
const packages = {
  applyRevocation: vi.fn().mockResolvedValue(0),
  purgeRuntimes: vi.fn().mockResolvedValue(undefined),
} as any;

function makeService() {
  return new SideloadService(config as any, packages);
}

beforeEach(() => {
  holder.systemDb = null;
  packages.applyRevocation.mockClear();
});

describe("SideloadService.approveSideload", () => {
  it("refuses to approve a version that is not a sideload", async () => {
    // The whole point of the origin guard: a MARKETPLACE (or built-in) version can
    // never be flipped to APPROVED through the sideload door, whatever key is passed.
    holder.systemDb = {
      themeVersion: {
        findFirst: vi.fn().mockResolvedValue({
          id: "v1",
          themeId: "t1",
          origin: "MARKETPLACE",
          bundleUrl: "packages/theme/x/1.0.0.zcms",
        }),
        update: vi.fn(),
      },
      auditLog: { create: vi.fn() },
    };

    await expect(
      makeService().approveSideload(actor, "theme", "vn.zsoft.theme.aurora", "1.0.0"),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(holder.systemDb.themeVersion.update).not.toHaveBeenCalled();
  });

  it("404s when there is no such version", async () => {
    holder.systemDb = {
      pluginVersion: { findFirst: vi.fn().mockResolvedValue(null), update: vi.fn() },
      auditLog: { create: vi.fn() },
    };

    await expect(
      makeService().approveSideload(actor, "plugin", "acme.plugin.x", "1.0.0"),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("approves a genuine sideload", async () => {
    holder.systemDb = {
      themeVersion: {
        findFirst: vi.fn().mockResolvedValue({
          id: "v1",
          themeId: "t1",
          origin: "SIDELOAD",
          bundleUrl: "packages/theme/x/1.0.0.zcms",
        }),
        update: vi.fn().mockResolvedValue({}),
      },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    };

    const res = await makeService().approveSideload(actor, "theme", "acme.theme.x", "1.0.0");

    expect(res).toEqual({ ok: true });
    expect(holder.systemDb.themeVersion.update).toHaveBeenCalledWith({
      where: { id: "v1" },
      data: { reviewStatus: "APPROVED" },
    });
  });
});

describe("SideloadService.removeSideload", () => {
  it("refuses to remove anything that is not a sideload — never touches marketplace code", async () => {
    holder.systemDb = {
      pluginVersion: {
        findFirst: vi.fn().mockResolvedValue({
          id: "v1",
          pluginId: "p1",
          origin: "MARKETPLACE",
          bundleUrl: "packages/plugin/x/1.0.0.zcms",
        }),
        delete: vi.fn(),
      },
      sitePlugin: { deleteMany: vi.fn() },
      auditLog: { create: vi.fn() },
    };

    await expect(
      makeService().removeSideload(actor, "plugin", "vn.zsoft.plugin.seo", "1.0.0"),
    ).rejects.toBeInstanceOf(ForbiddenException);

    // The kill switch must not have run against a package this endpoint may not remove.
    expect(packages.applyRevocation).not.toHaveBeenCalled();
    expect(holder.systemDb.pluginVersion.delete).not.toHaveBeenCalled();
  });
});
