import { beforeEach, describe, expect, it, vi } from "vitest";
import { QUEUE_NAME, QUEUE_PREFIX } from "../jobs";
import { QueueProducer } from "../producer";

/**
 * Redis and BullMQ are the external I/O here, so they are the only things mocked.
 * What matters is not that BullMQ works — it does — but that we hand it the right
 * queue, the right job name, and the right options. Every one of those is a
 * silent failure if it is wrong: the job runs on the wrong queue, or never
 * retries, or is enqueued twice for one upload.
 */

const mocks = vi.hoisted(() => ({
  add: vi.fn(),
  getFailed: vi.fn(),
  getFailedCount: vi.fn(),
  getJob: vi.fn(),
  close: vi.fn(),
  quit: vi.fn(),
  RedisCtor: vi.fn(),
  QueueCtor: vi.fn(),
}));

vi.mock("ioredis", () => ({
  Redis: class {
    quit = mocks.quit;
    constructor(...args: unknown[]) {
      mocks.RedisCtor(...args);
    }
  },
}));

vi.mock("bullmq", () => ({
  Queue: class {
    add = mocks.add;
    getFailed = mocks.getFailed;
    getFailedCount = mocks.getFailedCount;
    getJob = mocks.getJob;
    close = mocks.close;
    constructor(...args: unknown[]) {
      mocks.QueueCtor(...args);
    }
  },
}));

const REDIS_URL = "redis://localhost:6379";

const MEDIA_PAYLOAD = {
  tenantId: "tenant-a",
  siteId: "site-1",
  mediaId: "media-1",
  storageKey: "uploads/media-1.png",
  mimeType: "image/png",
};

/** The options object the producer passed to BullMQ on the Nth `add`. */
function addOptions(call = 0) {
  return mocks.add.mock.calls[call]?.[2] as Record<string, unknown>;
}

let producer: QueueProducer;

beforeEach(() => {
  // The hoisted vi.fn mocks are shared across tests; clear their call history so
  // addOptions(0) reads THIS test's enqueue, not one an earlier test made.
  for (const fn of Object.values(mocks)) fn.mockReset();
  mocks.getFailed.mockResolvedValue([]);
  mocks.getFailedCount.mockResolvedValue(0);
  producer = new QueueProducer(REDIS_URL);
});

describe("QueueProducer", () => {
  describe("constructor", () => {
    it("connects to the Redis URL it was given", () => {
      expect(mocks.RedisCtor).toHaveBeenCalledWith(REDIS_URL, expect.anything());
    });

    it("disables ioredis' per-request retry limit, which BullMQ requires", () => {
      // BullMQ's consumer blocks on Redis for long stretches. With ioredis'
      // default limit, that blocking read is aborted as a "failed request" and
      // the queue silently stops being drained.
      expect(mocks.RedisCtor).toHaveBeenCalledWith(REDIS_URL, {
        maxRetriesPerRequest: null,
      });
    });

    it("attaches to the one queue the worker consumes, under the shared prefix", () => {
      // A producer on a different queue name enqueues into a queue with no
      // consumer: the work is accepted, stored, and never done. The PREFIX has exactly
      // the same failure mode and is easier to get wrong, because BullMQ silently
      // defaults it to `bull:` when it is omitted — so a producer that forgets it writes
      // to a keyspace the worker is not watching, and neither side errors.
      expect(mocks.QueueCtor).toHaveBeenCalledWith(
        QUEUE_NAME,
        expect.objectContaining({ prefix: QUEUE_PREFIX }),
      );
    });

    it("hands the queue the connection it just opened rather than a fresh one", () => {
      const [, options] = mocks.QueueCtor.mock.calls[0] as [string, { connection: unknown }];

      expect(options.connection).toBeDefined();
      expect(options.connection).toBeInstanceOf(Object);
    });
  });

  describe("enqueue", () => {
    it("enqueues a job under the exact name the worker matches on", async () => {
      await producer.enqueue("media.variants", MEDIA_PAYLOAD);

      expect(mocks.add).toHaveBeenCalledWith(
        "media.variants",
        MEDIA_PAYLOAD,
        expect.anything(),
      );
    });

    it("passes the payload through untouched, so the worker reads what the caller wrote", async () => {
      await producer.enqueue("plugin.deferred", {
        tenantId: "tenant-a",
        siteId: "site-1",
        pluginKey: "vn.zsoft.plugin.seo",
        name: "reindex",
        payload: { postId: "p1" },
      });

      expect(mocks.add.mock.calls[0]?.[1]).toEqual({
        tenantId: "tenant-a",
        siteId: "site-1",
        pluginKey: "vn.zsoft.plugin.seo",
        name: "reindex",
        payload: { postId: "p1" },
      });
    });

    it("retries a failed job three times before dead-lettering it", async () => {
      // One attempt means a transient S3 blip permanently loses the thumbnails.
      await producer.enqueue("site.sitemap", { tenantId: "t", siteId: "s" });

      expect(addOptions().attempts).toBe(3);
    });

    it("backs off exponentially from 2s, so a failing dependency is not hammered", async () => {
      await producer.enqueue("site.sitemap", { tenantId: "t", siteId: "s" });

      expect(addOptions().backoff).toEqual({ type: "exponential", delay: 2000 });
    });

    it("uses the caller's jobId, which is what makes a re-fired event idempotent", async () => {
      // Two uploads of the same file, or a double-fired webhook, must produce ONE
      // job. BullMQ dedupes on jobId; without it the work runs twice.
      await producer.enqueue("media.variants", MEDIA_PAYLOAD, { jobId: "media-1" });

      expect(addOptions().jobId).toBe("media-1");
    });

    it("delays a job by the requested number of milliseconds", async () => {
      await producer.enqueue("media.variants", MEDIA_PAYLOAD, { delayMs: 5_000 });

      expect(addOptions().delay).toBe(5_000);
    });

    it("leaves jobId and delay unset when the caller asked for neither", async () => {
      // An accidental default jobId would collapse every media job into one.
      await producer.enqueue("media.variants", MEDIA_PAYLOAD);

      expect(addOptions().jobId).toBeUndefined();
      expect(addOptions().delay).toBeUndefined();
    });

    it("keeps completed jobs for an hour and no more than a thousand of them", async () => {
      // Completed jobs are kept only long enough to be looked at. Unbounded, they
      // are a slow Redis memory leak that ends the instance.
      await producer.enqueue("media.sweep", {});

      expect(addOptions().removeOnComplete).toEqual({ age: 3600, count: 1000 });
    });

    it("keeps failed jobs for a day, so an operator has time to see them", async () => {
      // The dead-letter queue is only useful if the evidence outlives the incident.
      await producer.enqueue("media.sweep", {});

      expect(addOptions().removeOnFail).toEqual({ age: 86_400 });
    });

    it("gives every job name the same durability options", async () => {
      // A job class that quietly gets attempts: 1 is a job class that silently
      // loses work.
      await producer.enqueue("sessions.prune", {});
      await producer.enqueue("marketplace.sync", {});

      expect(addOptions(0).attempts).toBe(addOptions(1).attempts);
      expect(addOptions(0).backoff).toEqual(addOptions(1).backoff);
    });
  });

  describe("failedJobs", () => {
    const failed = (over: Record<string, unknown> = {}) => ({
      id: 42,
      name: "media.variants",
      attemptsMade: 3,
      failedReason: "S3 timeout",
      finishedOn: 1_700_000_000_000,
      data: { mediaId: "m1" },
      ...over,
    });

    it("reports how many jobs have failed, not just how many it is showing", async () => {
      // A page of 50 with no total reads exactly like "there are 50 failures" —
      // the one thing an operator must not believe when the real number is 1,204.
      mocks.getFailed.mockResolvedValue([failed()]);
      mocks.getFailedCount.mockResolvedValue(1204);

      const page = await producer.failedJobs();

      expect(page.total).toBe(1204);
      expect(page.items).toHaveLength(1);
    });

    it("returns at most the number of jobs asked for", async () => {
      await producer.failedJobs(10);

      expect(mocks.getFailed).toHaveBeenCalledWith(0, 9);
    });

    it("shows the first fifty failures when no limit is given", async () => {
      await producer.failedJobs();

      expect(mocks.getFailed).toHaveBeenCalledWith(0, 49);
    });

    it("exposes the job's name, attempts and reason so the failure can be diagnosed", async () => {
      mocks.getFailed.mockResolvedValue([failed()]);

      const [item] = (await producer.failedJobs()).items;

      expect(item).toMatchObject({
        id: "42",
        name: "media.variants",
        attemptsMade: 3,
        failedReason: "S3 timeout",
        data: { mediaId: "m1" },
      });
    });

    it("says 'unknown' rather than nothing when a job failed without a reason", async () => {
      mocks.getFailed.mockResolvedValue([failed({ failedReason: undefined })]);

      const [item] = (await producer.failedJobs()).items;

      expect(item?.failedReason).toBe("unknown");
    });

    it("reports when a job failed as an ISO timestamp", async () => {
      mocks.getFailed.mockResolvedValue([failed({ finishedOn: 1_700_000_000_000 })]);

      const [item] = (await producer.failedJobs()).items;

      expect(item?.failedAt).toBe(new Date(1_700_000_000_000).toISOString());
    });

    it("reports no failure time rather than the epoch when the job never finished", async () => {
      // `new Date(0).toISOString()` would tell an operator the job failed in 1970.
      mocks.getFailed.mockResolvedValue([failed({ finishedOn: undefined })]);

      const [item] = (await producer.failedJobs()).items;

      expect(item?.failedAt).toBeNull();
    });
  });

  describe("retryJob", () => {
    it("puts a dead-lettered job back on the queue", async () => {
      const retry = vi.fn();
      mocks.getJob.mockResolvedValue({ retry });

      const result = await producer.retryJob("42");

      expect(retry).toHaveBeenCalledOnce();
      expect(result).toBe(true);
    });

    it("reports failure rather than throwing when the job id does not exist", async () => {
      // Job ids come off a URL an operator typed. A 500 for a stale id is noise.
      mocks.getJob.mockResolvedValue(undefined);

      expect(await producer.retryJob("gone")).toBe(false);
    });
  });

  describe("discardJob", () => {
    it("removes a dead-lettered job from the queue", async () => {
      const remove = vi.fn();
      mocks.getJob.mockResolvedValue({ remove });

      const result = await producer.discardJob("42");

      expect(remove).toHaveBeenCalledOnce();
      expect(result).toBe(true);
    });

    it("reports failure rather than throwing when the job id does not exist", async () => {
      mocks.getJob.mockResolvedValue(null);

      expect(await producer.discardJob("gone")).toBe(false);
    });
  });

  describe("close", () => {
    it("closes the queue and quits the Redis connection", async () => {
      // A process that exits without quitting ioredis hangs on shutdown; a
      // deploy that hangs on shutdown gets SIGKILLed mid-job.
      await producer.close();

      expect(mocks.close).toHaveBeenCalledOnce();
      expect(mocks.quit).toHaveBeenCalledOnce();
    });
  });
});
