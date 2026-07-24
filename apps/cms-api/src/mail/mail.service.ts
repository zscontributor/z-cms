import { BadRequestException, Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { MailMessageSchema, type MailMessage } from "@zcmsorg/schemas";
import type { JobPayloads } from "@zcmsorg/queue";
import Redis from "ioredis";
import { createHash } from "node:crypto";
import { createTransport } from "nodemailer";
import { t } from "../common/i18n";
import { PluginsService } from "../plugins/plugins.service";
import { QueueService } from "../queue/queue.module";
import { MailSettingsService } from "./mail-settings.service";

type QueuedMessage = JobPayloads["mail.send"]["message"];

export interface MailSendResult {
  ok: boolean;
  /** The SMTP server's accept id, when it gave one. */
  messageId?: string;
  /** True when a `mail.sending` filter cancelled the delivery. Not a failure. */
  cancelled?: boolean;
  error?: string;
}

/**
 * How many emails one site may send per hour on behalf of its plugins.
 *
 * The cap exists because giving a marketplace plugin an SMTP server is, stated
 * plainly, giving third-party code a spam cannon pointed at the operator's domain
 * reputation. The scope prompt tells the admin about it; this makes the worst case
 * survivable when they click yes on something they should not have.
 *
 * It does not apply to the CMS's own mail (an invite, a password reset). Those are
 * a human's action, and rate-limiting them would break the product to defend
 * against the wrong thing.
 */
const DEFAULT_PLUGIN_HOURLY_LIMIT = 200;
const HOUR_SECONDS = 3_600;

@Injectable()
export class MailService implements OnModuleDestroy {
  private readonly logger = new Logger(MailService.name);
  private readonly redis: Redis;
  private readonly pluginHourlyLimit: number;

  constructor(
    private readonly config: ConfigService,
    private readonly settings: MailSettingsService,
    private readonly queue: QueueService,
    private readonly plugins: PluginsService,
  ) {
    this.redis = new Redis(config.get<string>("REDIS_URL") ?? "redis://localhost:6379", {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      lazyConnect: false,
    });
    this.redis.on("error", (err) => this.logger.warn(`Redis: ${err.message}`));
    this.pluginHourlyLimit =
      Number(config.get("MAIL_PLUGIN_HOURLY_LIMIT")) || DEFAULT_PLUGIN_HOURLY_LIMIT;
  }

  /**
   * Accepts a message onto the queue. The plugin gateway's entry point.
   *
   * Validation happens HERE, not in the sandbox and not in the worker. The
   * sandbox's copy of the SDK is a shim a plugin could have replaced, and the
   * worker is downstream of a durable queue — a malformed message that reaches it
   * is a poison job that retries three times and dead-letters. The one place that
   * can refuse it while someone is still listening is this one.
   */
  async enqueue(
    tenantId: string,
    siteId: string,
    pluginKey: string | null,
    raw: unknown,
  ): Promise<{ queued: true }> {
    const parsed = MailMessageSchema.safeParse(raw);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "message"}: ${issue.message}`)
        .join("; ");
      throw new BadRequestException(t()("errors.mail.invalidMessage", { detail }));
    }
    const message = parsed.data;

    if (pluginKey) await this.consumeQuota(siteId, pluginKey, message);

    // Deduplicated on (site, sender, content), exactly like a deferred job. A hook
    // that fires twice on one publish — or a plugin that loops — collapses into a
    // single delivery, because BullMQ refuses a duplicate jobId while the job is
    // still pending. Once it has been sent and reaped, the same message may be
    // sent again, which is what a legitimate repeat ("your order shipped") needs.
    const fingerprint = createHash("sha256")
      .update(`${siteId}|${pluginKey ?? "cms"}|${JSON.stringify(message)}`)
      .digest("hex")
      .slice(0, 32);

    await this.queue.enqueue(
      "mail.send",
      { tenantId, siteId, message: toQueued(message), pluginKey },
      { jobId: `mail-${fingerprint}` },
    );

    return { queued: true };
  }

  /**
   * Sends one message, now. Called by the worker (via the internal endpoint) and
   * by the settings screen's "send a test".
   *
   * Throws on an SMTP failure rather than returning it, so the queued path retries
   * with backoff and the interactive path shows the operator what the mail server
   * actually said. A refusal from the server is the single most useful thing a
   * person configuring SMTP can be shown, and swallowing it into a generic "could
   * not send" is why mail configuration has the reputation it does.
   */
  async deliver(
    tenantId: string,
    siteId: string,
    message: MailMessage,
    pluginKey: string | null,
  ): Promise<MailSendResult> {
    const config = await this.settings.resolve(tenantId, siteId);
    if (!config) throw new BadRequestException(t()("errors.mail.notConfigured"));

    // The plugins' one chance to touch the letter: append a footer, wrap the html
    // in the site's template, tag the subject — or refuse the send outright. It
    // deliberately cannot readdress the mail; `to` is in the context, not the value.
    const filtered = await this.plugins.applyFilter(
      tenantId,
      siteId,
      "mail.sending",
      {
        subject: message.subject,
        text: message.text,
        html: message.html,
        replyTo: message.replyTo,
        send: true,
      },
      { siteId, pluginKey, to: message.to },
    );

    if (filtered.send === false) {
      this.logger.log(`Mail to ${message.to.join(", ")} cancelled by a mail.sending filter.`);
      return { ok: true, cancelled: true };
    }

    const transport = createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      ...(config.auth ? { auth: config.auth } : {}),
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 30_000,
    });

    try {
      const info = await transport.sendMail({
        // From the site's configuration, never from the caller. This line is the
        // reason a plugin cannot send as billing@your-domain.
        from: { name: config.from.name, address: config.from.address },
        to: message.to,
        cc: message.cc,
        bcc: message.bcc,
        replyTo: filtered.replyTo ?? message.replyTo ?? config.replyTo ?? undefined,
        subject: filtered.subject,
        text: filtered.text,
        html: filtered.html,
      });

      const messageId = typeof info.messageId === "string" ? info.messageId : null;

      void this.plugins.dispatchAction(tenantId, siteId, "mail.sent", {
        siteId,
        pluginKey,
        to: message.to,
        subject: filtered.subject,
        messageId,
        sentAt: new Date().toISOString(),
      });

      return { ok: true, messageId: messageId ?? undefined };
    } finally {
      transport.close();
    }
  }

  /**
   * The mail is not going to be delivered — the queue has given up on it.
   *
   * Split from `deliver` because only the worker knows that a failure was the
   * final one, and a `mail.failed` fired on the first of three attempts would
   * teach every plugin to distrust the event.
   */
  async recordFailure(
    tenantId: string,
    siteId: string,
    message: QueuedMessage,
    pluginKey: string | null,
    error: string,
  ): Promise<void> {
    this.logger.error(
      `Mail to ${message.to.join(", ")} failed permanently (${pluginKey ?? "cms"}): ${error}`,
    );

    await this.plugins.dispatchAction(tenantId, siteId, "mail.failed", {
      siteId,
      pluginKey,
      to: message.to,
      subject: message.subject,
      error,
      failedAt: new Date().toISOString(),
    });
  }

  /**
   * Charges one send against the site's hourly plugin budget.
   *
   * Counted per site rather than per plugin on purpose: the resource being
   * protected is the site's sending reputation, and three plugins sending 199
   * emails each would ruin it just as thoroughly as one plugin sending 597.
   *
   * Fails CLOSED, unlike the login limiter. If Redis is unreachable we cannot
   * count, and an uncounted send is the exact thing this exists to prevent —
   * "the cache blinked" is a bad reason to let a plugin mail a mailing list an
   * unbounded number of times. The CMS's own mail is not subject to this and
   * keeps working, so a Redis outage does not cost anyone their password reset.
   */
  private async consumeQuota(
    siteId: string,
    pluginKey: string,
    message: MailMessage,
  ): Promise<void> {
    const key = `mail:quota:${siteId}`;
    const recipients = message.to.length + (message.cc?.length ?? 0) + (message.bcc?.length ?? 0);

    try {
      const used = await this.redis.incrby(key, recipients);
      if (used === recipients) await this.redis.expire(key, HOUR_SECONDS);

      if (used > this.pluginHourlyLimit) {
        const ttl = await this.redis.ttl(key);
        this.logger.warn(
          `Site ${siteId} hit the plugin mail quota (${this.pluginHourlyLimit}/h); ` +
            `${pluginKey} was refused.`,
        );
        throw new BadRequestException(
          t()("errors.mail.quotaExceeded", {
            limit: String(this.pluginHourlyLimit),
            retryAfterSec: String(ttl > 0 ? ttl : HOUR_SECONDS),
          }),
        );
      }
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      this.logger.error(`Mail quota check failed for site ${siteId}: ${(err as Error).message}`);
      throw new BadRequestException(t()("errors.mail.quotaUnavailable"));
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis.quit();
  }
}

/** Zod normalised `to` into an array; the job payload is plain JSON. */
function toQueued(message: MailMessage): QueuedMessage {
  return {
    to: message.to,
    cc: message.cc,
    bcc: message.bcc,
    subject: message.subject,
    text: message.text,
    html: message.html,
    replyTo: message.replyTo,
  };
}
