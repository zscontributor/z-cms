import { createHash } from "node:crypto";
import fs from "node:fs";
import { Readable } from "node:stream";
import yauzl from "yauzl";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A backup is only worth anything if the parts it produces join back into a zip
 * someone can open. So these tests do exactly what the owner will do: run the
 * job, download every part, `cat` them together, and unzip the result — then
 * check the rows and the media bytes are the ones that went in. The mocked
 * bucket keeps what was uploaded, byte for byte, which is what makes the
 * round-trip possible without a real S3.
 */

const { systemDb, s3Send, bucket } = vi.hoisted(() => {
  const bucket = new Map<string, Buffer>();
  const table = () => ({ findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn().mockResolvedValue(null) });
  return {
    bucket,
    s3Send: vi.fn(),
    systemDb: {
      siteBackup: { findFirst: vi.fn(), update: vi.fn().mockResolvedValue({}), findMany: vi.fn(), delete: vi.fn() },
      site: { findFirst: vi.fn() },
      contentType: table(),
      content: table(),
      contentVersion: table(),
      taxonomy: table(),
      term: table(),
      contentTerm: table(),
      menu: table(),
      mediaFolder: table(),
      siteTheme: table(),
      sitePlugin: table(),
      pluginData: table(),
      membership: table(),
      siteMailSettings: table(),
      commerceSettings: table(),
      order: table(),
      auditLog: table(),
      media: table(),
    },
  };
});

vi.mock("@zcmsorg/database", () => ({ getSystemDb: () => systemDb }));

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
    PutObjectCommand: cmd("put"),
    GetObjectCommand: cmd("get"),
    CopyObjectCommand: cmd("copy"),
    DeleteObjectsCommand: cmd("deleteMany"),
    ListObjectsV2Command: cmd("list"),
  };
});

import { runBackupsExpire, runSiteBackup, runSitePurge } from "../site-backup";

/** A bucket that behaves: put stores the stream, get returns it, copy/delete/list do what they say. */
async function fakeS3(command: { __type: string; input: Record<string, unknown> }) {
  const { input } = command;
  switch (command.__type) {
    case "put": {
      const chunks: Buffer[] = [];
      for await (const c of input.Body as Readable) chunks.push(Buffer.from(c));
      bucket.set(input.Key as string, Buffer.concat(chunks));
      return {};
    }
    case "get": {
      const body = bucket.get(input.Key as string);
      if (!body) {
        const err = new Error("NoSuchKey") as Error & { name: string };
        err.name = "NoSuchKey";
        throw err;
      }
      return { Body: Readable.from([body]) };
    }
    case "copy": {
      const from = (input.CopySource as string).replace(/^[^/]+\//, "");
      bucket.set(input.Key as string, bucket.get(from)!);
      return {};
    }
    case "deleteMany": {
      for (const o of (input.Delete as { Objects: { Key: string }[] }).Objects) bucket.delete(o.Key);
      return {};
    }
    case "list": {
      const prefix = input.Prefix as string;
      return {
        Contents: [...bucket.keys()].filter((k) => k.startsWith(prefix)).map((Key) => ({ Key })),
        IsTruncated: false,
      };
    }
    default:
      throw new Error(`unexpected ${command.__type}`);
  }
}

const SITE = {
  id: "site-1",
  tenantId: "tenant-1",
  slug: "my-site",
  name: "My Site",
  settings: {},
  domains: [{ hostname: "example.com" }],
};

const BACKUP = {
  id: "backup-1",
  siteId: "site-1",
  tenantId: "tenant-1",
  status: "PENDING",
  filename: "my-site-20260915-1000.zip",
  partBytes: 64 * 1024,
};

/** What the owner does: the parts in order, concatenated. */
function joined(): Buffer {
  const keys = [...bucket.keys()].filter((k) => k.startsWith("backups/site-1/backup-1/")).sort();
  return Buffer.concat(keys.map((k) => bucket.get(k)!));
}

/** Unzips an in-memory archive into { name: bytes }. */
function unzip(buf: Buffer): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    const out = new Map<string, Buffer>();
    yauzl.fromBuffer(buf, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err);
      zip.on("entry", (entry) => {
        zip.openReadStream(entry, (e, stream) => {
          if (e || !stream) return reject(e);
          const chunks: Buffer[] = [];
          stream.on("data", (c: Buffer) => chunks.push(c));
          stream.on("end", () => {
            out.set(entry.fileName, Buffer.concat(chunks));
            zip.readEntry();
          });
        });
      });
      zip.on("end", () => resolve(out));
      zip.on("error", reject);
      zip.readEntry();
    });
  });
}

describe("runSiteBackup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    bucket.clear();
    vi.stubEnv("S3_BUCKET", "media-bucket");
    s3Send.mockImplementation(fakeS3);
    systemDb.siteBackup.findFirst.mockResolvedValue({ ...BACKUP });
    systemDb.site.findFirst.mockResolvedValue({ ...SITE });
    for (const t of Object.values(systemDb)) {
      if ("findMany" in t) (t.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      if ("findFirst" in t && t !== systemDb.siteBackup && t !== systemDb.site) {
        (t.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      }
    }
  });

  it("archives rows and media into parts that join back into one valid zip", async () => {
    const rows = Array.from({ length: 1200 }, (_, i) => ({
      id: `c${String(i).padStart(4, "0")}`,
      title: `Page ${i}`,
      createdAt: new Date("2026-01-01T00:00:00Z"),
      blocks: [{ type: "text", props: { html: "x".repeat(200) } }],
    }));
    // Page by cursor, as the job asks: take N after the cursor id.
    systemDb.content.findMany.mockImplementation(async (args: { take: number; cursor?: { id: string }; skip?: number }) => {
      const start = args.cursor ? rows.findIndex((r) => r.id === args.cursor!.id) + (args.skip ?? 0) : 0;
      return rows.slice(start, start + args.take);
    });

    // A media library bigger than one part, so the split is exercised.
    const image = Buffer.alloc(150 * 1024, 7);
    bucket.set("sites/site-1/a.png", image);
    bucket.set("sites/site-1/b.txt", Buffer.from("hello media"));
    const media = [
      { id: "m1", storageKey: "sites/site-1/a.png", size: image.length, filename: "a.png" },
      { id: "m2", storageKey: "sites/site-1/b.txt", size: 11, filename: "b.txt" },
      // A row whose object is gone: listed as missing, not fatal.
      { id: "m3", storageKey: "sites/site-1/gone.png", size: 5, filename: "gone.png" },
    ];
    systemDb.media.findMany.mockResolvedValue(media);

    const result = await runSiteBackup({ tenantId: "tenant-1", siteId: "site-1", backupId: "backup-1" });

    expect(result.parts).toBeGreaterThan(1);
    const keys = [...bucket.keys()].filter((k) => k.startsWith("backups/")).sort();
    expect(keys).toEqual(
      Array.from({ length: result.parts }, (_, i) => `backups/site-1/backup-1/${BACKUP.filename}.${String(i + 1).padStart(3, "0")}`),
    );

    // Every part but the last is exactly partBytes; the row's manifest agrees
    // with the bytes, checksum included.
    const ready = systemDb.siteBackup.update.mock.calls.map(([c]) => c.data).find((d) => d.status === "READY");
    expect(ready).toBeTruthy();
    const parts = ready!.parts as { index: number; storageKey: string; size: number; sha256: string }[];
    expect(parts.map((p) => p.storageKey)).toEqual(keys);
    for (const part of parts) {
      const bytes = bucket.get(part.storageKey)!;
      expect(bytes.length).toBe(part.size);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(part.sha256);
      if (part.index < parts.length) expect(part.size).toBe(BACKUP.partBytes);
    }
    expect(Number(ready!.totalBytes)).toBe(parts.reduce((n, p) => n + p.size, 0));

    // The owner's step: cat the parts, unzip, read.
    const files = await unzip(joined());
    expect([...files.keys()].sort()).toEqual(
      [
        "site.json",
        "manifest.json",
        "content-types.json",
        "contents.json",
        "content-versions.json",
        "taxonomies.json",
        "terms.json",
        "content-terms.json",
        "menus.json",
        "media-folders.json",
        "themes.json",
        "plugins.json",
        "plugin-data.json",
        "members.json",
        "orders.json",
        "audit-log.json",
        "media.json",
        "media/sites/site-1/a.png",
        "media/sites/site-1/b.txt",
      ].sort(),
    );

    const contents = JSON.parse(files.get("contents.json")!.toString());
    expect(contents).toHaveLength(1200);
    expect(contents[0]).toMatchObject({ id: "c0000", createdAt: "2026-01-01T00:00:00.000Z" });
    expect(contents[1199].id).toBe("c1199");

    expect(files.get("media/sites/site-1/a.png")!.equals(image)).toBe(true);
    expect(files.get("media/sites/site-1/b.txt")!.toString()).toBe("hello media");

    const manifest = JSON.parse(files.get("manifest.json")!.toString());
    expect(manifest.format).toBe(1);
    expect(manifest.site).toMatchObject({ id: "site-1", slug: "my-site" });
    expect(manifest.counts).toMatchObject({ contents: 1200, media: 3, "media-missing": 1 });
    expect(manifest.mediaBytes).toBe(image.length + 11);

    const site = JSON.parse(files.get("site.json")!.toString());
    expect(site.domains).toEqual([{ hostname: "example.com" }]);
  });

  it("names a single-part archive plainly, with nothing to join", async () => {
    const result = await runSiteBackup({ tenantId: "tenant-1", siteId: "site-1", backupId: "backup-1" });
    expect(result.parts).toBe(1);
    expect([...bucket.keys()]).toEqual([`backups/site-1/backup-1/${BACKUP.filename}`]);

    const files = await unzip(joined());
    expect(files.has("manifest.json")).toBe(true);

    const ready = systemDb.siteBackup.update.mock.calls.map(([c]) => c.data).find((d) => d.status === "READY");
    expect((ready!.parts as { storageKey: string }[])[0]!.storageKey).toBe(
      `backups/site-1/backup-1/${BACKUP.filename}`,
    );
  });

  it("leaves the SMTP password out of the archive", async () => {
    systemDb.siteMailSettings.findFirst.mockResolvedValue({
      id: "mail-1",
      host: "smtp.example.com",
      username: "user",
      passwordEncrypted: "v1.secret",
    });
    await runSiteBackup({ tenantId: "tenant-1", siteId: "site-1", backupId: "backup-1" });
    const files = await unzip(joined());
    const mail = JSON.parse(files.get("mail-settings.json")!.toString());
    expect(mail.host).toBe("smtp.example.com");
    expect(mail).not.toHaveProperty("passwordEncrypted");
    expect(joined().includes("v1.secret")).toBe(false);
  });

  it("marks the row FAILED and clears half-written parts when the bucket read fails", async () => {
    systemDb.media.findMany.mockResolvedValue([
      { id: "m1", storageKey: "sites/site-1/a.png", size: 1, filename: "a.png" },
    ]);
    s3Send.mockImplementation(async (command: { __type: string; input: Record<string, unknown> }) => {
      if (command.__type === "get") throw new Error("bucket on fire");
      return fakeS3(command);
    });

    await expect(
      runSiteBackup({ tenantId: "tenant-1", siteId: "site-1", backupId: "backup-1" }),
    ).rejects.toThrow("bucket on fire");

    const failed = systemDb.siteBackup.update.mock.calls.map(([c]) => c.data).find((d) => d.status === "FAILED");
    expect(failed?.error).toBe("bucket on fire");
    expect([...bucket.keys()].filter((k) => k.startsWith("backups/"))).toEqual([]);
  });

  it("throws when the row is not there yet, so the queue retries after the commit", async () => {
    systemDb.siteBackup.findFirst.mockResolvedValue(null);
    await expect(
      runSiteBackup({ tenantId: "tenant-1", siteId: "site-1", backupId: "backup-1" }),
    ).rejects.toThrow(/not found/);
    expect(systemDb.siteBackup.update).not.toHaveBeenCalled();
  });

  it("scopes every read to the tenant in the job, not just the site", async () => {
    await runSiteBackup({ tenantId: "tenant-1", siteId: "site-1", backupId: "backup-1" });
    expect(systemDb.site.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "site-1", tenantId: "tenant-1" } }),
    );
    expect(systemDb.content.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: "tenant-1", siteId: "site-1" } }),
    );
    expect(systemDb.media.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: "tenant-1", siteId: "site-1" } }),
    );
  });

  it("leaves no temp files behind", async () => {
    const before = fs.readdirSync(require("node:os").tmpdir()).filter((n) => n.startsWith("zcms-backup-"));
    await runSiteBackup({ tenantId: "tenant-1", siteId: "site-1", backupId: "backup-1" });
    const after = fs.readdirSync(require("node:os").tmpdir()).filter((n) => n.startsWith("zcms-backup-"));
    expect(after.length).toBeLessThanOrEqual(before.length);
  });
});

describe("runSitePurge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    bucket.clear();
    vi.stubEnv("S3_BUCKET", "media-bucket");
    s3Send.mockImplementation(fakeS3);
  });

  it("removes the site's media, sitemap and backups, and nothing else", async () => {
    systemDb.site.findFirst.mockResolvedValue(null);
    bucket.set("sites/site-1/a.png", Buffer.from("a"));
    bucket.set("sites/site-1/sitemap.xml", Buffer.from("<x/>"));
    bucket.set("backups/site-1/b1/x.zip", Buffer.from("z"));
    bucket.set("sites/site-2/keep.png", Buffer.from("k"));
    bucket.set("backups/site-2/b2/keep.zip", Buffer.from("k"));

    const result = await runSitePurge({ tenantId: "tenant-1", siteId: "site-1" });

    expect(result.deleted).toBe(3);
    expect([...bucket.keys()].sort()).toEqual(["backups/site-2/b2/keep.zip", "sites/site-2/keep.png"]);
  });

  it("touches nothing while the site still exists — the delete may have rolled back", async () => {
    systemDb.site.findFirst.mockResolvedValue({ id: "site-1" });
    bucket.set("sites/site-1/a.png", Buffer.from("a"));

    const result = await runSitePurge({ tenantId: "tenant-1", siteId: "site-1" });

    expect(result.deleted).toBe(0);
    expect(bucket.has("sites/site-1/a.png")).toBe(true);
  });
});

describe("runBackupsExpire", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    bucket.clear();
    vi.stubEnv("S3_BUCKET", "media-bucket");
    s3Send.mockImplementation(fakeS3);
  });

  it("deletes the objects of each expired backup before its row", async () => {
    systemDb.siteBackup.findMany.mockResolvedValue([{ id: "b1", siteId: "site-1" }]);
    systemDb.siteBackup.delete.mockResolvedValue({});
    bucket.set("backups/site-1/b1/x.zip.001", Buffer.from("1"));
    bucket.set("backups/site-1/b1/x.zip.002", Buffer.from("2"));
    bucket.set("backups/site-1/b2/y.zip", Buffer.from("y"));

    const result = await runBackupsExpire();

    expect(result.expired).toBe(1);
    expect([...bucket.keys()]).toEqual(["backups/site-1/b2/y.zip"]);
    expect(systemDb.siteBackup.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { expiresAt: { lt: expect.any(Date) } } }),
    );
    expect(systemDb.siteBackup.delete).toHaveBeenCalledWith({ where: { id: "b1" } });
  });
});
