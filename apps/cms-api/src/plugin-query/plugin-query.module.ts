import { Controller, Get, Module, Param, Query, UseGuards } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { Internal } from "../auth/decorators";
import { RateLimit } from "../common/rate-limit.decorator";
import { RateLimitGuard } from "../common/rate-limit.guard";
import { ApiInternal } from "../openapi/decorators";
import { PluginQueryService } from "./plugin-query.service";

/**
 * The generic public plugin-query endpoint — the read twin of `/forms/:id/submit`.
 *
 * `@Internal("render")` because site-runtime is the only caller: a runtime widget
 * fetches a same-origin route which forwards here with the render token. The site
 * comes from `hostname`, the capability from the path, and the filter from the
 * query string; the endpoint invokes the fixed `query` call on the plugin that
 * provides that capability and returns `{ items }`. Read-only and rate-limited.
 */
@ApiTags("Plugin query")
@Controller("plugin-query")
@UseGuards(RateLimitGuard)
export class PluginQueryController {
  constructor(private readonly query: PluginQueryService) {}

  @Internal("render")
  @Get(":capability")
  @ApiOperation({
    summary: "Run a plugin-declared public query",
    description:
      "Called by site-runtime, never directly. Dispatches the query-string filter " +
      "to the `query` call of the ACTIVE plugin that provides `:capability`, which " +
      "reads its own tables and returns rows. Rate-limited per IP.",
  })
  @ApiInternal()
  @RateLimit({ by: "ip", points: 60, windowSec: 60 })
  run(
    @Param("capability") capability: string,
    @Query("hostname") hostname: string,
    @Query() params: Record<string, unknown>,
  ): Promise<{ items: unknown[] }> {
    return this.query.run(hostname, capability, params);
  }
}

@Module({
  controllers: [PluginQueryController],
  providers: [PluginQueryService],
})
export class PluginQueryModule {}
