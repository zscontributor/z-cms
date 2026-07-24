import {
  Body,
  Controller,
  Get,
  Global,
  HttpCode,
  Module,
  Patch,
  Post,
  UseGuards,
} from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import {
  MailSettingsSchema,
  SendTestMailSchema,
  type MailSettingsDto,
} from "@zcmsorg/schemas";
import { z } from "zod";
import { AuditService } from "../audit/audit.module";
import { Actor, Internal, RequirePermissions, SiteId, SiteScoped } from "../auth/decorators";
import { t } from "../common/i18n";
import { RateLimit } from "../common/rate-limit.decorator";
import { RateLimitGuard } from "../common/rate-limit.guard";
import type { RequestActor } from "../common/request-context";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import {
  ApiAuthed,
  ApiInternal,
  ApiSiteScoped,
  ApiZodBody,
  ApiZodResponse,
} from "../openapi/decorators";
import { DeliverMailSchema } from "../openapi/registry";
import { MailSettingsService } from "./mail-settings.service";
import { MailService, type MailSendResult } from "./mail.service";

/**
 * Settings → Mail.
 *
 * Reading the configuration is `settings:read`; writing it is `settings:update`.
 * *Using* it — the test send — is `mail:send`, which is a different question and
 * therefore a different permission: it is the one an admin is asked to grant to a
 * plugin, and the button on this screen is the first thing that proves what
 * granting it means.
 */
@ApiTags("Mail")
@Controller("settings/mail")
@SiteScoped()
@UseGuards(RateLimitGuard)
class MailSettingsController {
  constructor(
    private readonly settings: MailSettingsService,
    private readonly mail: MailService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @ApiOperation({
    summary: "This site's mail configuration",
    description:
      "The SMTP password is never in this response — not masked, not truncated, " +
      "not as a length. `hasPassword` answers the only question the form needs " +
      "to ask. `fromEnv` is true when nothing is saved and these values came " +
      "from SMTP_* in the environment, which is how a dev instance talks to " +
      "Mailpit without anyone configuring anything.",
  })
  @ApiAuthed("settings:read")
  @ApiSiteScoped()
  @ApiZodResponse("MailSettings")
  @RequirePermissions("settings:read")
  read(@SiteId() siteId: string): Promise<MailSettingsDto> {
    return this.settings.read(siteId);
  }

  @Patch()
  @ApiOperation({
    summary: "Save the mail configuration",
    description:
      "`password` is write-only and three-valued: omit it to keep the stored " +
      "one, send `\"\"` to clear it, send a string to replace it. It is encrypted " +
      "with MAIL_ENCRYPTION_KEY before it touches the database. Saving clears " +
      "the last test result — it described the old server.",
  })
  @ApiAuthed("settings:update")
  @ApiSiteScoped()
  @ApiZodBody("MailSettingsInput")
  @ApiZodResponse("MailSettings", { description: "The configuration as it now stands." })
  @RequirePermissions("settings:update")
  async save(
    @Actor() actor: RequestActor,
    @SiteId() siteId: string,
    @Body(new ZodValidationPipe(MailSettingsSchema))
    body: z.infer<typeof MailSettingsSchema>,
  ): Promise<MailSettingsDto> {
    const saved = await this.settings.save(actor.tenantId, siteId, body);

    // The password's VALUE is never recorded, but the fact that someone changed
    // it is exactly what an audit log is for.
    await this.audit.record(actor, "mail.settings.updated", "mail", siteId, {
      host: saved.host,
      port: saved.port,
      enabled: saved.enabled,
      passwordChanged: body.password !== undefined,
    });

    return saved;
  }

  /**
   * The button that turns "I filled in a form" into "this site can send email".
   *
   * Sends inline rather than through the queue, which is the whole point: an
   * operator needs the SMTP server's own refusal ("535 authentication failed"),
   * not a job id and a suggestion to check the logs.
   */
  @Post("test")
  @HttpCode(200)
  @ApiOperation({
    summary: "Send a test email",
    description:
      "Inline, not queued: the caller gets the mail server's own words back. " +
      "The result is stored on the configuration so the screen can keep showing " +
      "whether this site is known to work.",
  })
  @ApiAuthed("mail:send")
  @ApiSiteScoped()
  @ApiZodBody("SendTestMailInput")
  @ApiZodResponse("MailTestResult", {
    description: "`ok: false` carries the SMTP server's error. The request was fine; the mail server was not.",
  })
  @RateLimit({ by: "ip", points: 10, windowSec: 300 })
  @RequirePermissions("mail:send")
  async test(
    @Actor() actor: RequestActor,
    @SiteId() siteId: string,
    @Body(new ZodValidationPipe(SendTestMailSchema))
    body: z.infer<typeof SendTestMailSchema>,
  ): Promise<{ ok: boolean; error?: string }> {
    const tt = t();
    let error: string | null = null;

    try {
      const result = await this.mail.deliver(
        actor.tenantId,
        siteId,
        {
          to: [body.to],
          subject: tt("mail.test.subject"),
          text: tt("mail.test.body"),
        },
        null,
      );
      if (result.cancelled) error = tt("errors.mail.cancelledByPlugin");
    } catch (err) {
      error = (err as Error).message;
    }

    await this.settings.recordTest(siteId, error);
    await this.audit.record(actor, "mail.test.sent", "mail", siteId, {
      to: body.to,
      ok: !error,
    });

    return error ? { ok: false, error } : { ok: true };
  }
}

/**
 * The worker's door.
 *
 * SMTP is slow and fails transiently, so a send is a queued job — but the worker
 * does not open the connection. It holds no MAIL_ENCRYPTION_KEY and no mail
 * configuration, and it calls back in here, exactly as it does for a plugin's
 * deferred job. cms-api owns the credential and the transport; the worker owns
 * remembering and retrying. Neither grows the other's privileges.
 */
@ApiTags("Mail")
@Controller("mail")
class MailDeliveryController {
  constructor(private readonly mail: MailService) {}

  @Internal()
  @Post("deliver")
  @HttpCode(200)
  @ApiOperation({
    summary: "Deliver a queued email",
    description:
      "Called by the worker, never by a user. Internal-token guarded because the " +
      "body names any tenant and site it likes — only our own worker may. A 5xx " +
      "here is what makes BullMQ retry the send.",
  })
  @ApiInternal()
  @ApiZodBody("DeliverMailInput")
  @ApiZodResponse("MailTestResult", { description: "Accepted by the SMTP server, or cancelled by a filter." })
  deliver(
    // Re-validated here even though MailService.enqueue already parsed it. This
    // body arrives from a durable queue: it was written by one deployment and is
    // read by the next, and a payload the current build cannot honour should be a
    // 400 that dead-letters, not a malformed envelope handed to an SMTP server.
    @Body(new ZodValidationPipe(DeliverMailSchema))
    body: z.infer<typeof DeliverMailSchema>,
  ): Promise<MailSendResult> {
    // Throws on an SMTP failure, which answers 500 and makes the worker retry.
    // That is the intended contract — a bad gateway is not a bad request.
    return this.mail.deliver(body.tenantId, body.siteId, body.message, body.pluginKey);
  }

  @Internal()
  @Post("dead-letter")
  @HttpCode(200)
  @ApiOperation({
    summary: "Report a send that will never happen",
    description:
      "The worker calls this when a `mail.send` job exhausts its retries. It is " +
      "what fires the `mail.failed` plugin action — dispatched from here because " +
      "only cms-api may run plugin code, and fired only on the FINAL failure " +
      "because an event that cried wolf on attempt one of three would teach every " +
      "plugin to ignore it.",
  })
  @ApiInternal()
  @ApiZodBody("DeliverMailInput")
  @ApiZodResponse("Ok")
  async deadLetter(
    @Body(new ZodValidationPipe(DeliverMailSchema))
    body: z.infer<typeof DeliverMailSchema>,
  ): Promise<{ ok: true }> {
    await this.mail.recordFailure(
      body.tenantId,
      body.siteId,
      body.message,
      body.pluginKey,
      body.error ?? "Delivery failed.",
    );
    return { ok: true };
  }
}

/**
 * Global, because the plugin gateway needs `MailService` and lives in
 * PluginsModule. The dependency runs one way — mail reaches for plugins (to fire
 * the `mail.sending` filter), the gateway reaches for mail (to queue a send) —
 * and PluginsService knows nothing of mail, so there is no cycle.
 */
@Global()
@Module({
  controllers: [MailSettingsController, MailDeliveryController],
  providers: [MailService, MailSettingsService],
  exports: [MailService, MailSettingsService],
})
export class MailModule {}
