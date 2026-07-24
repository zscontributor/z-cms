import { Body, Controller, Get, Module, Param, Put } from "@nestjs/common";
import { ApiOperation, ApiParam, ApiTags } from "@nestjs/swagger";
import { db } from "@zcmsorg/database";
import type { MenuDto } from "@zcmsorg/schemas";
import type { z } from "zod";
import { Actor, RequirePermissions, SiteId, SiteScoped } from "../auth/decorators";
import { toMenuDto } from "../common/mappers";
import {
  ApiAuthed,
  ApiSiteScoped,
  ApiZodBody,
  ApiZodResponse,
} from "../openapi/decorators";
// The schema lives with the other request contracts so the OpenAPI document and
// the validation pipe cannot describe two different menus.
import { PutMenuSchema } from "../openapi/registry";
import type { RequestActor } from "../common/request-context";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { CacheService } from "../redis/cache.service";

type MenuItemInput = z.infer<typeof PutMenuSchema>["items"][number];

@ApiTags("Menus")
@ApiSiteScoped()
@Controller("menus")
@SiteScoped()
class MenusController {
  constructor(private readonly cache: CacheService) {}

  @Get()
  @ApiOperation({ summary: "List menus", description: "Every menu on the site, as a tree." })
  @ApiAuthed("menu:read")
  @ApiZodResponse("MenuDto", { isArray: true })
  @RequirePermissions("menu:read")
  async list(@SiteId() siteId: string): Promise<MenuDto[]> {
    const active = await db().siteTheme.findFirst({
      where: { siteId, status: "ACTIVE" },
      select: { theme: { select: { key: true } } },
    });
    const activeThemeKey = active?.theme.key ?? "";
    const menus = await db().menu.findMany({
      where: {
        siteId,
        OR: [{ demoThemeKey: null }, { demoThemeKey: activeThemeKey }],
      },
      include: { items: true },
      orderBy: { key: "asc" },
    });
    const byKey = new Map<string, (typeof menus)[number]>();
    for (const menu of menus) {
      const existing = byKey.get(menu.key);
      if (!existing || menu.demoThemeKey === activeThemeKey) byKey.set(menu.key, menu);
    }
    return [...byKey.values()].map(toMenuDto);
  }

  /**
   * Replaces a menu wholesale rather than patching items one by one.
   *
   * Menus are trees that the admin edits as a unit; a per-item API would need
   * ordering and re-parenting endpoints and could leave the tree half-updated
   * if one call failed. Replacing inside the request transaction means the menu
   * is either fully the old one or fully the new one.
   */
  @Put(":key")
  @ApiOperation({
    summary: "Create or replace a menu",
    description:
      "Idempotent, and whole-tree: the items you send become the menu. A menu " +
      "that does not exist yet is created, so there is no separate POST. " +
      "Replacing inside the request transaction means the menu is either fully " +
      "the old one or fully the new one, never half-updated.",
  })
  @ApiParam({ name: "key", description: 'Menu location, e.g. "primary" or "footer".' })
  @ApiAuthed("menu:manage")
  @ApiZodBody("PutMenuInput")
  @ApiZodResponse("MenuDto", { description: "The menu as it now stands." })
  @RequirePermissions("menu:manage")
  async replace(
    @Actor() actor: RequestActor,
    @SiteId() siteId: string,
    @Param("key") key: string,
    @Body(new ZodValidationPipe(PutMenuSchema)) body: z.infer<typeof PutMenuSchema>,
  ): Promise<MenuDto> {
    const existing = await db().menu.findFirst({
      where: { siteId, key, demoThemeKey: null },
    });

    const menu =
      existing ??
      (await db().menu.create({
        data: { tenantId: actor.tenantId, siteId, key, name: body.name, demoThemeKey: null },
      }));

    if (existing && existing.name !== body.name) {
      await db().menu.update({ where: { id: menu.id }, data: { name: body.name } });
    }

    await db().menuItem.deleteMany({ where: { menuId: menu.id } });

    const insert = async (items: MenuItemInput[], parentId: string | null) => {
      for (const [index, item] of items.entries()) {
        const created = await db().menuItem.create({
          data: {
            tenantId: actor.tenantId,
            menuId: menu.id,
            parentId,
            label: item.label,
            url: item.url,
            target: item.target ?? "_self",
            order: index,
          },
        });
        if (item.children?.length) await insert(item.children, created.id);
      }
    };
    await insert(body.items, null);

    // The menu is in the header of every page.
    await this.cache.invalidateSite(siteId);

    const fresh = await db().menu.findUnique({
      where: { id: menu.id },
      include: { items: true },
    });
    return toMenuDto(fresh!);
  }
}

@Module({ controllers: [MenusController] })
export class MenusModule {}
