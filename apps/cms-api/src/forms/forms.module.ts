import { Body, Controller, HttpCode, Module, Param, Post, Query, UseGuards } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { Internal } from "../auth/decorators";
import { RateLimit } from "../common/rate-limit.decorator";
import { RateLimitGuard } from "../common/rate-limit.guard";
import { ApiInternal } from "../openapi/decorators";
import { FormsService } from "./forms.service";

/**
 * The generic public-form submit endpoint.
 *
 * `@Internal("render")` because site-runtime is the only caller — a visitor's
 * browser posts same-origin to a runtime route which forwards here with the render
 * token, exactly like the contact and AI endpoints. The form is resolved by id
 * from the site's installed plugin manifests; nothing about the handler or its
 * effects is taken from the request. Per-IP rate-limited: a public write door.
 */
@ApiTags("Forms")
@Controller("forms")
@UseGuards(RateLimitGuard)
export class FormsController {
  constructor(private readonly forms: FormsService) {}

  @Internal("render")
  @Post(":formId/submit")
  @HttpCode(200)
  @ApiOperation({
    summary: "Submit a plugin-declared public form",
    description:
      "Called by site-runtime, never directly. The site comes from `hostname`, " +
      "the form (and which plugin owns it) from the installed manifests; the " +
      "values are validated against the form's declared fields and dispatched to " +
      "the plugin's `forms.submit` handler in the sandbox. Rate-limited per IP.",
  })
  @ApiInternal()
  @RateLimit({ by: "ip", points: 10, windowSec: 60 })
  submit(
    @Param("formId") formId: string,
    @Query("hostname") hostname: string,
    @Body() body: unknown,
  ): Promise<{ ok: boolean }> {
    return this.forms.submit(hostname, formId, body);
  }
}

@Module({
  controllers: [FormsController],
  providers: [FormsService],
})
export class FormsModule {}
