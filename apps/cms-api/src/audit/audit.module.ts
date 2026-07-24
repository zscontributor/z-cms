import { Global, Injectable, Logger, Module } from "@nestjs/common";
import { db } from "@zcmsorg/database";
import type { RequestActor } from "../common/request-context";
import { SecurityEventService } from "./security-event.service";

/**
 * The record of who changed what.
 *
 * `audit_logs` existed from the first migration and was written for exactly three
 * things — plugin installs, plugin gateway jobs, package publishes — which meant
 * the one question an operator actually asks after an incident ("who deleted the
 * homepage?") had no answer. This service closes that: every mutation that
 * changes what a site *is* now leaves a row.
 *
 * Two deliberate properties:
 *
 *   - The write happens INSIDE the request's tenant transaction. If the operation
 *     rolls back, so does its audit row — the log records what happened, not what
 *     was attempted. Failed authorisation is a different concern and belongs in
 *     the application log, not here.
 *
 *   - A failure to audit never fails the request. An operator losing one log line
 *     is bad; an editor unable to publish because the audit table is wedged is
 *     worse. The failure is logged loudly instead.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  async record(
    actor: RequestActor,
    action: string,
    resourceType: string,
    resourceId: string | null,
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    try {
      await db().auditLog.create({
        data: {
          tenantId: actor.tenantId,
          siteId: actor.siteId ?? null,
          actorId: actor.userId,
          action,
          resourceType,
          resourceId,
          metadata: metadata as never,
        },
      });
    } catch (err) {
      this.logger.error(
        `Audit write failed for ${action} ${resourceType}/${resourceId}: ${(err as Error).message}`,
      );
    }
  }
}

@Global()
@Module({
  providers: [AuditService, SecurityEventService],
  exports: [AuditService, SecurityEventService],
})
export class AuditModule {}
