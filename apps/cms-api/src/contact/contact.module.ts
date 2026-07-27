import { Body, Controller, HttpCode, Module, Post, Query, UseGuards } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { Internal } from "../auth/decorators";
import { RateLimit } from "../common/rate-limit.decorator";
import { RateLimitGuard } from "../common/rate-limit.guard";
import { ApiInternal } from "../openapi/decorators";
import { ContactService } from "./contact.service";

/**
 * A theme's contact form, delivered as email.
 *
 * `@Internal("render")` because site-runtime is the only caller: a visitor's
 * browser POSTs to a same-origin route there, which forwards here with the render
 * token. The token site-runtime holds cannot reach `/mail/deliver` — this is the
 * one mail-adjacent door it is allowed through, and it is a narrow one: the
 * recipient is the site's own address (chosen here, never sent), and a per-IP rate
 * limit keeps a form from becoming a way to flood the owner's inbox.
 */
@ApiTags("Contact")
@Controller("contact")
@UseGuards(RateLimitGuard)
export class ContactController {
  constructor(private readonly contact: ContactService) {}

  @Internal("render")
  @Post("submit")
  @HttpCode(200)
  @ApiOperation({
    summary: "Deliver a theme contact-form enquiry as email",
    description:
      "Called by site-runtime, never by a user directly. The site is resolved " +
      "from `hostname`; the recipient is the active theme's configured contact " +
      "email, read server-side and never taken from the request. The visitor's " +
      "address becomes `replyTo`. Rate-limited per IP.",
  })
  @ApiInternal()
  @RateLimit({ by: "ip", points: 5, windowSec: 60 })
  async submit(
    @Query("hostname") hostname: string,
    @Body() body: unknown,
  ): Promise<{ ok: true }> {
    await this.contact.submit(hostname, body);
    return { ok: true };
  }
}

@Module({
  controllers: [ContactController],
  providers: [ContactService],
})
export class ContactModule {}
