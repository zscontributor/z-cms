import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
} from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { db } from "@zcmsorg/database";
import {
  buildPluginDelete,
  buildPluginInsert,
  buildPluginSelect,
  buildPluginUpdate,
  coercePluginRow,
  type ResolvedPluginAdminResource,
  type PluginTableSchema,
} from "@zcmsorg/plugin-sdk";
import { Actor, SiteId, SiteScoped } from "../auth/decorators";
import { t } from "../common/i18n";
import type { RequestActor } from "../common/request-context";
import { PluginsService } from "./plugins.service";

/**
 * Serves the admin screens plugins declare — the list/detail/form over a plugin's
 * own table. Core owns this controller; a plugin contributes only a description
 * (see `manifest.admin`), and this renders data through it.
 *
 * Two things guard every route, and neither is a static decorator, because both
 * are decided by the plugin's manifest at call time:
 *
 *   - **The resource must exist and be the plugin's.** Resolved from the ACTIVE
 *     install's manifest; a first-party plugin only, backed by a table it owns.
 *   - **The caller must hold the resource's own permission.** Checked here against
 *     the actor's permissions — which already include the plugin's provided grants
 *     — because the permission a resource needs is one the plugin invented and no
 *     `@RequirePermissions()` could name ahead of time.
 *
 * The query itself is built by the same audited builders the sandbox gateway uses,
 * so an admin acting through this controller reaches a plugin's rows by exactly
 * the rules the plugin's own code would: parameterized, column-checked, and
 * scoped to this tenant and site.
 */
@ApiTags("Plugin admin")
@Controller("plugin-admin")
@SiteScoped()
export class PluginAdminController {
  constructor(private readonly plugins: PluginsService) {}

  @Get("contributions")
  @ApiOperation({
    summary: "The plugin admin screens this user may see on this site",
    description:
      "The sidebar entries whose permission the caller holds, and the descriptors " +
      "for the resources they open. Empty when no permission-introducing plugin is " +
      "active — which is exactly why a plugin's menu is not always shown.",
  })
  contributions(@Actor() actor: RequestActor, @SiteId() siteId: string) {
    return this.plugins.adminContributionsFor(actor.tenantId, siteId, actor.permissions);
  }

  @Get(":plugin/:resource")
  @ApiOperation({ summary: "List a plugin resource's rows" })
  async list(
    @Actor() actor: RequestActor,
    @SiteId() siteId: string,
    @Param("plugin") pluginKey: string,
    @Param("resource") resourceKey: string,
    @Query("page") page?: string,
    @Query("perPage") perPage?: string,
  ): Promise<{ resource: ResolvedPluginAdminResource; rows: Record<string, unknown>[] }> {
    const { resource, table } = await this.resolve(actor, siteId, pluginKey, resourceKey);
    this.require(actor, resource.permissions.read);

    const perPageN = Math.min(100, Math.max(1, Number(perPage) || 20));
    const pageN = Math.max(1, Number(page) || 1);

    const rows = await this.run(table, () =>
      buildPluginSelect(
        table,
        { tenantId: actor.tenantId, siteId },
        { orderBy: resource.list.orderBy, limit: perPageN, offset: (pageN - 1) * perPageN },
      ),
    );
    return { resource, rows };
  }

  @Post(":plugin/:resource")
  @ApiOperation({ summary: "Create a row in a plugin resource" })
  async create(
    @Actor() actor: RequestActor,
    @SiteId() siteId: string,
    @Param("plugin") pluginKey: string,
    @Param("resource") resourceKey: string,
    @Body() body: Record<string, unknown>,
  ): Promise<{ row: Record<string, unknown> | null }> {
    const { resource, table } = await this.resolve(actor, siteId, pluginKey, resourceKey);
    this.requireWrite(actor, resource);

    const row = this.coerce(table, body, true);
    const rows = await this.run(table, () =>
      buildPluginInsert(table, { tenantId: actor.tenantId, siteId }, row),
    );
    return { row: rows[0] ?? null };
  }

  @Patch(":plugin/:resource/:id")
  @ApiOperation({ summary: "Update a row in a plugin resource" })
  async update(
    @Actor() actor: RequestActor,
    @SiteId() siteId: string,
    @Param("plugin") pluginKey: string,
    @Param("resource") resourceKey: string,
    @Param("id") id: string,
    @Body() body: Record<string, unknown>,
  ): Promise<{ rows: Record<string, unknown>[] }> {
    const { resource, table } = await this.resolve(actor, siteId, pluginKey, resourceKey);
    this.requireWrite(actor, resource);

    const row = this.coerce(table, body, false);
    const rows = await this.run(table, () =>
      buildPluginUpdate(table, { tenantId: actor.tenantId, siteId }, row, { id }),
    );
    return { rows };
  }

  @Delete(":plugin/:resource/:id")
  @ApiOperation({ summary: "Delete a row in a plugin resource" })
  async remove(
    @Actor() actor: RequestActor,
    @SiteId() siteId: string,
    @Param("plugin") pluginKey: string,
    @Param("resource") resourceKey: string,
    @Param("id") id: string,
  ): Promise<{ deleted: number }> {
    const { resource, table } = await this.resolve(actor, siteId, pluginKey, resourceKey);
    this.requireWrite(actor, resource);

    const q = buildPluginDelete(table, { tenantId: actor.tenantId, siteId }, { id });
    const deleted = await db().$executeRawUnsafe(q.text, ...q.values);
    return { deleted };
  }

  private async resolve(
    actor: RequestActor,
    siteId: string,
    pluginKey: string,
    resourceKey: string,
  ): Promise<{ resource: ResolvedPluginAdminResource; table: PluginTableSchema }> {
    const found = await this.plugins.adminResourceFor(actor.tenantId, siteId, pluginKey, resourceKey);
    if (!found) {
      throw new NotFoundException(t()("errors.plugins.resourceNotFound", { resource: resourceKey }));
    }
    return found;
  }

  /**
   * Coerce a form-posted body to the table's declared column types, turning a
   * blank number or a bad date into a localized 400 rather than a raw Postgres
   * 500. `partial` is true for an update, where an absent column means "leave it".
   */
  private coerce(
    table: PluginTableSchema,
    body: Record<string, unknown> | undefined,
    required: boolean,
  ): Record<string, unknown> {
    const { row, errors } = coercePluginRow(table, body ?? {}, { partial: !required });
    if (errors.length) {
      const tr = t();
      const detail = errors
        .map((e) =>
          e.reason === "required"
            ? tr("errors.plugins.fieldRequired", { column: e.column })
            : tr("errors.plugins.fieldInvalid", { column: e.column }),
        )
        .join(" ");
      throw new BadRequestException(tr("errors.plugins.invalidFieldValues", { detail }));
    }
    return row;
  }

  private require(actor: RequestActor, permission: string): void {
    if (!permission || !actor.permissions.includes(permission)) {
      throw new ForbiddenException(
        t()("errors.auth.missingPermissions", { permissions: permission || "-", role: actor.role }),
      );
    }
  }

  /** A resource with no `write` permission is read-only for everyone. */
  private requireWrite(actor: RequestActor, resource: ResolvedPluginAdminResource): void {
    if (!resource.permissions.write) {
      throw new ForbiddenException(t()("errors.plugins.resourceReadOnly"));
    }
    this.require(actor, resource.permissions.write);
  }

  /**
   * Builds and runs one query, turning a builder's rejection (an unknown column,
   * an empty update) into a 400 rather than letting it surface as a 500 — the
   * body a plugin resource form posts is caller input like any other.
   */
  private async run(
    table: PluginTableSchema,
    build: () => { text: string; values: unknown[] },
  ): Promise<Record<string, unknown>[]> {
    let query: { text: string; values: unknown[] };
    try {
      query = build();
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
    return db().$queryRawUnsafe<Record<string, unknown>[]>(query.text, ...query.values);
  }
}
