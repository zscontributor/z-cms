import { describe, expect, it } from "vitest";
import {
  JOB_NAMES,
  QUEUE_NAME,
  QUEUE_PREFIX,
  SCHEDULED_JOBS,
  type JobName,
  type JobPayloads,
} from "../jobs";

/**
 * This file guards a contract that is enforced by nothing else at runtime.
 *
 * The producer (cms-api) names a job with a string; the worker matches on that
 * same string. Nothing connects the two but the fact that they are equal. A typo
 * on either side — "media.variant", "sessions.prune " — is not an error anywhere:
 * BullMQ happily accepts the job, stores it, and no consumer ever claims it. The
 * upload succeeds, the thumbnails never appear, and nothing is logged.
 *
 * So the names are asserted here as literals. Renaming a job must break this file
 * loudly, which forces the person renaming it to go and look at the worker.
 */

describe("QUEUE_NAME", () => {
  it("is the exact queue both the producer and the worker attach to", () => {
    // Producer and worker each pass this string to BullMQ. If it ever differs
    // between the two, every job is written to a queue with no consumer.
    expect(QUEUE_NAME).toBe("zcms-jobs");
  });
});

describe("QUEUE_PREFIX", () => {
  it("namespaces the keyspace away from every other BullMQ app on the node", () => {
    // The default is `bull:`, which is what every unconfigured BullMQ app on the box also
    // uses. Two of them on one Redis do not collide loudly — both workers are subscribed
    // to the same keys, so they take turns consuming each other's jobs, each throwing on a
    // payload it has no handler for. Nobody's work runs and no log says why.
    //
    // The marketplace stack, on the same node, uses `zcms-mkt`. These must never be equal.
    expect(QUEUE_PREFIX).toBe("zcms-app");
    expect(QUEUE_PREFIX).not.toBe("bull");
  });
});

describe("JOB_NAMES", () => {
  it("is exactly the closed set of jobs the worker knows how to run", () => {
    // Frozen on purpose. Adding a name here without adding a handler in the worker
    // produces jobs nobody consumes; removing one strands the jobs already queued.
    expect([...JOB_NAMES]).toEqual([
      "media.variants",
      "plugin.deferred",
      "site.sitemap",
      "theme.build",
      "mail.send",
      "sessions.prune",
      "media.sweep",
      "marketplace.sync",
    ]);
  });

  it("contains no duplicate job name", () => {
    expect(new Set(JOB_NAMES).size).toBe(JOB_NAMES.length);
  });

  it("carries no leading or trailing whitespace in any name", () => {
    // A trailing space is invisible in a diff and in a log line, and it makes the
    // producer's key not equal the worker's key. Exactly the silent-drop bug.
    for (const name of JOB_NAMES) {
      expect(name).toBe(name.trim());
    }
  });

  it("names every job as namespace.action, so a job's owner is readable from its name", () => {
    for (const name of JOB_NAMES) {
      expect(name).toMatch(/^[a-z]+\.[a-z]+$/);
    }
  });
});

describe("JobPayloads", () => {
  // These are compile-time assertions that run under `pnpm typecheck` (the queue
  // tsconfig includes src/**/*.ts). They exist so that changing a payload field in
  // jobs.ts breaks the build rather than reaching production as a worker that
  // reads `undefined` off a job it was handed.

  it("requires the tenant and site a media job belongs to, plus the object to derive from", () => {
    const payload = {
      tenantId: "t1",
      siteId: "s1",
      mediaId: "m1",
      storageKey: "uploads/m1.png",
      mimeType: "image/png",
    } satisfies JobPayloads["media.variants"];

    // A media job without a tenant id cannot be scoped by the worker, and a worker
    // that guesses the tenant is a cross-tenant write.
    expect(payload.tenantId).toBe("t1");
  });

  it("carries the plugin key and the plugin's own handler name separately on a deferred job", () => {
    // `pluginKey` is what the runtime sandboxes and scopes the token to; `name` is
    // an opaque string the PLUGIN chose. Collapsing the two would let a plugin name
    // a first-party job and have the worker run it.
    const payload = {
      tenantId: "t1",
      siteId: "s1",
      pluginKey: "vn.zsoft.plugin.seo",
      name: "reindex",
      payload: { postId: "p1" },
    } satisfies JobPayloads["plugin.deferred"];

    expect(payload.pluginKey).not.toBe(payload.name);
  });

  it("takes no payload for the scheduled housekeeping and kill-switch jobs", () => {
    const prune = {} satisfies JobPayloads["sessions.prune"];
    const sweep = {} satisfies JobPayloads["media.sweep"];
    const sync = {} satisfies JobPayloads["marketplace.sync"];

    expect([prune, sweep, sync]).toEqual([{}, {}, {}]);
  });

  it("declares a payload type for every name in JOB_NAMES", () => {
    // Keeps the runtime list and the type map from drifting apart: a name added to
    // JOB_NAMES with no payload declared makes this assignment fail to compile.
    const names: readonly JobName[] = JOB_NAMES;

    expect(names.length).toBe(JOB_NAMES.length);
  });
});

describe("SCHEDULED_JOBS", () => {
  const cronOf = (name: JobName) =>
    SCHEDULED_JOBS.find((job) => job.name === name)?.cron;

  it("schedules only jobs that exist in the job vocabulary", () => {
    // A repeatable registered under an unknown name fires forever into a void.
    for (const job of SCHEDULED_JOBS) {
      expect(JOB_NAMES).toContain(job.name);
    }
  });

  it("gives every scheduled job a five-field cron expression", () => {
    for (const job of SCHEDULED_JOBS) {
      expect(job.cron.trim().split(/\s+/)).toHaveLength(5);
    }
  });

  it("registers each job at most once, so a re-deploy cannot double-schedule it", () => {
    // BullMQ keys a repeatable on (name, cron). Two entries with the same name but
    // different crons would run the job twice a night, not once.
    const names = SCHEDULED_JOBS.map((job) => job.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("runs the session prune nightly at 03:15", () => {
    expect(cronOf("sessions.prune")).toBe("15 3 * * *");
  });

  it("runs the media sweep after the session prune, so the two never contend", () => {
    // Both are heavy deletes on a busy instance. Overlapping them is how a nightly
    // hygiene job turns into a nightly lock storm.
    const prune = cronOf("sessions.prune")!.split(" ");
    const sweep = cronOf("media.sweep")!.split(" ");

    expect(sweep[1]).toBe(prune[1]); // same hour
    expect(Number(sweep[0])).toBeGreaterThan(Number(prune[0])); // later minute
  });

  it("polls the marketplace revocation list every hour, bounding how long a revoked package keeps running", () => {
    // THE KILL SWITCH. This cron IS the worst-case exposure window: the gap between
    // "this plugin is known malicious" and "it stops executing on a customer site".
    // Changing the hour field from `*` to a fixed hour silently turns an hour of
    // exposure into a day of it.
    const [minute, hour, dom, month, dow] = cronOf("marketplace.sync")!.split(" ");

    expect(hour).toBe("*");
    expect([dom, month, dow]).toEqual(["*", "*", "*"]);
    // Off the hour, so ten thousand self-hosted instances do not all ask at :00.
    expect(Number(minute)).toBeGreaterThan(0);
    expect(Number(minute)).toBeLessThan(60);
  });

  it("schedules the marketplace sync far more often than the housekeeping jobs", () => {
    // It is a safety mechanism, not hygiene. If it is ever demoted to a daily job,
    // this fails.
    const daily = SCHEDULED_JOBS.filter((job) => job.cron.split(" ")[1] !== "*");

    expect(daily.map((job) => job.name).sort()).toEqual(["media.sweep", "sessions.prune"]);
  });
});
