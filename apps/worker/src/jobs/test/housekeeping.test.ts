import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Housekeeping is the most dangerous code in the worker: a bug in a `deleteMany`
 * or a mis-scoped S3 sweep does not corrupt one row, it wipes the platform. These
 * tests are written to catch exactly the over-broad deletion — an absent `where`,
 * a variant thumbnail counted as an orphan, a just-uploaded image swept before its
 * row is written — that would turn a hygiene job into an outage.
 */

const { dbMock, s3Send } = vi.hoisted(() => ({
  dbMock: {
    refreshToken: { deleteMany: vi.fn() },
    media: { findMany: vi.fn() },
  },
  s3Send: vi.fn(),
}));

vi.mock("@zcmsorg/database", () => ({ getSystemDb: () => dbMock }));

vi.mock("@aws-sdk/client-s3", () => ({
  // Classes, not vi.fn(): `new S3Client()` must construct, and restoreMocks must
  // not strip these back to no-ops between tests. Command instances just carry
  // their input plus a tag the fake send() dispatches on.
  S3Client: class {
    send = s3Send;
  },
  ListObjectsV2Command: class {
    __type = "list";
    constructor(public input: unknown) {}
  },
  DeleteObjectsCommand: class {
    __type = "delete";
    constructor(public input: unknown) {}
  },
}));

import { runMediaSweep, runSessionsPrune } from "../housekeeping";

const DAY = 86_400_000;
const HOUR = 3_600_000;

describe("runSessionsPrune", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.refreshToken.deleteMany.mockResolvedValue({ count: 7 });
  });

  it("reports how many dead tokens it removed", async () => {
    const result = await runSessionsPrune();

    expect(result).toEqual({ deleted: 7 });
  });

  it("never issues a deleteMany without a where filter", async () => {
    // THE CATASTROPHE THIS GUARDS. `deleteMany({})` with no filter empties the whole
    // refresh-token table — every user on every tenant logged out at once. The filter
    // must always be present and non-empty.
    await runSessionsPrune();

    const arg = dbMock.refreshToken.deleteMany.mock.calls[0]![0];
    expect(arg?.where).toBeTruthy();
    expect(Object.keys(arg.where)).not.toHaveLength(0);
  });

  it("only deletes tokens that are expired, long-revoked, or long-consumed", async () => {
    // A live, unexpired token must survive. The delete matches on three time bounds
    // ORed together and nothing else — no unconditional clause could sweep a valid
    // session.
    await runSessionsPrune();

    const where = dbMock.refreshToken.deleteMany.mock.calls[0]![0].where;
    expect(Array.isArray(where.OR)).toBe(true);
    expect(where.OR).toHaveLength(3);
    const fields = where.OR.flatMap((c: Record<string, unknown>) => Object.keys(c));
    expect(fields).toEqual(expect.arrayContaining(["expiresAt", "revokedAt", "consumedAt"]));
  });

  it("keeps a revoked token for the 30-day audit grace period, not deleting it on revocation", async () => {
    // A revoked token family is the evidence a theft investigation reads. Deleting it
    // the instant it is revoked destroys the record that the theft happened.
    const before = Date.now();
    await runSessionsPrune();
    const after = Date.now();

    const where = dbMock.refreshToken.deleteMany.mock.calls[0]![0].where;
    const revoked = where.OR.find((c: Record<string, { lt: Date }>) => c.revokedAt) as {
      revokedAt: { lt: Date };
    };
    const cutoff = revoked.revokedAt.lt.getTime();
    // ~30 days in the past, within the wall-clock window this test ran in.
    expect(cutoff).toBeGreaterThanOrEqual(before - 30 * DAY - 1000);
    expect(cutoff).toBeLessThanOrEqual(after - 30 * DAY + 1000);
  });
});

/** Drives one sweep with a given set of claimed media rows and a single S3 page. */
async function sweepWith(
  rows: Array<{ storageKey: string; variants?: Record<string, string> }>,
  contents: Array<{ Key: string; LastModified: Date }>,
) {
  dbMock.media.findMany.mockResolvedValue(rows);
  s3Send.mockImplementation(async (command: { __type: string }) => {
    if (command.__type === "list") return { Contents: contents, IsTruncated: false };
    return {};
  });

  const result = await runMediaSweep();

  const deleteCalls = s3Send.mock.calls
    .map(([c]) => c as { __type: string; input: { Delete: { Objects: { Key: string }[] } } })
    .filter((c) => c.__type === "delete");
  const deletedKeys = deleteCalls.flatMap((c) => c.input.Delete.Objects.map((o) => o.Key));
  return { result, deletedKeys, deleteCalls };
}

describe("runMediaSweep", () => {
  const old = new Date(Date.now() - 10 * DAY); // safely past the 24h min-age window

  beforeEach(() => {
    // s3Send call history accumulates across tests otherwise, and sweepWith reads it.
    vi.clearAllMocks();
    vi.stubEnv("S3_BUCKET", "media-bucket");
    vi.stubEnv("S3_ACCESS_KEY", "k");
    vi.stubEnv("S3_SECRET_KEY", "s");
  });

  it("deletes a genuinely orphaned object under sites/", async () => {
    const { result, deletedKeys } = await sweepWith(
      [{ storageKey: "sites/s1/keep.png" }],
      [
        { Key: "sites/s1/keep.png", LastModified: old },
        { Key: "sites/s1/orphan.png", LastModified: old },
      ],
    );

    expect(deletedKeys).toEqual(["sites/s1/orphan.png"]);
    expect(result.deleted).toBe(1);
  });

  it("never deletes an object a media row still claims as its original", async () => {
    // Deleting a claimed original is deleting a live image off a customer's page.
    const { deletedKeys } = await sweepWith(
      [{ storageKey: "sites/s1/photo.png" }],
      [{ Key: "sites/s1/photo.png", LastModified: old }],
    );

    expect(deletedKeys).toEqual([]);
  });

  it("never deletes a variant referenced only in the variants JSON", async () => {
    // THE THUMBNAIL-WIPE BUG. A variant key (`<base>.thumb.webp`) is no row's
    // storageKey — it lives in the variants JSON. Matching only storageKey would flag
    // every thumbnail in the system as an orphan and delete it on the first run.
    const { deletedKeys } = await sweepWith(
      [{ storageKey: "sites/s1/photo.png", variants: { thumb: "sites/s1/photo.thumb.webp" } }],
      [
        { Key: "sites/s1/photo.png", LastModified: old },
        { Key: "sites/s1/photo.thumb.webp", LastModified: old },
      ],
    );

    expect(deletedKeys).toEqual([]);
  });

  it("skips an object younger than the 24h window, so it cannot race a live upload", async () => {
    // The upload writes the object BEFORE it writes the row. Without this window the
    // sweep deletes a perfectly good image seconds after a customer uploaded it.
    const justNow = new Date(Date.now() - 1 * HOUR);
    const { result, deletedKeys } = await sweepWith(
      [],
      [{ Key: "sites/s1/fresh.png", LastModified: justNow }],
    );

    expect(deletedKeys).toEqual([]);
    expect(result.skippedTooYoung).toBe(1);
  });

  it("never deletes a site's sitemap.xml, which we write and no media row claims", async () => {
    const { deletedKeys } = await sweepWith(
      [],
      [{ Key: "sites/s1/sitemap.xml", LastModified: old }],
    );

    expect(deletedKeys).toEqual([]);
  });

  it("scans only the sites/ prefix, leaving packages and platform objects untouched", async () => {
    // Packages, backups and other platform storage are out of scope entirely. The
    // scan must never even list them, let alone consider them orphans.
    await sweepWith([], [{ Key: "sites/s1/x.png", LastModified: old }]);

    const listCall = s3Send.mock.calls
      .map(([c]) => c as { __type: string; input: { Prefix: string } })
      .find((c) => c.__type === "list");
    expect(listCall!.input.Prefix).toBe("sites/");
  });

  it("ignores a non-string value in a row's variants JSON", async () => {
    // variants is free-form JSON; a malformed entry must not be treated as a claimed
    // key (nor crash the scan) — only string values are real object keys.
    const { deletedKeys } = await sweepWith(
      [{ storageKey: "sites/s1/a.png", variants: { bad: 123 as unknown as string } }],
      [{ Key: "sites/s1/a.png", LastModified: old }],
    );

    expect(deletedKeys).toEqual([]);
  });

  it("skips a listed object that has no key at all", async () => {
    // A pathological ListObjects entry with no Key must be ignored, not counted.
    const { result } = await sweepWith(
      [],
      [{ Key: undefined as unknown as string, LastModified: old }],
    );

    expect(result.scanned).toBe(0);
    expect(result.deleted).toBe(0);
  });

  it("treats an object with no LastModified as old enough to sweep", async () => {
    // A missing timestamp defaults to epoch, i.e. definitely older than the window —
    // it must not accidentally count as 'too young' and leak an orphan forever.
    const { deletedKeys } = await sweepWith(
      [],
      [{ Key: "sites/s1/no-date.png", LastModified: undefined as unknown as Date }],
    );

    expect(deletedKeys).toEqual(["sites/s1/no-date.png"]);
  });

  it("issues no DeleteObjects request when nothing is orphaned", async () => {
    // DeleteObjects with an empty key list is a wasted, and easily mis-read, call.
    const { deleteCalls } = await sweepWith(
      [{ storageKey: "sites/s1/keep.png" }],
      [{ Key: "sites/s1/keep.png", LastModified: old }],
    );

    expect(deleteCalls).toHaveLength(0);
  });
});
