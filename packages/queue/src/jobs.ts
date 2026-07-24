/**
 * The job vocabulary — one typed payload per job, shared by the producer
 * (cms-api) and the consumer (apps/worker) so the two cannot disagree about the
 * shape of a job.
 *
 * The set is deliberately small and closed. A background queue is a way to run
 * code later; if a plugin could name an arbitrary job, the queue would be an
 * arbitrary-code channel. It is not — see `plugin.deferred`.
 */

/**
 * The queue's name and key prefix, both namespaced to this application.
 *
 * zsoft05 runs several stacks side by side and more than one of them speaks BullMQ. Two
 * apps sharing a Redis keyspace do not collide loudly — that is the whole problem. Both
 * workers are subscribed to the same `bull:<queue>:*` keys, so they simply take turns
 * consuming each other's jobs: ours would receive a payload it has no handler for and
 * throw "No handler for job", theirs would receive one of ours and fail to parse it.
 * Nobody's work runs, and no log says why.
 *
 * The PREFIX is the guard that survives everything else going wrong — a shared Redis, an
 * infrastructure consolidation, a swarm DNS mix-up pointing us at the wrong instance. It
 * moves every key this app owns under `zcms-app:`, so two BullMQ apps on one Redis simply
 * never see each other's keys. The queue name is namespaced too, belt and braces, because
 * a prefix is one config line away from being lost in a refactor and the name is what
 * shows up in every dashboard.
 *
 * The marketplace, on the same node, uses prefix `zcms-mkt` and queue `mkt-mail`. The two
 * keyspaces cannot touch.
 */
export const QUEUE_PREFIX = "zcms-app";
export const QUEUE_NAME = "zcms-jobs";

export interface JobPayloads {
  /**
   * Generate derivative images for an uploaded media object, then record them.
   * First-party work: the worker holds S3 + DB credentials to do it.
   */
  "media.variants": {
    tenantId: string;
    siteId: string;
    mediaId: string;
    storageKey: string;
    mimeType: string;
  };

  /**
   * A plugin asked to defer work via `ctx.jobs.enqueue(name, payload)`.
   *
   * The worker does NOT run the plugin here — it holds no sandbox and no plugin
   * code. It calls back into cms-api, which runs the plugin's `job` handler in
   * the isolated-vm sandbox under the same scoped token as any other invocation.
   * So a deferred job grants a plugin nothing a live hook did not already have:
   * it is the same sandbox, later.
   */
  "plugin.deferred": {
    tenantId: string;
    siteId: string;
    pluginKey: string;
    /** The handler name the plugin passed to ctx.jobs.enqueue. */
    name: string;
    payload: Record<string, unknown>;
  };

  /** Rebuild a site's sitemap.xml after a publish. First-party. */
  "site.sitemap": {
    tenantId: string;
    siteId: string;
  };

  /**
   * Turn a drawing from the GUI Theme Editor into a built, signed theme package.
   *
   * A job rather than a request, because it is the one thing in this system that
   * genuinely takes seconds: it writes a theme's source, runs esbuild over it, and
   * packs and signs the result. An HTTP handler doing that would hold a connection
   * open through a bundle, and a bundle is not something to retry inside a request.
   *
   * The payload is IDs, not the document — the same shape as `media.variants`, and
   * for the same reason. A LayoutDocument is the whole design; putting it in the
   * job would put a copy of it in Redis, and the copy would be stale the moment
   * somebody saved again. The worker reads the row it is told about, so it always
   * builds what the draft says NOW.
   */
  "theme.build": {
    tenantId: string;
    siteId: string;
    draftId: string;
    /**
     * Who pressed Build. Carried because the worker installs the result through
     * cms-api's sideload gate, which writes an audit log — and "a theme appeared"
     * with nobody's name on it is the entry nobody can act on.
     */
    actorId: string;
  };

  /**
   * Deliver one email through the site's own SMTP server.
   *
   * Queued rather than sent inline, for two reasons that are really the same one.
   * An SMTP conversation takes seconds and can hang for a minute; a plugin hook
   * gets five seconds and a page render gets less. And a mail server that is down
   * right now is usually up in ten minutes — so a send has to be *retryable*,
   * which means it has to be durable, which means it is a job.
   *
   * The worker does NOT hold the SMTP credentials and does not open the
   * connection. Like `plugin.deferred`, it calls back into cms-api, which owns
   * the mail configuration and the key that decrypts it. The worker's role is to
   * be the thing that remembers, and retries.
   */
  "mail.send": {
    tenantId: string;
    siteId: string;
    message: {
      to: string[];
      cc?: string[];
      bcc?: string[];
      subject: string;
      text?: string;
      html?: string;
      replyTo?: string;
    };
    /** The plugin that asked. Null when the CMS itself is the sender. */
    pluginKey: string | null;
  };

  /**
   * Deletes refresh tokens that can no longer authenticate anything.
   *
   * The table only ever grew: every login added a row, every rotation added
   * another, and nothing removed them. A busy instance accumulates millions of
   * dead rows on the table the auth hot path queries. Scheduled, not triggered —
   * it is hygiene, not a reaction to anything.
   */
  "sessions.prune": Record<string, never>;

  /**
   * Deletes stored objects that no media row points at.
   *
   * `media.remove` deletes the row and deliberately leaves the object: a broken
   * image on a live page is worse than an orphaned blob. That trade is only
   * defensible if something eventually collects them — this is that something.
   */
  "media.sweep": Record<string, never>;

  /**
   * Pulls the marketplace's signed revocation list and enforces it locally.
   *
   * The ONLY channel that reaches a package which is already installed and
   * already running. Revoking on the marketplace stops new downloads; it does
   * nothing to the thousand instances that installed the package last month
   * unless one of them asks — so every instance asks, hourly.
   *
   * Hourly, not daily, and that is the whole difference between a kill switch
   * and a note: the window between "we know this plugin is malicious" and "it
   * stops executing on a customer's site" is exactly this interval.
   */
  "marketplace.sync": Record<string, never>;
}

export type JobName = keyof JobPayloads;

export const JOB_NAMES = [
  "media.variants",
  "plugin.deferred",
  "site.sitemap",
  "theme.build",
  "mail.send",
  "sessions.prune",
  "media.sweep",
  "marketplace.sync",
] as const satisfies readonly JobName[];

/**
 * Jobs the worker schedules for itself on boot, as BullMQ repeatables.
 *
 * Registered by name + cron, so re-deploying does not queue a second copy: BullMQ
 * keys a repeatable on (name, cron) and replaces rather than duplicates.
 */
export const SCHEDULED_JOBS = [
  // 03:15 daily — after the traffic trough, before the backup window.
  { name: "sessions.prune" as const, cron: "15 3 * * *" },
  // 03:45 daily. Deliberately AFTER the prune, so the two never contend.
  { name: "media.sweep" as const, cron: "45 3 * * *" },
  // Hourly, at :07 — off the hour, so ten thousand self-hosted instances do not
  // all ask the marketplace the same question at the same second.
  //
  // The other two jobs here are housekeeping and run once a night. This one is a
  // safety mechanism, and its period IS the worst-case exposure: an hour is how
  // long a revoked package can keep executing on a site that has already been
  // told, by someone, that it is dangerous.
  { name: "marketplace.sync" as const, cron: "7 * * * *" },
] satisfies readonly { name: JobName; cron: string }[];
