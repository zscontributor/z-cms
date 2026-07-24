import { Queue, type ConnectionOptions } from "bullmq";
import { Redis } from "ioredis";
import { QUEUE_NAME, QUEUE_PREFIX, type JobName, type JobPayloads } from "./jobs";

export interface FailedJob {
  id: string;
  name: string;
  attemptsMade: number;
  failedReason: string;
  failedAt: string | null;
  data: Record<string, unknown>;
}

/** One page of the dead-letter queue, plus how big it actually is. */
export interface FailedJobPage {
  items: FailedJob[];
  total: number;
}

/**
 * Enqueues jobs. Used by cms-api; the worker consumes what this produces.
 *
 * BullMQ (not plain Redis Pub/Sub) because a job must survive the worker being
 * down. Pub/Sub is at-most-once — a subscriber that is offline when the message
 * is published never sees it — and "generate the thumbnails" silently not
 * happening because the worker was restarting is exactly the failure a queue
 * exists to prevent. BullMQ persists the job and retries it.
 */
export class QueueProducer {
  private readonly connection: Redis;
  private readonly queue: Queue;

  constructor(redisUrl: string) {
    // maxRetriesPerRequest must be null for a connection BullMQ uses.
    this.connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
    // ioredis and bullmq ship separate copies of the ioredis types across a major
    // version boundary; the instance is correct at runtime, so bridge the nominal
    // gap here rather than pinning both to one copy.
    this.queue = new Queue(QUEUE_NAME, {
      // Must match the worker's prefix, or jobs land in a keyspace nothing is listening
      // to — a failure that looks exactly like "the queue is healthy and idle".
      prefix: QUEUE_PREFIX,
      connection: this.connection as unknown as ConnectionOptions,
    });
  }

  async enqueue<K extends JobName>(
    name: K,
    payload: JobPayloads[K],
    options?: { jobId?: string; delayMs?: number },
  ): Promise<void> {
    await this.queue.add(name, payload, {
      // A stable jobId makes an enqueue idempotent: re-uploading the same media,
      // or a double-fired event, does not queue the work twice.
      jobId: options?.jobId,
      delay: options?.delayMs,
      attempts: 3,
      backoff: { type: "exponential", delay: 2000 },
      removeOnComplete: { age: 3600, count: 1000 },
      removeOnFail: { age: 86_400 },
    });
  }

  /**
   * The dead-letter queue: jobs that exhausted their retries.
   *
   * Exposed so an operator can see and act on them. A failed set nobody can read
   * from the product is a failed set nobody reads.
   */
  async failedJobs(limit = 50): Promise<FailedJobPage> {
    // The total comes back with the page, always. A dead-letter queue that shows
    // 50 rows and does not say how many it is hiding reads exactly like a queue
    // with 50 failures in it — which is the one thing an operator must not
    // believe when the real number is 1,204.
    const [jobs, total] = await Promise.all([
      this.queue.getFailed(0, limit - 1),
      this.queue.getFailedCount(),
    ]);

    return {
      total,
      items: jobs.map((job) => ({
        id: String(job.id),
        name: job.name,
        attemptsMade: job.attemptsMade,
        failedReason: job.failedReason ?? "unknown",
        failedAt: job.finishedOn ? new Date(job.finishedOn).toISOString() : null,
        data: job.data as Record<string, unknown>,
      })),
    };
  }

  /** Puts a dead-lettered job back on the queue, with its attempt count reset. */
  async retryJob(id: string): Promise<boolean> {
    const job = await this.queue.getJob(id);
    if (!job) return false;

    await job.retry();
    return true;
  }

  /** Throws a dead-lettered job away. */
  async discardJob(id: string): Promise<boolean> {
    const job = await this.queue.getJob(id);
    if (!job) return false;

    await job.remove();
    return true;
  }

  async close(): Promise<void> {
    await this.queue.close();
    await this.connection.quit();
  }
}
