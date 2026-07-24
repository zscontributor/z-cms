import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The worker is first-party infrastructure and DOES hold S3 + DB credentials, so
 * this job is exactly where a bad payload could read or overwrite the wrong
 * object. These tests pin: variants are generated at the declared sizes; the DB
 * write is scoped to the job's tenant/site/media so a wrong id is a no-op, never a
 * cross-tenant write; a corrupt image fails the job cleanly instead of crashing
 * the worker; and an unsupported type is skipped without touching storage.
 */

const { sharpMock, chain, s3Send, dbMock } = vi.hoisted(() => {
  const chain = {
    rotate: vi.fn(),
    resize: vi.fn(),
    webp: vi.fn(),
    toBuffer: vi.fn(),
    metadata: vi.fn(),
  };
  return {
    chain,
    sharpMock: vi.fn(() => chain),
    s3Send: vi.fn(),
    dbMock: { media: { updateMany: vi.fn() } },
  };
});

vi.mock("sharp", () => ({ default: sharpMock }));
vi.mock("@zcmsorg/database", () => ({ getSystemDb: () => dbMock }));
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    send = s3Send;
  },
  GetObjectCommand: class {
    __type = "get";
    constructor(public input: unknown) {}
  },
  PutObjectCommand: class {
    __type = "put";
    constructor(public input: unknown) {}
  },
}));

import { runMediaVariants } from "../media-variants";

const JOB = {
  tenantId: "tenant-1",
  siteId: "site-1",
  mediaId: "media-1",
  storageKey: "sites/site-1/abc123.png",
  mimeType: "image/png",
};

/** Extracts the PutObjectCommand inputs S3 received. */
function puts() {
  return s3Send.mock.calls
    .map(([c]) => c as { __type: string; input: { Key: string; ContentType: string } })
    .filter((c) => c.__type === "put")
    .map((c) => c.input);
}

describe("runMediaVariants", () => {
  beforeEach(() => {
    // Hoisted mocks persist across tests; clear call history so puts() reads only
    // this test's writes. Implementations are re-wired below.
    vi.clearAllMocks();
    sharpMock.mockReturnValue(chain);
    chain.rotate.mockReturnValue(chain);
    chain.resize.mockReturnValue(chain);
    chain.webp.mockReturnValue(chain);
    chain.toBuffer.mockResolvedValue(Buffer.from("webp-bytes"));
    chain.metadata.mockResolvedValue({ width: 4000, height: 3000 });

    s3Send.mockImplementation(async (command: { __type: string }) => {
      if (command.__type === "get") {
        return { Body: { transformToByteArray: async () => new Uint8Array([1, 2, 3]) } };
      }
      return {};
    });
    dbMock.media.updateMany.mockResolvedValue({ count: 1 });

    vi.stubEnv("S3_BUCKET", "media-bucket");
    vi.stubEnv("S3_ACCESS_KEY", "k");
    vi.stubEnv("S3_SECRET_KEY", "s");
  });

  it("generates a variant at each of the three declared sizes", async () => {
    await runMediaVariants(JOB);

    const widths = chain.resize.mock.calls.map(([opts]) => (opts as { width: number }).width);
    expect(widths).toEqual([200, 800, 1600]);
    expect(puts()).toHaveLength(3);
  });

  it("never enlarges a small original past its native size", async () => {
    // withoutEnlargement keeps a 100px avatar from being upscaled into a blurry
    // 1600px 'large' — the output would be bytes of nothing.
    await runMediaVariants(JOB);

    for (const [opts] of chain.resize.mock.calls) {
      expect((opts as { withoutEnlargement: boolean }).withoutEnlargement).toBe(true);
    }
  });

  it("derives each variant's S3 key server-side from the stored key, ending in .webp", async () => {
    // The output key is computed from the original's storageKey, not from any client
    // filename. Every variant is re-encoded to WebP, so the key must say so.
    await runMediaVariants(JOB);

    const keys = puts().map((p) => p.Key);
    expect(keys).toEqual([
      "sites/site-1/abc123.thumb.webp",
      "sites/site-1/abc123.medium.webp",
      "sites/site-1/abc123.large.webp",
    ]);
    for (const p of puts()) expect(p.ContentType).toBe("image/webp");
  });

  it("reads the original from exactly the job's storageKey", async () => {
    await runMediaVariants(JOB);

    const get = s3Send.mock.calls
      .map(([c]) => c as { __type: string; input: { Key: string } })
      .find((c) => c.__type === "get");
    expect(get!.input.Key).toBe("sites/site-1/abc123.png");
  });

  it("scopes the metadata write to the job's tenant, site AND media id", async () => {
    // ATTACK: a payload pairing this tenant's tenantId with a mediaId that belongs to
    // another tenant. The updateMany filter carries all three, so the mismatched row is
    // simply not matched — the write is a no-op, never a cross-tenant overwrite.
    await runMediaVariants(JOB);

    const where = dbMock.media.updateMany.mock.calls[0]![0].where;
    expect(where).toEqual({ id: "media-1", tenantId: "tenant-1", siteId: "site-1" });
  });

  it("skips an unsupported mime type without reading or writing any storage", async () => {
    // A PDF or SVG has nothing to downscale. It must return skipped BEFORE touching S3,
    // so a non-raster upload never spends a GetObject or an sharp decode.
    const result = await runMediaVariants({ ...JOB, mimeType: "application/pdf" });

    expect(result.variants).toEqual({});
    expect(result.skipped).toMatch(/unsupported/);
    expect(s3Send).not.toHaveBeenCalled();
  });

  it("skips a payload with a missing mime type instead of crashing", async () => {
    // A malformed job with no mimeType must not throw an unhandled error inside the
    // worker loop; an unknown type is simply not a raster type.
    const result = await runMediaVariants({ ...JOB, mimeType: undefined as unknown as string });

    expect(result.skipped).toBeDefined();
    expect(s3Send).not.toHaveBeenCalled();
  });

  it("fails the job cleanly when the input is corrupt, rather than crashing the worker", async () => {
    // sharp throwing on a truncated/hostile 'image/png' must surface as a rejected job
    // (BullMQ retries, then dead-letters) — not an uncaught exception that takes the
    // whole worker process down with every other in-flight job.
    chain.toBuffer.mockRejectedValue(new Error("Input buffer contains unsupported image format"));

    await expect(runMediaVariants(JOB)).rejects.toThrow(/unsupported image format/);
    // Nothing was recorded: a half-processed media row is worse than an un-processed one.
    expect(dbMock.media.updateMany).not.toHaveBeenCalled();
  });

  it("handles a storage key with no file extension", async () => {
    // An extensionless key must still yield well-formed variant keys, not a truncated
    // one — the `.` lookup falls back to the whole key as the base.
    await runMediaVariants({ ...JOB, storageKey: "sites/site-1/noext" });

    expect(puts().map((p) => p.Key)).toEqual([
      "sites/site-1/noext.thumb.webp",
      "sites/site-1/noext.medium.webp",
      "sites/site-1/noext.large.webp",
    ]);
  });

  it("stores null dimensions when sharp cannot read them", async () => {
    // A metadata read that yields no width/height must persist null, not undefined or a
    // crash — some inputs (e.g. certain SVG-ish payloads) have no raster dimensions.
    chain.metadata.mockResolvedValue({});

    await runMediaVariants(JOB);

    const data = dbMock.media.updateMany.mock.calls[0]![0].data;
    expect(data.width).toBeNull();
    expect(data.height).toBeNull();
  });

  it("records the original's real dimensions read from the image, not from the payload", async () => {
    // The payload never carries width/height; they come from sharp.metadata() on the
    // actual bytes, so a lying client cannot poison the stored dimensions.
    chain.metadata.mockResolvedValue({ width: 1234, height: 567 });

    await runMediaVariants(JOB);

    const data = dbMock.media.updateMany.mock.calls[0]![0].data;
    expect(data.width).toBe(1234);
    expect(data.height).toBe(567);
  });
});
