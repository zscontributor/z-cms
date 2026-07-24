import { BadRequestException, Controller, Get, Module, Query } from "@nestjs/common";
import { ApiOperation, ApiQuery, ApiTags } from "@nestjs/swagger";
import type { RenderPayload } from "@zcmsorg/schemas";
import { Internal } from "../auth/decorators";
import { t } from "../common/i18n";
import { ApiInternal, ApiZodResponse } from "../openapi/decorators";
import { RenderService } from "./render.service";

@ApiTags("Render")
@Controller("render")
class RenderController {
  constructor(private readonly render: RenderService) {}

  /**
   * Called by site-runtime for every public page render.
   *
   * Authenticated with the shared internal token, not a user session: the
   * visitor is anonymous, but the *caller* must still be our own runtime. Left
   * open, this endpoint would let anyone enumerate every site on the platform.
   */
  @Internal("render")
  @Get("resolve")
  @ApiOperation({
    summary: "Everything needed to draw one public URL",
    description:
      "One round trip, on purpose: a page render must not fan out into separate " +
      "calls for the site, theme, menus and content, and one cached payload per " +
      "path makes invalidation a single key to delete. `content` is null when " +
      "nothing lives at the path (the runtime renders a 404); `archive` is set " +
      "instead when the path is a listing route like /blog.\\n\\n" +
      "Internal-token guarded: the visitor is anonymous, but the *caller* must " +
      "be our own runtime. Left open, this would let anyone enumerate every site " +
      "on the platform.",
  })
  @ApiInternal()
  @ApiQuery({ name: "hostname", required: true, description: "The domain being served, e.g. \"example.com\"." })
  @ApiQuery({ name: "path", required: true, description: 'The requested path, e.g. "/blog/hello". Defaults to "/".' })
  @ApiQuery({
    name: "page",
    required: false,
    description: "Archive pagination. Ignored for single pages.",
    schema: { type: "integer", minimum: 1, default: 1 },
  })
  @ApiQuery({
    name: "q",
    required: false,
    description: "Search query. Used only when path is /search.",
  })
  @ApiZodResponse("RenderPayload")
  @ApiZodResponse("Error", { status: 400, description: "`hostname` is required." })
  resolve(
    @Query("hostname") hostname: string,
    @Query("path") path: string,
    @Query("page") page = "1",
    @Query("q") q?: string,
  ): Promise<RenderPayload> {
    if (!hostname) throw new BadRequestException(t()("errors.render.missingHostname"));

    return this.render.resolve(
      hostname.toLowerCase(),
      path || "/",
      Math.max(1, Number(page) || 1),
      q,
    );
  }
}

@Module({
  controllers: [RenderController],
  providers: [RenderService],
})
export class RenderModule {}
