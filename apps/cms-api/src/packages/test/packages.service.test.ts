import { beforeEach, describe, expect, it, vi } from "vitest";
import { Logger } from "@nestjs/common";

// The database is imported by packages.module but never touched by onModuleInit;
// stub it so importing the service does not reach for a real connection. The
// scanner and package modules are pure function exports with no side effects, so
// they are left real — mocking them only risks an incomplete import graph.
vi.mock("@zcmsorg/database", () => ({ getSystemDb: () => ({}) }));

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
  get: (k: string) => (k === "S3_REGION" ? "us-east-1" : undefined),
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
