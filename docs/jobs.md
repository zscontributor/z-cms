# Background jobs

Slow, heavy, or retry-worthy work runs in a separate **worker** process, off the
API's request path, on a **BullMQ** queue backed by Redis.

## Why a queue, and why a separate process

Resizing a 20MB photo into three sizes is a few hundred milliseconds of CPU. Doing
it inline would hold the upload's HTTP response open for no reason — the caller
already has what they asked for, the original. So the upload returns immediately
and the worker generates the derivatives a moment later.

A separate process, not a thread inside cms-api, because the two have opposite
shapes: the API wants many short, latency-sensitive requests; the worker wants a
few long, CPU-bound tasks. Running image processing on the API's event loop
starves exactly the requests that must stay fast. The worker also scales and
restarts on its own.

**BullMQ, not Redis Pub/Sub.** Pub/Sub is at-most-once: a subscriber that is
offline when a message is published never sees it. "Generate the thumbnails"
silently not happening because the worker was mid-restart is the failure a queue
exists to prevent. BullMQ persists the job, retries it with backoff, and keeps a
failed set for inspection.

```
cms-api ──enqueue──►  Redis (BullMQ)  ──►  apps/worker
                                            ├── media.variants    (sharp → S3 → DB)
                                            ├── site.sitemap      (content → S3)
                                            ├── mail.send        → back to cms-api → SMTP
                                            ├── plugin.deferred  → back to cms-api → sandbox
                        the worker's own    ├── marketplace.sync → back to cms-api → revocations
                        clock, hourly and   ├── media.sweep       (orphaned objects)
                        nightly ───────────►└── sessions.prune    (expired refresh tokens)
```

## Jobs

Seven of them. Four are produced by cms-api in response to something a person did;
three the worker schedules for itself.

| Job | Producer | What it does |
| --- | --- | --- |
| `media.variants` | media upload | thumb (200²), medium (800w), large (1600w), all WebP; writes them to S3 and records them on the media row |
| `site.sitemap` | publish / unpublish / delete | rebuilds `sitemap.xml` from published content |
| `mail.send` | a plugin's `ctx.mail.send()`, or the CMS itself | delivers one email through the site's SMTP server, with retries |
| `plugin.deferred` | a plugin's `ctx.jobs.enqueue()` | re-invokes the plugin in the sandbox, later |
| `marketplace.sync` | the worker's clock, hourly at `:07` | pulls the signed revocation list and quarantines anything that was pulled — **the kill switch**, not housekeeping |
| `media.sweep` | nightly, `03:45` | deletes storage objects no media row points at, and only if they are over 24 hours old |
| `sessions.prune` | nightly, `03:15` | drops expired and revoked refresh tokens after a 30-day grace |

Retries are one policy, set once in `@zcmsorg/queue`: **3 attempts, exponential backoff
from 2 seconds.** Completed jobs are dropped after an hour, failed ones after a day —
which matters, and the dead-letter section below says why.

Job payloads are typed once in `@zcmsorg/queue` and shared by the producer (cms-api)
and the consumer (worker), so the two cannot disagree about a job's shape.

## The worker holds credentials — and that is the line

Unlike plugin-runtime, the worker is **first-party infrastructure**, so it *does*
hold S3 and database credentials: `media.variants` has to read the original and
write the derivatives. The rule is not "no process has credentials" — it is **our
own workers are trusted, third-party plugin code is not**.

Which is exactly why `plugin.deferred` does not run plugin code in the worker.

And it is why `mail.send` does not open the SMTP connection there either — though
for a narrower reason, since the worker is trusted. The mail credential is
encrypted under `MAIL_ENCRYPTION_KEY`, and that key is held by **cms-api alone**.
Handing it to a second process to save one HTTP hop would double the number of
places a leak can happen, to buy nothing: the worker's actual job here is to
*remember* the email and *retry* it, and it can do both without ever being able to
read the password. So `mail.send` posts to an internal cms-api endpoint, exactly
as `plugin.deferred` does — same shape, same reason, different secret.

Why a queue at all, rather than sending inline: SMTP takes seconds and can hang
for a minute, while a plugin hook gets five seconds and a page render gets less.
And a mail server that refuses right now usually accepts ten minutes later — so a
send has to be *retryable*, which means it has to be durable, which means it is a
job. The one send that is **not** queued is the "send a test" button in Settings →
Mail: an operator needs the mail server's own refusal (`535 authentication
failed`), not a job id and an invitation to check the logs.

## Deferred plugin jobs run in the sandbox, not the worker

A plugin calls `ctx.jobs.enqueue("recheck-all", {...})`. That is the only way a
plugin gets to do work later — it cannot set a timer or hold a connection open;
it asks the platform to call it back.

The path is deliberately long:

```
plugin (sandbox)  ──ctx.jobs.enqueue──►  gateway  ──►  BullMQ
                                                          │
worker  ◄─────────────────────────────────────────────────┘
   │  holds credentials, but NO sandbox and NO plugin code
   └──POST /plugin-gateway/run-job──►  cms-api
                                         └── mints scoped token, dispatches
                                             into the isolated-vm sandbox
                                             (plugin's jobs["recheck-all"] runs here)
```

The worker never executes the plugin. It calls an internal cms-api endpoint,
which runs the plugin's job handler in the same V8 isolate, under the same scoped
token, as any live hook. A deferred job therefore grants a plugin **nothing** a
live hook did not already have — it is the same sandbox, the same scopes, just
later and durable.

Verified end to end: enqueue `plugin.deferred` → worker consumes it
(`✓ plugin.deferred in 130ms`) → cms-api dispatches to the sandbox → the SEO
plugin's `recheck-all` runs, reads content through `ctx.content.list` (its
granted `content:read` scope) and writes audit rows through `ctx.storage.set`.
The worker log shows the job; the sandbox log shows the run. Two processes, one
trust boundary intact.

## Timeouts

The sandbox gives a `job` handler 30s, against 5s for an action and 800ms for a
filter: a deferred job is off the request path, so it can afford a real sweep.

**In practice the ceiling is 12 seconds, not 30.** cms-api aborts its call to
plugin-runtime at 12s for every invocation kind, and the worker aborts its call to
cms-api at 15s, so a job that runs longer dies on the network backstop rather than on
its own deadline. That is a bug, not a design — it is written down in
[architecture.md](./architecture.md#what-we-still-owe-plainly). Until it is fixed,
write deferred jobs that finish inside 12 seconds, or chunk them.

## Running it

```bash
pnpm --filter @zcmsorg/worker dev
```

| Variable | Needed for |
| --- | --- |
| `REDIS_URL` | everything — it is the queue |
| `DATABASE_URL`, `S3_*` | `media.variants`, `media.sweep`, `sessions.prune`, `site.sitemap` |
| `CMS_API_URL` + `CMS_INTERNAL_TOKEN` | every job that calls back into the API: `plugin.deferred`, `mail.send`, `marketplace.sync` |
| `SECURITY_ALERT_WEBHOOK` | dead-letter alerts (optional, but a dead letter with nobody listening is a dead letter that lies) |
| `WORKER_CONCURRENCY` | how many jobs run at once (optional) |

It does **not** need — and must not have — the marketplace public key, the mail
encryption key or the JWT signing keys. That is the point of `marketplace.sync` being
a worker job that posts *back* to cms-api rather than verifying anything itself: the
worker is the clock, not the brain.

## Deduplication is the same trick, four times

Every producer sets a deterministic `jobId`, and BullMQ refuses a duplicate while
the job is still pending. So:

| Job | `jobId` | What it collapses |
| --- | --- | --- |
| `media.variants` | `media-variants-{mediaId}` | a retried upload, a double-fired event |
| `site.sitemap` | `sitemap-{siteId}` (+5s delay) | a burst of publishes → **one** rebuild |
| `plugin.deferred` | `plugin-deferred-{sha256 of plugin, site, name, payload}` | a plugin enqueuing the same work in a loop |
| `mail.send` | `mail-{fingerprint of the message}` | the same email enqueued twice |

(BullMQ forbids `:` in a job id, which is why these read as `media-variants-…` rather
than the `media:variants:…` you might expect.)

Verified: three publishes in a row produce **one** sitemap job, not three.
Regenerating a 50k-URL sitemap once per keystroke would be a self-inflicted load
test.

## A dead letter is an incident

A job that exhausts its three attempts used to land in BullMQ's failed set and stay
there — `media.variants` silently not done means a site with no thumbnails and
nobody the wiser. It now logs at error level and pushes `job.dead_lettered` to
`SECURITY_ALERT_WEBHOOK`. A dead-lettered `mail.send` additionally reports back to
cms-api, so the `mail.failed` event fires and a plugin can react to a message that
never arrived.

**The failed set is not an archive: it is dropped after 24 hours.** `GET /jobs/failed`
shows you the last day, and the webhook alert is the durable record. If nobody is
listening on the webhook, a dead letter that happened on Friday is gone by Monday.

## Scheduled jobs

Three repeatables the worker registers for itself on boot. BullMQ keys a repeatable
on (name, cron), so re-deploying replaces the schedule rather than stacking a
second copy of it.

| Job | When | What it does |
| --- | --- | --- |
| `marketplace.sync` | hourly, at `:07` | pulls the signed revocation list and quarantines revoked packages — see [distribution.md](./distribution.md) |
| `sessions.prune` | 03:15 daily | deletes refresh tokens that can no longer authenticate anything |
| `media.sweep` | 03:45 daily | deletes stored objects no media row points at |

`marketplace.sync` is the one scheduled job that is not housekeeping. It is how a
compromised theme or plugin stops running on your site within the hour, without you
upgrading anything, and it is the reason the worker has a clock at all.

`sessions.prune` keeps a **30-day grace period on revoked rows**, and that is not
housekeeping timidity: a revoked family is *evidence*. It is what a theft
investigation reads. Deleting it the moment it is revoked destroys the only record
that the theft happened.

`media.sweep` is the most dangerous job in the system — a bug in it deletes a
customer's images — so it is deliberately timid:

- only objects under `sites/` are considered;
- an object younger than 24h is never touched (an upload writes the object *before*
  the row exists; without that window the sweep would race a live upload and delete
  a good image seconds after a customer uploaded it);
- it matches originals **and variants**, because a variant key lives in the
  `variants` JSON, not in `storageKey`. Matching only `storageKey` would have
  deleted every thumbnail in the system on the first run.

## The dead-letter queue is operable

A job that exhausts its retries used to be reachable only through `redis-cli`.
That is not "we have retries" — it is "we have a place failures go to be
forgotten".

```
GET    /api/v1/jobs/failed          { items, total } — what died, why, and with
                                    what payload
POST   /api/v1/jobs/failed/:id/retry
DELETE /api/v1/jobs/failed/:id      discard — recorded, because it decides that
                                    work will never be done
```

…and a screen: **`/jobs`** in the admin. Retry, discard, and the failure reason in
full — a stack trace truncated to one line is a stack trace you cannot act on.

`total` is not decoration, and it is why the response is an object rather than an
array. The endpoint returns a page (default 50). A page of 50 rows out of 1,204
failures, rendered without saying so, reads *exactly* like a queue with 50
failures in it — so an operator retries everything they can see and concludes the
queue is drained. The screen says "showing 50 of 1,204" and warns that clearing
the page will not empty the queue. **A dead-letter queue that hides its own size
is a dead-letter queue that lies.**

Gated on `settings:update`: retrying a job re-runs work with the platform's own
credentials, so it is an operator action, not an editor one. Both retry and
discard are audited.

## Current limitation: schedules are code-owned

There is still no per-job scheduling UI or API. The three cron expressions are
fixed in `packages/queue/src/jobs.ts` (`SCHEDULED_JOBS`), and the worker registers
them on boot in `apps/worker/src/main.ts`. The `/jobs` API and admin screen operate
the failed-job queue only; they do not read or update repeatable schedules. Changing
a schedule therefore requires a code change and worker restart, and cannot be done
per instance from the admin UI.
