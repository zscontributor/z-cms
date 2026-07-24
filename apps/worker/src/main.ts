import path from "node:path";
import { config as loadEnv } from "dotenv";

loadEnv({ path: path.resolve(__dirname, "../../../.env"), quiet: true });

import { disconnectDb } from "@zcmsorg/database";
import {
  QUEUE_NAME,
  QUEUE_PREFIX,
  SCHEDULED_JOBS,
  type JobName,
  type JobPayloads,
} from "@zcmsorg/queue";
import { Queue, Worker, type ConnectionOptions, type Job } from "bullmq";
import { Redis } from "ioredis";
import { runMediaSweep, runSessionsPrune } from "./jobs/housekeeping";
import { reportMailDeadLetter, runMailSend } from "./jobs/mail-send";
import { runMarketplaceSync } from "./jobs/marketplace-sync";
import { runMediaVariants } from "./jobs/media-variants";
import { runPluginDeferred } from "./jobs/plugin-deferred";
import { runSitemap } from "./jobs/sitemap";
import { runThemeBuild } from "./jobs/theme-build";

/**
 * The background worker.
 *
 * A separate process from cms-api on purpose: heavy, slow work (image
 * processing, sandbox round-trips) must not compete with the API's request
 * threads, and the worker can be scaled — or restarted — independently. BullMQ
 * persists the queue, so a job survives the worker being down.
 */

const CONCURRENCY = Number(process.env.WORKER_CONCURRENCY ?? 4);
/** Mirrors the producer's retry policy (packages/queue). Used to spot a dead letter. */
const MAX_ATTEMPTS = 3;

const connection = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", {
  maxRetriesPerRequest: null,
});

type Handlers = { [K in JobName]: (data: JobPayloads[K]) => Promise<unknown> };

const handlers: Handlers = {
  "media.variants": runMediaVariants,
  "plugin.deferred": runPluginDeferred,
  "site.sitemap": runSitemap,
  "theme.build": runThemeBuild,
  "mail.send": runMailSend,
  "sessions.prune": runSessionsPrune,
  "media.sweep": runMediaSweep,
  "marketplace.sync": runMarketplaceSync,
};

/**
 * Registers the repeatable jobs the worker runs for itself.
 *
 * BullMQ keys a repeatable on (name, cron), so re-deploying replaces the schedule
 * rather than stacking a second copy of it — running the media sweep twice a night
 * because the service was deployed twice would be a poor way to find out.
 */
async function scheduleRepeatables(): Promise<void> {
  // Its OWN connection, not the worker's.
  //
  // Handing the shared ioredis instance to this Queue and then calling
  // queue.close() closes that instance — and the Worker is using it. The worker
  // logged "listening", registered its schedules, and exited immediately. It
  // looked like a crash on boot; it was this function tidying up after itself and
  // taking the process down with it.
  const queue = new Queue(QUEUE_NAME, {
    prefix: QUEUE_PREFIX,
    connection: connection.duplicate() as unknown as ConnectionOptions,
  });

  for (const job of SCHEDULED_JOBS) {
    await queue.add(
      job.name,
      {} as never,
      {
        repeat: { pattern: job.cron },
        // A missed run is not worth catching up on: the next one does the same
        // work. Housekeeping is idempotent by nature.
        removeOnComplete: { count: 10 },
        removeOnFail: { count: 50 },
      },
    );
    console.log(`[worker] scheduled ${job.name} (${job.cron})`);
  }

  await queue.close();
}

const worker = new Worker(
  QUEUE_NAME,
  async (job: Job) => {
    const handler = handlers[job.name as JobName];
    if (!handler) {
      // An unknown job name is a bug, not a retry-able condition — a newer
      // producer against an older worker. Fail it loudly rather than looping.
      throw new Error(`No handler for job "${job.name}".`);
    }
    return handler(job.data);
  },
  {
    // The prefix MUST match the producer's. A worker listening on the default `bull:` while
    // cms-api writes to `zcms-app:` is not an error — it is a worker that sits there
    // forever, healthy and idle, while jobs pile up in a keyspace nobody reads.
    prefix: QUEUE_PREFIX,
    connection: connection as unknown as ConnectionOptions,
    concurrency: CONCURRENCY,
  },
);

worker.on("completed", (job) => {
  console.log(`[worker] ✓ ${job.name} (${job.id}) in ${Date.now() - job.timestamp}ms`);
});

worker.on("failed", (job, err) => {
  console.warn(
    `[worker] ✗ ${job?.name} (${job?.id}) attempt ${job?.attemptsMade}: ${err.message}`,
  );

  // Out of retries. Until now this landed in BullMQ's failed set and stayed
  // there — a job silently not done, which for `media.variants` means a site
  // with no thumbnails and nobody the wiser. A dead letter is an incident, so
  // it alerts.
  const attempts = job?.opts?.attempts ?? MAX_ATTEMPTS;
  if (job && job.attemptsMade >= attempts) {
    void alertDeadLetter(job.name, job.id, job.data as Record<string, unknown>, err.message);

    // A dead-lettered email is the one failure a *plugin* may need to know about
    // — a newsletter plugin building a suppression list, say. The operator's
    // webhook above is not a channel plugins can read, so cms-api is told
    // separately and fires `mail.failed` in the sandbox. Only here, on the final
    // attempt: an event that fired on attempt one of three would be a lie.
    if (job.name === "mail.send") {
      void reportMailDeadLetter(job.data as JobPayloads["mail.send"], err.message);
    }
  }
});

/**
 * Pushes a dead-lettered job to the operator's alert webhook.
 *
 * The worker holds no admin session and has no business writing security rows,
 * so it posts to the same generic webhook cms-api uses rather than reaching into
 * the database. If no webhook is configured the error log is still loud.
 */
async function alertDeadLetter(
  name: string,
  id: string | undefined,
  data: Record<string, unknown>,
  error: string,
): Promise<void> {
  console.error(`[worker] DEAD LETTER ${name} (${id}) after ${MAX_ATTEMPTS} attempts: ${error}`);

  const url = process.env.SECURITY_ALERT_WEBHOOK;
  if (!url) return;

  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        event: "job.dead_lettered",
        severity: "high",
        at: new Date().toISOString(),
        details: { job: name, jobId: id, error, data },
      }),
      signal: AbortSignal.timeout(3000),
    });
  } catch (err) {
    console.error(`[worker] dead-letter alert failed: ${(err as Error).message}`);
  }
}

void scheduleRepeatables().catch((err: Error) =>
  console.error(`[worker] could not register scheduled jobs: ${err.message}`),
);

console.log(`worker listening on queue "${QUEUE_NAME}", concurrency ${CONCURRENCY}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void (async () => {
      await worker.close();
      await connection.quit();
      await disconnectDb();
      process.exit(0);
    })();
  });
}
