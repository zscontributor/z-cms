import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
} from "@nestjs/common";
import { ApiOperation, ApiQuery, ApiTags } from "@nestjs/swagger";
import {
  ContentStatusSchema,
  CreateContentSchema,
  UpdateContentSchema,
  type ContentDto,
  type CreateContentInput,
  type Paginated,
  type TranslationDto,
  type UpdateContentInput,
} from "@zcmsorg/schemas";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { Actor, RequirePermissions, SiteId, SiteScoped } from "../auth/decorators";
import {
  ApiAuthed,
  ApiNoContent,
  ApiNotFound,
  ApiPaginatedResponse,
  ApiSiteScoped,
  ApiZodBody,
  ApiZodResponse,
} from "../openapi/decorators";
import type { RequestActor } from "../common/request-context";
import { ContentsService } from "./contents.service";

@ApiTags("Content")
@ApiSiteScoped()
@Controller("contents")
@SiteScoped()
export class ContentsController {
  constructor(private readonly contents: ContentsService) {}

  @Get()
  @ApiOperation({
    summary: "List entries",
    description: "Newest first. Filters combine; `search` matches the title.",
  })
  @ApiAuthed("content:read")
  @ApiQuery({ name: "contentTypeKey", required: false, description: 'e.g. "post". Omit for every type.' })
  @ApiQuery({ name: "status", required: false, enum: ContentStatusSchema.options })
  @ApiQuery({ name: "locale", required: false, description: 'e.g. "vi". Filters entries by language.' })
  @ApiQuery({ name: "search", required: false, description: "Substring of the title." })
  @ApiQuery({ name: "page", required: false, schema: { type: "integer", minimum: 1, default: 1 } })
  @ApiQuery({
    name: "perPage",
    required: false,
    description: "Clamped to 100.",
    schema: { type: "integer", minimum: 1, maximum: 100, default: 20 },
  })
  @ApiPaginatedResponse("ContentDto")
  @RequirePermissions("content:read")
  list(
    @SiteId() siteId: string,
    @Query("contentTypeKey") contentTypeKey?: string,
    @Query("status") status?: string,
    @Query("locale") locale?: string,
    @Query("search") search?: string,
    @Query("page") page = "1",
    @Query("perPage") perPage = "20",
  ): Promise<Paginated<ContentDto>> {
    return this.contents.list(siteId, {
      contentTypeKey,
      status,
      locale,
      search,
      page: Math.max(1, Number(page) || 1),
      perPage: Math.min(100, Math.max(1, Number(perPage) || 20)),
    });
  }

  @Get(":id")
  @ApiOperation({ summary: "Read one entry" })
  @ApiAuthed("content:read")
  @ApiZodResponse("ContentDto")
  @ApiNotFound("No such entry on this site.")
  @RequirePermissions("content:read")
  findOne(@SiteId() siteId: string, @Param("id") id: string): Promise<ContentDto> {
    return this.contents.findOne(siteId, id);
  }

  @Get(":id/translations")
  @ApiOperation({
    summary: "This entry in every language the site publishes in",
    description:
      "One row per site locale, including the locales with no translation yet — " +
      "`content` is null for those. The editor needs to show what is *missing*, " +
      "which a list of what exists cannot say.",
  })
  @ApiAuthed("content:read")
  @ApiZodResponse("TranslationDto", { isArray: true })
  @ApiNotFound("No such entry on this site.")
  @RequirePermissions("content:read")
  translations(
    @SiteId() siteId: string,
    @Param("id") id: string,
  ): Promise<TranslationDto[]> {
    return this.contents.translations(siteId, id);
  }

  @Post()
  @ApiOperation({
    summary: "Create an entry",
    description:
      "`data` is validated against the fields its content type declares, so the " +
      "accepted shape depends on `contentTypeId`. Slugs are unique per type and " +
      "locale; the empty slug is the homepage.",
  })
  @ApiAuthed("content:create")
  @ApiZodBody("CreateContentInput")
  @ApiZodResponse("ContentDto", { status: 201, description: "Created." })
  @RequirePermissions("content:create")
  create(
    @Actor() actor: RequestActor,
    @SiteId() siteId: string,
    @Body(new ZodValidationPipe(CreateContentSchema)) body: CreateContentInput,
  ): Promise<ContentDto> {
    return this.contents.create(actor, siteId, body);
  }

  @Patch(":id")
  @ApiOperation({
    summary: "Update an entry",
    description: "Partial: only the fields you send change. The content type cannot be changed.",
  })
  @ApiAuthed("content:update")
  @ApiZodBody("UpdateContentInput")
  @ApiZodResponse("ContentDto")
  @ApiNotFound("No such entry on this site.")
  @RequirePermissions("content:update")
  update(
    @Actor() actor: RequestActor,
    @SiteId() siteId: string,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(UpdateContentSchema)) body: UpdateContentInput,
  ): Promise<ContentDto> {
    return this.contents.update(actor, siteId, id, body);
  }

  @Post(":id/publish")
  @HttpCode(200)
  @ApiOperation({
    summary: "Publish an entry",
    description: "Makes it live and invalidates the cached pages that render it.",
  })
  @ApiAuthed("content:publish")
  @ApiZodResponse("ContentDto", { description: "Now PUBLISHED." })
  @ApiNotFound("No such entry on this site.")
  @RequirePermissions("content:publish")
  publish(
    @Actor() actor: RequestActor,
    @SiteId() siteId: string,
    @Param("id") id: string,
  ): Promise<ContentDto> {
    return this.contents.setPublished(actor, siteId, id, true);
  }

  @Post(":id/unpublish")
  @HttpCode(200)
  @ApiOperation({
    summary: "Unpublish an entry",
    description: "Back to DRAFT. The public URL starts returning 404.",
  })
  @ApiAuthed("content:publish")
  @ApiZodResponse("ContentDto", { description: "Now DRAFT." })
  @ApiNotFound("No such entry on this site.")
  @RequirePermissions("content:publish")
  unpublish(
    @Actor() actor: RequestActor,
    @SiteId() siteId: string,
    @Param("id") id: string,
  ): Promise<ContentDto> {
    return this.contents.setPublished(actor, siteId, id, false);
  }

  @Delete(":id")
  @HttpCode(204)
  @ApiOperation({ summary: "Delete an entry" })
  @ApiAuthed("content:delete")
  @ApiNoContent("Deleted.")
  @ApiNotFound("No such entry on this site.")
  @RequirePermissions("content:delete")
  async remove(
    @Actor() actor: RequestActor,
    @SiteId() siteId: string,
    @Param("id") id: string,
  ): Promise<void> {
    await this.contents.remove(actor, siteId, id);
  }
}
