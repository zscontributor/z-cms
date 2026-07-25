import { beforeEach, describe, expect, it, vi } from "vitest";
import { Logger } from "@nestjs/common";

// getSystemDb returns whatever `dbState.db` a test sets — the ensureBucket tests
// never touch it, the install tests wire up theme/themeVersion fakes.
const dbState = vi.hoisted(() => ({ db: {} as any }));
vi.mock("@zcmsorg/database", () => ({ getSystemDb: () => dbState.db }));

// The scanner and package modules are otherwise left real (openapi/registry imports
// named exports from them, so a bare replacement breaks the import graph). Only the
// two entry points install() drives are overridden, via importOriginal.
const pkgState = vi.hoisted(() => ({ openPackage: null as any, verifyPackage: null as any }));
vi.mock("@zcmsorg/package", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  openPackage: (...a: any[]) => pkgState.openPackage(...a),
  verifyPackage: (...a: any[]) => pkgState.verifyPackage(...a),
}));
const scanState = vi.hoisted(() => ({ scanPackage: null as any }));
vi.mock("@zcmsorg/scanner", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  scanPackage: (...a: any[]) => scanState.scanPackage(...a),
}));

// The S3 client is mocked: onModuleInit must decide whether to create the bucket
// from the commands it sends, and we assert on exactly those. Each command carries
// a `tag` so the single `send` mock can tell head from create.
const s3State = vi.hoisted(() => ({ send: null as any }));
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    send(...args: any[]) {
      return s3State.send(...args);
    }
  },
  HeadBucketCommand: class {
    input: any;
    tag = "Head";
    constructor(input: any) {
      this.input = input;
    }
  },
  CreateBucketCommand: class {
    input: any;
    tag = "Create";
    constructor(input: any) {
      this.input = input;
    }
  },
  PutObjectCommand: class {
    input: any;
    tag = "Put";
    constructor(input: any) {
      this.input = input;
    }
  },
  GetObjectCommand: class {
    input: any;
    tag = "Get";
    constructor(input: any) {
      this.input = input;
    }
  },
}));

import { PackagesService } from "../packages.module";

const config = {
  getOrThrow: (k: string) =>
    ({
      S3_BUCKET: "bucket",
      S3_ENDPOINT: "https://s3.local",
      S3_ACCESS_KEY: "ak",
      S3_SECRET_KEY: "sk",
    })[k],
  get: (k: string) =>
    ({ S3_REGION: "us-east-1", MARKETPLACE_PUBLIC_KEY: "PINNED-KEY" })[k],
};

function makeService() {
  return new PackagesService(config as any, {} as any);
}

/** Every command the service sent whose `tag` matches. */
function sent(tag: string) {
  return s3State.send.mock.calls.filter((c: any[]) => c[0]?.tag === tag);
}

function s3Error(name: string, status?: number) {
  const err: any = new Error(name);
  err.name = name;
  if (status) err.$metadata = { httpStatusCode: status };
  return err;
}

describe("PackagesService.ensureBucket (onModuleInit)", () => {
  beforeEach(() => {
    // Keep the boot-time log/warn out of the test output.
    vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
  });

  it("creates the bucket when the object store reports it missing", async () => {
    s3State.send = vi.fn(async (cmd: any) => {
      if (cmd.tag === "Head") throw s3Error("NotFound", 404);
      return {};
    });

    await makeService().onModuleInit();

    const creates = sent("Create");
    expect(creates).toHaveLength(1);
    expect(creates[0][0].input.Bucket).toBe("bucket");
  });

  it("leaves an existing bucket untouched — no create", async () => {
    s3State.send = vi.fn(async () => ({})); // HeadBucket resolves: it is already there.

    await makeService().onModuleInit();

    expect(sent("Create")).toHaveLength(0);
  });

  it("does not try to create when the head fails for a reason other than 'missing'", async () => {
    // A 403 means the bucket exists but we cannot see it, or the endpoint is
    // misconfigured — creating cannot fix either, so leave it for the first write.
    s3State.send = vi.fn(async (cmd: any) => {
      if (cmd.tag === "Head") throw s3Error("Forbidden", 403);
      return {};
    });

    await expect(makeService().onModuleInit()).resolves.toBeUndefined();
    expect(sent("Create")).toHaveLength(0);
  });

  it("swallows the race where another replica already created the bucket", async () => {
    s3State.send = vi.fn(async (cmd: any) => {
      if (cmd.tag === "Head") throw s3Error("NotFound", 404);
      if (cmd.tag === "Create") throw s3Error("BucketAlreadyOwnedByYou");
      return {};
    });

    await expect(makeService().onModuleInit()).resolves.toBeUndefined();
  });

  it("never throws out of startup when the object store is unreachable", async () => {
    // Swarm gives no ordering guarantee: RustFS may still be booting. The API has
    // to come up regardless — the next real write will surface the problem.
    s3State.send = vi.fn(async () => {
      throw s3Error("TimeoutError");
    });

    await expect(makeService().onModuleInit()).resolves.toBeUndefined();
  });
});

const KEY = "vn.zsoft.theme.zsoft";

/** Wires up openPackage/verifyPackage/scanPackage and a themeVersion.upsert spy. */
function stubInstall(opts: {
  existingChecksum: string | null;
  bundleChecksum: string;
  /** Present => the existing row is a RELEASED (bundle-backed) version, not a BUILTIN stub. */
  existingBundleUrl?: string | null;
}) {
  const themeVersionUpsert = vi.fn().mockResolvedValue({});
  dbState.db = {
    theme: { upsert: vi.fn().mockResolvedValue({ id: "t1" }) },
    themeVersion: {
      findFirst: vi.fn().mockResolvedValue(
        opts.existingChecksum === null
          ? null
          : {
              id: "tv1",
              checksum: opts.existingChecksum,
              origin: opts.existingBundleUrl ? "MARKETPLACE" : "BUILTIN",
              bundleUrl: opts.existingBundleUrl ?? null,
            },
      ),
      upsert: themeVersionUpsert,
    },
  };
  pkgState.openPackage = vi.fn().mockResolvedValue({
    envelope: {
      manifest: { kind: "theme", id: KEY, version: "1.0.0", name: "Z-Soft", engine: ">=0.1.0" },
      checksum: opts.bundleChecksum,
      publisherSignature: "PS",
      marketplaceSignature: "MS",
    },
    payload: Buffer.from("payload"),
  });
  pkgState.verifyPackage = vi.fn(); // a no-op resolves = signature accepted
  scanState.scanPackage = vi.fn().mockResolvedValue({ verdict: "pass", findings: [] });
  s3State.send = vi.fn().mockResolvedValue({}); // Head + Put both succeed
  return themeVersionUpsert;
}

describe("PackagesService.installVerified — channel transition", () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
  });

  it("moves a BUILTIN version onto the marketplace channel on install (same bytes)", async () => {
    // The exact case that stranded z-soft: the row already exists as BUILTIN with a
    // matching checksum. An empty update would leave it pointing at the built-in
    // bundle the image no longer ships; it must flip to the marketplace channel.
    const upsert = stubInstall({ existingChecksum: "CHK", bundleChecksum: "CHK" });

    await makeService().installVerified(Buffer.from("bundle"), {
      kind: "theme",
      key: KEY,
      version: "1.0.0",
    });

    const call = upsert.mock.calls[0][0];
    expect(call.update.origin).toBe("MARKETPLACE");
    expect(call.update.bundleUrl).toBe(`packages/theme/${KEY}/1.0.0.zcms`);
    expect(call.update.marketplaceSignature).toBe("MS");
  });

  it("refuses a same-version reinstall whose bytes differ, for a RELEASED version (immutability)", async () => {
    // A bundle-backed version is a real release. Swapping its bytes under the same
    // version = a supply-chain swap. It must be rejected, not quietly transitioned.
    stubInstall({
      existingChecksum: "OLD",
      bundleChecksum: "NEW",
      existingBundleUrl: `packages/theme/${KEY}/1.0.0.zcms`,
    });

    await expect(
      makeService().installVerified(Buffer.from("bundle"), {
        kind: "theme",
        key: KEY,
        version: "1.0.0",
      }),
    ).rejects.toThrow();
  });

  it("promotes a BUILTIN stub whose bytes differ (a private theme seeded, then installed for real)", async () => {
    // The z-soft case: `seed-themes` registered a BUILTIN row from a local build, and
    // the marketplace holds a DIFFERENT build of the same version. The stub was never
    // released through the marketplace and nothing can run it (no bundle), so the
    // install must promote it — adopting the marketplace's authoritative checksum —
    // not reject it as if a released version were being swapped.
    const upsert = stubInstall({ existingChecksum: "LOCAL_SEED", bundleChecksum: "MARKETPLACE_REAL" });

    await makeService().installVerified(Buffer.from("bundle"), {
      kind: "theme",
      key: KEY,
      version: "1.0.0",
    });

    const call = upsert.mock.calls[0][0];
    expect(call.update.origin).toBe("MARKETPLACE");
    expect(call.update.bundleUrl).toBe(`packages/theme/${KEY}/1.0.0.zcms`);
    // Adopts the marketplace's content wholesale — the seed stub's bytes were never real.
    expect(call.update.checksum).toBe("MARKETPLACE_REAL");
  });
});

describe("PackagesService.advanceActiveThemeInstalls — update applies to the live site", () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
  });

  function makeServiceWithCache(cache: { invalidateSite: any }) {
    return new PackagesService(config as any, cache as any);
  }

  it("re-points ACTIVE installs (this tenant) to the new version and drops their caches", async () => {
    const siteThemeUpdate = vi.fn().mockResolvedValue({});
    const findMany = vi.fn().mockResolvedValue([
      { id: "st1", siteId: "site-1" },
      { id: "st2", siteId: "site-2" },
    ]);
    dbState.db = {
      themeVersion: { findFirst: vi.fn().mockResolvedValue({ id: "tvNEW" }) },
      siteTheme: { findMany, update: siteThemeUpdate },
    };
    const invalidateSite = vi.fn().mockResolvedValue(undefined);

    const applied = await makeServiceWithCache({ invalidateSite }).advanceActiveThemeInstalls(
      "tenant-1",
      KEY,
      "1.1.0",
    );

    expect(applied).toBe(2);
    // Only ACTIVE installs of THIS theme, THIS tenant, not already on the new version.
    expect(findMany.mock.calls[0][0].where).toMatchObject({
      tenantId: "tenant-1",
      status: "ACTIVE",
      theme: { key: KEY },
      NOT: { versionId: "tvNEW" },
    });
    // Each is moved onto the new version row and its render cache dropped.
    expect(siteThemeUpdate).toHaveBeenCalledWith({ where: { id: "st1" }, data: { versionId: "tvNEW" } });
    expect(siteThemeUpdate).toHaveBeenCalledWith({ where: { id: "st2" }, data: { versionId: "tvNEW" } });
    expect(invalidateSite).toHaveBeenCalledWith("site-1");
    expect(invalidateSite).toHaveBeenCalledWith("site-2");
  });

  it("is a no-op when the theme is not live anywhere (first-time install)", async () => {
    const siteThemeUpdate = vi.fn();
    dbState.db = {
      themeVersion: { findFirst: vi.fn().mockResolvedValue({ id: "tvNEW" }) },
      siteTheme: { findMany: vi.fn().mockResolvedValue([]), update: siteThemeUpdate },
    };
    const invalidateSite = vi.fn();

    const applied = await makeServiceWithCache({ invalidateSite }).advanceActiveThemeInstalls(
      "tenant-1",
      KEY,
      "1.1.0",
    );

    expect(applied).toBe(0);
    expect(siteThemeUpdate).not.toHaveBeenCalled();
    expect(invalidateSite).not.toHaveBeenCalled();
  });
});

describe("PackagesService.advanceActivePluginInstalls — plugin update applies to live sites", () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
  });

  function makeServiceWithCache(cache: { invalidateSite: any }) {
    return new PackagesService(config as any, cache as any);
  }

  const PKEY = "vn.zsoft.plugin.content-pack";

  it("re-points active site + org installs to the new version and drops caches", async () => {
    const sitePluginUpdate = vi.fn().mockResolvedValue({});
    const orgPluginUpdate = vi.fn().mockResolvedValue({});
    const invalidateSite = vi.fn().mockResolvedValue(undefined);
    dbState.db = {
      plugin: { findUnique: vi.fn().mockResolvedValue({ id: "p1" }) },
      pluginVersion: { findFirst: vi.fn().mockResolvedValue({ id: "pvNEW" }) },
      sitePlugin: {
        findMany: vi.fn().mockResolvedValue([{ id: "sp1", siteId: "site-1" }]),
        update: sitePluginUpdate,
      },
      orgPlugin: { findMany: vi.fn().mockResolvedValue([{ id: "op1" }]), update: orgPluginUpdate },
      // Org-wide plugin => every tenant site is stale.
      site: { findMany: vi.fn().mockResolvedValue([{ id: "site-1" }, { id: "site-2" }]) },
    };

    const applied = await makeServiceWithCache({ invalidateSite }).advanceActivePluginInstalls(
      "tenant-1",
      PKEY,
      "0.2.0",
    );

    expect(applied).toBe(2); // 1 site install + 1 org install
    expect(sitePluginUpdate).toHaveBeenCalledWith({ where: { id: "sp1" }, data: { versionId: "pvNEW" } });
    expect(orgPluginUpdate).toHaveBeenCalledWith({ where: { id: "op1" }, data: { versionId: "pvNEW" } });
    // site-1 (per-site) + site-1/site-2 (org-wide) => both sites, de-duplicated.
    expect(invalidateSite).toHaveBeenCalledWith("site-1");
    expect(invalidateSite).toHaveBeenCalledWith("site-2");
  });

  it("is a no-op when the plugin is not live anywhere", async () => {
    const sitePluginUpdate = vi.fn();
    const orgPluginUpdate = vi.fn();
    const invalidateSite = vi.fn();
    dbState.db = {
      plugin: { findUnique: vi.fn().mockResolvedValue({ id: "p1" }) },
      pluginVersion: { findFirst: vi.fn().mockResolvedValue({ id: "pvNEW" }) },
      sitePlugin: { findMany: vi.fn().mockResolvedValue([]), update: sitePluginUpdate },
      orgPlugin: { findMany: vi.fn().mockResolvedValue([]), update: orgPluginUpdate },
      site: { findMany: vi.fn() },
    };

    const applied = await makeServiceWithCache({ invalidateSite }).advanceActivePluginInstalls(
      "tenant-1",
      PKEY,
      "0.2.0",
    );

    expect(applied).toBe(0);
    expect(sitePluginUpdate).not.toHaveBeenCalled();
    expect(orgPluginUpdate).not.toHaveBeenCalled();
    expect(invalidateSite).not.toHaveBeenCalled();
  });
});
