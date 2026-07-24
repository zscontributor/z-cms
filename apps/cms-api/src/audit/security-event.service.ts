import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { getSystemDb } from "@zcmsorg/database";

/**
 * Security events: things an operator should be able to see, and a few they
 * should be *told* about.
 *
 * Separate from AuditService for two reasons that are not cosmetic:
 *
 *   1. It runs in the AuthGuard, which executes BEFORE the tenant transaction is
 *      opened — there is no `db()` to write through, so it uses the system
 *      client. A denied request never reaches a service, so if it were not
 *      recorded here it would not be recorded anywhere.
 *
 *   2. Some of these events are not "someone did a thing", they are "something is
 *      wrong". A revoked token being replayed means a stolen credential is in
 *      active use. Writing that to a table nobody reads is not a security control.
 *      ALERTING events are pushed to a webhook and logged at error level.
 *
 * `record()` is fire-and-forget by design: an audit failure must never turn a
 * 403 into a 500, and an alert webhook being down must never block a request.
 */

/** Events that warrant waking someone up, not just a row in a table. */
const ALERTING = new Set([
  // A stolen refresh token was replayed, and we killed the family in response.
  "auth.session_theft_detected",
  // An access token from a revoked session is still being used — the holder has
  // not noticed, or does not care, that the session was ended.
  "auth.revoked_token_used",
  // A package tripped the malware scanner and is sitting in quarantine.
  "package.quarantined",
  // A background job exhausted its retries.
  "job.dead_lettered",
  // Code already running on live sites has been pulled. By definition an incident.
  "package.revoked",
]);

@Injectable()
export class SecurityEventService {
  private readonly logger = new Logger(SecurityEventService.name);

  constructor(private readonly config: ConfigService) {}

  /**
   * Records a security event. Never awaited by the caller, never throws.
   */
  record(action: string, details: Record<string, unknown>): void {
    void this.write(action, details).catch((err: Error) =>
      this.logger.error(`Security event "${action}" not recorded: ${err.message}`),
    );
  }

  private async write(action: string, details: Record<string, unknown>): Promise<void> {
    const tenantId = typeof details.tenantId === "string" ? details.tenantId : null;

    if (tenantId) {
      await getSystemDb().auditLog.create({
        data: {
          tenantId,
          siteId: typeof details.siteId === "string" ? details.siteId : null,
          actorId: typeof details.userId === "string" ? details.userId : null,
          action,
          resourceType: "security",
          resourceId: null,
          metadata: details as never,
          ip: typeof details.ip === "string" ? details.ip : null,
        },
      });
    }

    if (ALERTING.has(action)) {
      // Loud in the log regardless of whether a webhook is configured — an
      // operator reading logs must not have to also configure something to learn
      // that a stolen session is in use.
      this.logger.error(`SECURITY: ${action} ${JSON.stringify(details)}`);
      await this.alert(action, details);
    } else {
      this.logger.warn(`${action} ${JSON.stringify(details)}`);
    }
  }

  /**
   * Pushes an alert to whatever the operator has configured.
   *
   * A single generic webhook rather than an integration per vendor: every
   * incident tool on earth accepts a JSON POST, and a CMS has no business
   * shipping a Slack client.
   */
  private async alert(action: string, details: Record<string, unknown>): Promise<void> {
    const url = this.config.get<string>("SECURITY_ALERT_WEBHOOK");
    if (!url) return;

    try {
      await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          event: action,
          severity: "high",
          at: new Date().toISOString(),
          details,
        }),
        signal: AbortSignal.timeout(3000),
      });
    } catch (err) {
      this.logger.error(
        `Security alert webhook failed for "${action}": ${(err as Error).message}`,
      );
    }
  }
}
