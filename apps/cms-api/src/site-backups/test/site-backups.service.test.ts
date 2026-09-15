import { ConflictException, NotFoundException } from "@nestjs/common";
import { PassThrough, Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The backup row is the admin's window onto a job it cannot see. These tests
 * pin what the API promises about that row — one in flight per site, storage
 * keys never leaving the server, the download answering with the headers a
 * resumable client needs — and the scoping that keeps one tenant's archive out
 * of another's reach.
 */

const site = { findUnique: vi.fn() };
const siteBackup = { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), delete: vi.fn() };

vi.mock("@zcmsorg/database", () => ({ db: () => ({ site, siteBackup }) }));

const s3Send = vi.fn();
vi.mock("@aws-sdk/client-s3", () => {
  const cmd = (type: string) =>
    class {
      __type = type;
      constructor(public input: Record<string, unknown>) {}
    };
  return {
    S3Client: class {
      send = s3Send;
    },
    GetObjectCommand: cmd("get"),
    DeleteObjectsCommand: cmd("deleteMany"),
    ListObjectsV2Command: cmd("list"),
  };
});

import { SiteBackupsService, toSiteBackupDto } from "../site-backups.module";
import type { RequestActor } from "../../common/request-context";

const config = {
  get: vi.fn((key: string) => (key === "SITE_BACKUP_PART_MB" ? "64" : undefined)),
  getOrThrow: vi.fn((key: string) => `${key}-value`),
};
const queue = { enqueue: vi.fn().mockResolvedValue(undefined) };
const audit = { record: vi.fn().mockResolvedValue(undefined) };

function service() {
  return new SiteBackupsService(config as never, queue as never, audit as never);
}

const actor: RequestActor = {
  userId: "u1",
  tenantId: "t1",
  email: "a@x.com",
  role: "OWNER",
  permissions: [],
  siteId: "s1",
};

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "b1",
    tenantId: "t1",
    siteId: "s1",
    status: "READY",
    filename: "acme-20260915-1000.zip",
    partBytes: 64 * 1024 * 1024,
    totalBytes: BigInt(100),
    parts: [
      { index: 1, storageKey: "backups/s1/b1/acme-20260915-1000.zip.001", size: 60, sha256: "aa" },
      { index: 2, storageKey: "backups/s1/b1/acme-20260915-1000.zip.002", size: 40, sha256: "bb" },
    ],
    summary: { counts: { contents: 5, media: 2 }, mediaBytes: 90 },
    error: null,
    createdById: "u1",
    createdAt: new Date("2026-09-15T10:00:00Z"),
    startedAt: new Date("2026-09-15T10:00:01Z"),
    finishedAt: new Date("2026-09-15T10:00:30Z"),
    expiresAt: new Date("2026-09-22T10:00:00Z"),
    ...overrides,
  };
}

/** An express Response stand-in that records headers and what was piped into it. */
function fakeResponse() {
  const res = new PassThrough() as PassThrough & {
    headers: Record<string, string>;
    statusCode: number;
    status: (code: number) => unknown;
    setHeader: (name: string, value: string) => void;
  };
  res.headers = {};
  res.statusCode = 200;
  res.status = (code: number) => {
    res.statusCode = code;
    return res;
  };
  res.setHeader = (name: string, value: string) => {
    res.headers[name] = value;
  };
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  site.findUnique.mockResolvedValue({ id: "s1", slug: "acme" });
  siteBackup.findFirst.mockResolvedValue(null);
  siteBackup.findMany.mockResolvedValue([]);
});

describe("toSiteBackupDto", () => {
  it("exposes part file names and sizes, never the storage keys", () => {
    const dto = toSiteBackupDto(row() as never);

    expect(dto.parts).toEqual([
      { index: 1, filename: "acme-20260915-1000.zip.001", size: 60, sha256: "aa" },
      { index: 2, filename: "acme-20260915-1000.zip.002", size: 40, sha256: "bb" },
    ]);
    expect(JSON.stringify(dto)).not.toContain("backups/s1");
    expect(dto.totalBytes).toBe(100);
    expect(dto.summary).toEqual({ counts: { contents: 5, media: 2 }, mediaBytes: 90 });
    expect(dto.createdAt).toBe("2026-09-15T10:00:00.000Z");
  });

  it("hides the summary and reports null size until the archive is built", () => {
    const dto = toSiteBackupDto(row({ status: "PENDING", totalBytes: null, parts: [], summary: {} }) as never);
    expect(dto.summary).toBeNull();
    expect(dto.totalBytes).toBeNull();
    expect(dto.parts).toEqual([]);
  });
});

describe("create", () => {
  it("creates a PENDING row sized from the environment and queues the build after a short delay", async () => {
    siteBackup.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      row({ ...data, id: "b9", status: "PENDING", parts: [], totalBytes: null, summary: {} }),
    );

    const dto = await service().create(actor, "s1");

    expect(dto.id).toBe("b9");
    expect(dto.status).toBe("PENDING");
    const [{ data }] = siteBackup.create.mock.calls[0]!;
    expect(data).toMatchObject({
      tenantId: "t1",
      siteId: "s1",
      createdById: "u1",
      partBytes: 64 * 1024 * 1024,
    });
    expect(data.filename).toMatch(/^acme-\d{8}-\d{4}\.zip$/);
    // Seven days, give or take the test's own clock.
    expect(data.expiresAt.getTime() - Date.now()).toBeGreaterThan(6.9 * 86_400_000);

    expect(queue.enqueue).toHaveBeenCalledWith(
      "site.backup",
      { tenantId: "t1", siteId: "s1", backupId: "b9" },
      expect.objectContaining({ jobId: "site.backup:b9", delayMs: expect.any(Number) }),
    );
    expect(audit.record).toHaveBeenCalledWith(actor, "site.backup.requested", "site", "s1", {
      backupId: "b9",
    });
  });

  it("refuses a second backup while one is queued or building", async () => {
    siteBackup.findFirst.mockResolvedValue({ id: "b1" });

    await expect(service().create(actor, "s1")).rejects.toBeInstanceOf(ConflictException);
    expect(siteBackup.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { siteId: "s1", status: { in: ["PENDING", "RUNNING"] } } }),
    );
    expect(siteBackup.create).not.toHaveBeenCalled();
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it("404s a site outside the actor's membership without touching the database", async () => {
    const limited: RequestActor = { ...actor, siteIds: ["s2"] };

    await expect(service().create(limited, "s1")).rejects.toBeInstanceOf(NotFoundException);
    expect(site.findUnique).not.toHaveBeenCalled();
  });

  it("404s a site RLS cannot see", async () => {
    site.findUnique.mockResolvedValue(null);
    await expect(service().create(actor, "s1")).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe("list", () => {
  it("returns the site's backups newest first, as DTOs", async () => {
    siteBackup.findMany.mockResolvedValue([row(), row({ id: "b0", status: "FAILED", error: "boom" })]);

    const dtos = await service().list(actor, "s1");

    expect(dtos.map((d) => d.id)).toEqual(["b1", "b0"]);
    expect(dtos[1]!.error).toBe("boom");
    expect(siteBackup.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { siteId: "s1" }, orderBy: { createdAt: "desc" } }),
    );
  });
});

describe("download", () => {
  it("streams the part with attachment, length, checksum and resumable headers", async () => {
    siteBackup.findFirst.mockResolvedValue(row());
    s3Send.mockResolvedValue({ Body: Readable.from([Buffer.from("zipbytes")]), ContentLength: 8 });
    const res = fakeResponse();

    await service().download(actor, "s1", "b1", 2, undefined, res as never);

    const [command] = s3Send.mock.calls[0]!;
    expect(command.input).toEqual({
      Bucket: "S3_BUCKET-value",
      Key: "backups/s1/b1/acme-20260915-1000.zip.002",
      Range: undefined,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers).toMatchObject({
      "content-type": "application/octet-stream",
      "content-disposition": 'attachment; filename="acme-20260915-1000.zip.002"',
      "content-length": "8",
      "accept-ranges": "bytes",
      "x-part-sha256": "bb",
    });

    const chunks: Buffer[] = [];
    for await (const c of res) chunks.push(Buffer.from(c));
    expect(Buffer.concat(chunks).toString()).toBe("zipbytes");
  });

  it("forwards Range to the bucket and answers 206 with the range it got back", async () => {
    siteBackup.findFirst.mockResolvedValue(row());
    s3Send.mockResolvedValue({
      Body: Readable.from([Buffer.from("tes")]),
      ContentLength: 3,
      ContentRange: "bytes 5-7/8",
    });
    const res = fakeResponse();

    await service().download(actor, "s1", "b1", 1, "bytes=5-7", res as never);

    expect(s3Send.mock.calls[0]![0].input.Range).toBe("bytes=5-7");
    expect(res.statusCode).toBe(206);
    expect(res.headers["content-range"]).toBe("bytes 5-7/8");
  });

  it("404s a part that does not exist, and a backup that is not READY", async () => {
    siteBackup.findFirst.mockResolvedValue(row());
    await expect(service().download(actor, "s1", "b1", 3, undefined, fakeResponse() as never)).rejects.toBeInstanceOf(
      NotFoundException,
    );

    siteBackup.findFirst.mockResolvedValue(row({ status: "RUNNING" }));
    await expect(service().download(actor, "s1", "b1", 1, undefined, fakeResponse() as never)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(s3Send).not.toHaveBeenCalled();
  });

  it("cuts the response when the bucket stream fails mid-way", async () => {
    siteBackup.findFirst.mockResolvedValue(row());
    const body = new PassThrough();
    s3Send.mockResolvedValue({ Body: body, ContentLength: 100 });
    const res = fakeResponse();
    const destroyed = new Promise<Error>((resolve) => res.on("error", resolve));

    await service().download(actor, "s1", "b1", 1, undefined, res as never);
    body.destroy(new Error("bucket gone"));

    await expect(destroyed).resolves.toMatchObject({ message: "bucket gone" });
  });
});

describe("remove", () => {
  it("deletes every object under the backup's prefix, then the row", async () => {
    siteBackup.findFirst.mockResolvedValue(row());
    s3Send.mockImplementation(async (command: { __type: string }) =>
      command.__type === "list"
        ? { Contents: [{ Key: "backups/s1/b1/x.001" }, { Key: "backups/s1/b1/x.002" }], IsTruncated: false }
        : {},
    );

    await service().remove(actor, "s1", "b1");

    const types = s3Send.mock.calls.map(([c]) => c.__type);
    expect(types).toEqual(["list", "deleteMany"]);
    expect(s3Send.mock.calls[0]![0].input.Prefix).toBe("backups/s1/b1/");
    expect(s3Send.mock.calls[1]![0].input.Delete).toEqual({
      Objects: [{ Key: "backups/s1/b1/x.001" }, { Key: "backups/s1/b1/x.002" }],
    });
    expect(siteBackup.delete).toHaveBeenCalledWith({ where: { id: "b1" } });
    expect(audit.record).toHaveBeenCalledWith(actor, "site.backup.deleted", "site", "s1", { backupId: "b1" });
  });

  it("refuses to delete a backup that is still being built", async () => {
    siteBackup.findFirst.mockResolvedValue(row({ status: "RUNNING" }));

    await expect(service().remove(actor, "s1", "b1")).rejects.toBeInstanceOf(ConflictException);
    expect(s3Send).not.toHaveBeenCalled();
    expect(siteBackup.delete).not.toHaveBeenCalled();
  });

  it("404s a backup of another site", async () => {
    siteBackup.findFirst.mockResolvedValue(null);
    await expect(service().remove(actor, "s1", "b-foreign")).rejects.toBeInstanceOf(NotFoundException);
    expect(siteBackup.findFirst).toHaveBeenCalledWith({ where: { id: "b-foreign", siteId: "s1" } });
  });
});

