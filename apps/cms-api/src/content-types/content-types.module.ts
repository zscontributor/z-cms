import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Module,
  Post,
} from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { db } from "@zcmsorg/database";
import {
  CreateContentTypeSchema,
  type ContentTypeDto,
  type CreateContentTypeInput,
} from "@zcmsorg/schemas";
import { Actor, RequirePermissions, SiteId, SiteScoped } from "../auth/decorators";
import { t } from "../common/i18n";
import { toContentTypeDto } from "../common/mappers";
import {
  ApiAuthed,
  ApiSiteScoped,
  ApiZodBody,
  ApiZodResponse,
} from "../openapi/decorators";
import type { RequestActor } from "../common/request-context";
import { ZodValidationPipe } from "../common/zod-validation.pipe";

@ApiTags("Content types")
@ApiSiteScoped()
@Controller("content-types")
@SiteScoped()
class ContentTypesController {
  @Get()
  @ApiOperation({
    summary: "List content types",
    description: "The shape of everything this site can hold, oldest first.",
  })
  @ApiAuthed("content-type:read")
  @ApiZodResponse("ContentTypeDto", { isArray: true })
  @RequirePermissions("content-type:read")
  async list(@SiteId() siteId: string): Promise<ContentTypeDto[]> {
    const types = await db().contentType.findMany({
      where: { siteId },
      orderBy: { createdAt: "asc" },
    });
    return types.map(toContentTypeDto);
  }

  @Post()
  @ApiOperation({
    summary: "Define a content type",
    description:
      "`key` is unique per site. A routable type also claims its `routePrefix` " +
      "exclusively — two types sharing one would make /blog/x ambiguous, so the " +
      "second is rejected rather than resolved arbitrarily.",
  })
  @ApiAuthed("content-type:manage")
  @ApiZodBody("CreateContentTypeInput")
  @ApiZodResponse("ContentTypeDto", { status: 201, description: "Created." })
  @ApiZodResponse("Error", { status: 400, description: "The key or the route prefix is already taken." })
  @RequirePermissions("content-type:manage")
  async create(
    @Actor() actor: RequestActor,
    @SiteId() siteId: string,
    @Body(new ZodValidationPipe(CreateContentTypeSchema)) body: CreateContentTypeInput,
  ): Promise<ContentTypeDto> {
    const clash = await db().contentType.findFirst({
      where: { siteId, key: body.key },
    });
    if (clash) {
      throw new BadRequestException(t()("errors.contentTypes.keyTaken", { key: body.key }));
    }

    // Two routable types sharing a prefix would make /blog/x ambiguous, and the
    // resolver would silently pick whichever row came back first.
    if (body.isRoutable) {
      const prefixClash = await db().contentType.findFirst({
        where: { siteId, routePrefix: body.routePrefix, isRoutable: true },
      });
      if (prefixClash) {
        throw new BadRequestException(
          t()("errors.contentTypes.routePrefixTaken", {
            prefix: body.routePrefix || "/",
            name: prefixClash.name,
          }),
        );
      }
    }

    const created = await db().contentType.create({
      data: {
        tenantId: actor.tenantId,
        siteId,
        key: body.key,
        name: body.name,
        pluralName: body.pluralName,
        description: body.description,
        isSingleton: body.isSingleton,
        isRoutable: body.isRoutable,
        routePrefix: body.routePrefix,
        hasBlocks: body.hasBlocks,
        icon: body.icon,
        fields: body.fields as never,
      },
    });

    return toContentTypeDto(created);
  }
}

@Module({ controllers: [ContentTypesController] })
export class ContentTypesModule {}
