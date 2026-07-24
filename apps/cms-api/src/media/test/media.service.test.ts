import { beforeEach, describe, expect, it, vi } from "vitest";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import type { RequestActor } from "../../common/request-context";

const holder = vi.hoisted(() => ({ db: null as any }));
vi.mock("@zcmsorg/database", () => ({
  db: () => holder.db,
}));

// The S3 client is mocked: an upload test must not reach a bucket, and we want to
// read back the exact Key the service derived — that key is the whole defence
// against path traversal and cross-tenant overwrites.
const s3State = vi.hoisted(() => ({ send: null as any }));
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    send(...args: any[]) {
      return s3State.send(...args);
    }
  },
  PutObjectCommand: class {
    input: any;
    constructor(input: any) {
      this.input = input;
    }
  },
}));

import { MediaService, MAX_UPLOAD_BYTES, ALLOWED_MIME } from "../media.service";

function makeDb() {
  return {
    media: {
      create: vi.fn().mockResolvedValue({
        id: "m1",
        storageKey: "sites/s1/uuid.png",
        filename: "photo.png",
        mimeType: "image/png",
        size: 10,
        width: null,
        height: null,
        alt: null,
        folderId: null,
        createdAt: new Date("2024-01-01T00:00:00.000Z"),
      }),
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
      update: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      delete: vi.fn().mockResolvedValue({}),
    },
    mediaFolder: { findFirst: vi.fn().mockResolvedValue(null) },
  };
}

const config = {
  getOrThrow: (k: string) =>
    ({
      S3_BUCKET: "bucket",
      S3_PUBLIC_URL: "https://cdn.example.com",
      S3_ENDPOINT: "https://s3.local",
      S3_ACCESS_KEY: "ak",
      S3_SECRET_KEY: "sk",
    })[k],
  get: (k: string) => (k === "S3_REGION" ? "us-east-1" : undefined),
};
const queue = { enqueue: vi.fn().mockResolvedValue(undefined) };
const audit = { record: vi.fn().mockResolvedValue(undefined) };

function makeService() {
  return new MediaService(config as any, queue as any, audit as any);
}

const actor: RequestActor = {
  userId: "u1",
  tenantId: "t1",
  email: "a@x.com",
  role: "EDITOR",
  permissions: ["media:upload"],
  siteId: "s1",
};

function file(over: Partial<Express.Multer.File> = {}): Express.Multer.File {
  return {
    fieldname: "file",
    originalname: "photo.png",
    encoding: "7bit",
    mimetype: "image/png",
    size: 10,
    buffer: Buffer.from("x"),
    stream: {} as any,
    destination: "",
    filename: "",
    path: "",
    ...over,
  };
}

describe("MediaService", () => {
  beforeEach(() => {
    holder.db = makeDb();
    s3State.send = vi.fn().mockResolvedValue({});
    queue.enqueue.mockClear();
    audit.record.mockClear();
  });

  describe("upload", () => {
    it("rejects an HTML upload that is not on the MIME allowlist", async () => {
      // Stored XSS vector: an .html served from the site's own origin runs script
      // in the site's context. The allowlist is the wall; text/html is not on it.
      await expect(
        makeService().upload(actor, "s1", file({ mimetype: "text/html", originalname: "x.html" })),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(s3State.send).not.toHaveBeenCalled();
    });

    it("rejects an SVG upload, which can carry script", async () => {
      // SVG is deliberately excluded even though it is an image: it can embed
      // <script> and would execute on the site's origin.
      expect(ALLOWED_MIME.has("image/svg+xml")).toBe(false);
      await expect(
        makeService().upload(actor, "s1", file({ mimetype: "image/svg+xml", originalname: "x.svg" })),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("rejects a file larger than the size cap", async () => {
      // An unbounded upload is a memory-exhaustion DoS; multer buffers into RAM.
      await expect(
        makeService().upload(actor, "s1", file({ size: MAX_UPLOAD_BYTES + 1 })),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(s3State.send).not.toHaveBeenCalled();
    });

    it("rejects when no file part is present", async () => {
      await expect(
        makeService().upload(actor, "s1", undefined as any),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("derives the storage key server-side under the site prefix, ignoring the client filename", async () => {
      // Attacker: originalname "../../etc/passwd". The key is minted from the site
      // id + a random uuid, so a traversal string in the filename cannot escape the
      // site's prefix or land on another tenant's object.
      await makeService().upload(
        actor,
        "s1",
        file({ originalname: "../../../../etc/passwd.png" }),
      );

      const key = s3State.send.mock.calls[0][0].input.Key as string;
      expect(key.startsWith("sites/s1/")).toBe(true);
      expect(key).not.toContain("..");
      expect(key).not.toContain("etc/passwd");
    });

    it("stores the validated MIME as Content-Type, not one derived from a double extension", async () => {
      // "x.png.html" is a PNG whose name ends .html. The object is written with the
      // ContentType the allowlist validated (image/png), so the CDN serves it as an
      // image and a browser never renders it as HTML — the trailing .html is inert.
      await makeService().upload(actor, "s1", file({ originalname: "x.png.html", mimetype: "image/png" }));

      const input = s3State.send.mock.calls[0][0].input;
      expect(input.ContentType).toBe("image/png");
    });

    it("stamps the stored row with the actor's tenant and site", async () => {
      await makeService().upload(actor, "s1", file());

      const data = holder.db.media.create.mock.calls[0][0].data;
      expect(data.tenantId).toBe("t1");
      expect(data.siteId).toBe("s1");
    });

    it("rejects a folder id that belongs to another site", async () => {
      // The folderId is client-supplied; without the scoped check a caller could
      // file an upload into another tenant's folder.
      holder.db.mediaFolder.findFirst.mockResolvedValue(null);

      await expect(
        makeService().upload(actor, "s1", file(), "folder-elsewhere"),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe("list", () => {
    it("scopes the query to the site", async () => {
      await makeService().list("s1", { page: 1, perPage: 40 });

      expect(holder.db.media.findMany.mock.calls[0][0].where.siteId).toBe("s1");
    });

    it("browsing the root filters to files with no folder", async () => {
      await makeService().list("s1", { page: 1, perPage: 40, folder: "root" });

      expect(holder.db.media.findMany.mock.calls[0][0].where.folderId).toBeNull();
    });

    it("omitting the folder reaches across every folder", async () => {
      await makeService().list("s1", { page: 1, perPage: 40, folder: undefined });

      expect(holder.db.media.findMany.mock.calls[0][0].where).not.toHaveProperty("folderId");
    });
  });

  describe("update", () => {
    it("does not update media belonging to another site", async () => {
      holder.db.media.findFirst.mockResolvedValue(null);

      await expect(
        makeService().update(actor, "s1", "other-sites-media", { filename: "x" } as any),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(holder.db.media.findFirst.mock.calls[0][0].where.siteId).toBe("s1");
    });
  });

  describe("bulkMove", () => {
    it("scopes the move to the site so foreign ids are silently skipped", async () => {
      // Attacker mixes another site's media ids into the list; siteId in the WHERE
      // means updateMany simply never touches them.
      holder.db.media.updateMany.mockResolvedValue({ count: 1 });

      await makeService().bulkMove(actor, "s1", ["mine", "foreign"], null);

      expect(holder.db.media.updateMany.mock.calls[0][0].where.siteId).toBe("s1");
    });
  });

  describe("bulkRemove", () => {
    it("scopes both the read and the delete to the site", async () => {
      // Attacker mixes foreign ids into the delete list; siteId in both the
      // pre-read and the deleteMany means only this site's rows are ever touched.
      holder.db.media.findMany.mockResolvedValue([
        { id: "mine", filename: "a.png", storageKey: "sites/s1/a.png" },
      ]);
      holder.db.media.deleteMany.mockResolvedValue({ count: 1 });

      const res = await makeService().bulkRemove(actor, "s1", ["mine", "foreign"]);

      expect(res.deleted).toBe(1);
      expect(holder.db.media.findMany.mock.calls[0][0].where.siteId).toBe("s1");
      expect(holder.db.media.deleteMany.mock.calls[0][0].where.siteId).toBe("s1");
    });
  });

  describe("remove", () => {
    it("does not delete media belonging to another site", async () => {
      holder.db.media.findFirst.mockResolvedValue(null);

      await expect(
        makeService().remove(actor, "s1", "other-sites-media"),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(holder.db.media.delete).not.toHaveBeenCalled();
    });
  });
});
