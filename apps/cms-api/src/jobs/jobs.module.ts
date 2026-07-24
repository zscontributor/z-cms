import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Module,
  NotFoundException,
  Param,
  Post,
  Query,
} from "@nestjs/common";
import { ApiOperation, ApiParam, ApiQuery, ApiTags } from "@nestjs/swagger";
import type { FailedJobPage } from "@zcmsorg/queue";
import { Actor, RequirePermissions } from "../auth/decorators";
import { AuditService } from "../audit/audit.module";
import {
  ApiAuthed,
  ApiNoContent,
  ApiNotFound,
  ApiZodResponse,
} from "../openapi/decorators";
import type { RequestActor } from "../common/request-context";
import { QueueService } from "../queue/queue.module";

/**
 * The dead-letter queue, made operable.
 *
 * A job that exhausts its retries used to land in BullMQ's failed set, where the
 * only way to act on it was `redis-cli`. That is not "we have retries" — it is "we
 * have a place failures go to be forgotten". `media.variants` silently dead means
 * a site whose images have no thumbnails, and nobody would know.
 *
 * Gated on `settings:update` (ADMIN and above): retrying a job re-runs work with
 * the platform's own credentials, so it is an operator action, not an editor one.
 */
@ApiTags("Jobs")
@Controller("jobs")
class JobsController {
  constructor(
    private readonly queue: QueueService,
    private readonly audit: AuditService,
  ) {}

  @Get("failed")
  @ApiOperation({
    summary: "The dead-letter queue",
    description:
      "Jobs that exhausted their retries, with the reason each one gave. " +
      "`total` counts the whole queue, not the page — a truncated list that " +
      "looked complete would be worse than no list.",
  })
  @ApiAuthed("settings:update")
  @ApiQuery({
    name: "limit",
    required: false,
    description: "Clamped to 200.",
    schema: { type: "integer", minimum: 1, maximum: 200, default: 50 },
  })
  @ApiZodResponse("FailedJobPage")
  @RequirePermissions("settings:update")
  failed(@Query("limit") limit = "50"): Promise<FailedJobPage> {
    return this.queue.failedJobs(Math.min(200, Math.max(1, Number(limit) || 50)));
  }

  @Post("failed/:id/retry")
  @HttpCode(200)
  @ApiOperation({
    summary: "Re-run a failed job",
    description:
      "An operator action, not an editor one: the job re-runs with the " +
      "platform's own credentials. Recorded in the audit log.",
  })
  @ApiParam({ name: "id", description: "BullMQ job id, from the dead-letter list." })
  @ApiAuthed("settings:update")
  @ApiZodResponse("Ok", { description: "Requeued." })
  @ApiNotFound("No failed job with that id.")
  @RequirePermissions("settings:update")
  async retry(
    @Actor() actor: RequestActor,
    @Param("id") id: string,
  ): Promise<{ ok: true }> {
    const ok = await this.queue.retryJob(id);
    if (!ok) throw new NotFoundException(`No failed job "${id}".`);

    await this.audit.record(actor, "job.retried", "job", id, {});
    return { ok: true };
  }

  @Delete("failed/:id")
  @HttpCode(204)
  @ApiOperation({
    summary: "Discard a failed job",
    description:
      "Deciding that this work will never be done. Irreversible, and audited " +
      "for exactly that reason.",
  })
  @ApiParam({ name: "id", description: "BullMQ job id, from the dead-letter list." })
  @ApiAuthed("settings:update")
  @ApiNoContent("Discarded.")
  @ApiNotFound("No failed job with that id.")
  @RequirePermissions("settings:update")
  async discard(
    @Actor() actor: RequestActor,
    @Param("id") id: string,
  ): Promise<void> {
    const ok = await this.queue.discardJob(id);
    if (!ok) throw new NotFoundException(`No failed job "${id}".`);

    // Discarding a job is deciding that work will never be done. Recorded.
    await this.audit.record(actor, "job.discarded", "job", id, {});
  }
}

@Module({ controllers: [JobsController] })
export class JobsModule {}
