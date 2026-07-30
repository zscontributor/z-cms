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
import { ApiOperation, ApiQuery, ApiTags } from "@nestjs/swagger";
import { db } from "@zcmsorg/database";
import {
  buildPluginCount,
  buildPluginDelete,
  buildPluginInsert,
  buildPluginSelect,
  buildPluginUpdate,
  coercePluginRow,
  isPluginRowId,
  type ResolvedPluginAdminResource,
  type PluginTableSchema,
} from "@zcmsorg/plugin-sdk";
import { Actor, SiteId, SiteScoped } from "../auth/decorators";
import { t } from "../common/i18n";
import type { RequestActor } from "../common/request-context";
import { PluginsService } from "./plugins.service";

/**
 * How a column filter arrives: `?f.status=new`. Prefixed so a plugin column called
 * "page" or "sort" cannot collide with this endpoint's own parameters, and so a URL
 * says plainly which parts of it are filters.
 */
const FILTER_PREFIX = "f.";

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
  @ApiOperation({
    summary: "List a plugin resource's rows",
    description:
      "One page of rows, plus the total so the screen can draw a pager, and the " +
      "ordering actually applied. The page size is capped here; a caller asking for " +
      "more gets the cap, not an error. `sort` is honoured only for a column the " +
      "plugin listed — anything else falls back to the declared default ordering.",
  })
  @ApiQuery({ name: "page", required: false, description: "1-based. Out-of-range values clamp to 1." })
  @ApiQuery({ name: "perPage", required: false, description: "Default 20, capped at 100." })
  @ApiQuery({
    name: "sort",
    required: false,
    description:
      "A column the resource lists. Anything else — including a real column the " +
      "plugin did not surface — is ignored in favour of its declared ordering.",
  })
  @ApiQuery({ name: "dir", required: false, enum: ["asc", "desc"], description: "Default asc." })
  @ApiQuery({
    name: "q",
    required: false,
    description:
      "Case-insensitive substring, matched against the resource's listed TEXT " +
      "columns (see `searchable` in the response). Blank means no filtering.",
  })
  @ApiQuery({
    name: "f.<column>",
    required: false,
    description:
      "Equality filter, e.g. `f.status=new`. Offered only for a listed column the " +
      "plugin declared as a select or a boolean, and only for one of its declared " +
      "values; anything else is dropped.",
  })
  async list(
    @Actor() actor: RequestActor,
    @SiteId() siteId: string,
    @Param("plugin") pluginKey: string,
    @Param("resource") resourceKey: string,
    @Query() query: Record<string, unknown>,
    @Query("page") page?: string,
    @Query("perPage") perPage?: string,
    @Query("sort") sort?: string,
    @Query("dir") dir?: string,
    @Query("q") q?: string,
  ): Promise<{
    resource: ResolvedPluginAdminResource;
    rows: Record<string, unknown>[];
    total: number;
    page: number;
    perPage: number;
    order: { column: string; direction: "asc" | "desc" } | null;
    /** Columns the search box looks in — empty when the resource lists no text. */
    searchable: string[];
    /** The filters actually applied, so the screen can show what it is showing. */
    filters: Record<string, unknown>;
  }> {
    const { resource, table } = await this.resolve(actor, siteId, pluginKey, resourceKey);
    this.require(actor, resource.permissions.read);

    const perPageN = Math.min(100, Math.max(1, Number(perPage) || 20));
    const pageN = Math.max(1, Number(page) || 1);
    const order = this.orderFor(resource, sort, dir);
    const searchable = this.searchableColumns(resource, table);
    const filters = this.filtersFor(resource, query ?? {});
    // Trimmed and length-bounded: a search term is caller input, and 200 characters
    // is more than a name and less than a payload.
    const term = typeof q === "string" ? q.trim().slice(0, 200) : "";
    const search =
      term && searchable.length > 0 ? { columns: searchable, term } : undefined;

    // The count rides with the page rather than being a second endpoint the screen
    // has to remember to call: a list with no total cannot say "page 3 of 7", and a
    // pager that only offers next/prev is a guess about what is ahead. It takes the
    // SAME filters as the page — a total counting rows the list is not showing would
    // put a pager on a filtered view that walks off the end of it.
    const [rows, counted] = await Promise.all([
      this.run(table, () =>
        buildPluginSelect(
          table,
          { tenantId: actor.tenantId, siteId },
          {
            where: filters,
            ...(search ? { search } : {}),
            orderBy: order ?? undefined,
            limit: perPageN,
            offset: (pageN - 1) * perPageN,
          },
        ),
      ),
      this.run(table, () =>
        buildPluginCount(table, { tenantId: actor.tenantId, siteId }, filters, search),
      ),
    ]);

    return {
      resource,
      rows,
      // `count(*)` is a bigint, which arrives as a BigInt or a string depending on
      // the driver — and a BigInt cannot be JSON-serialized at all. Narrowed here,
      // once, rather than at every reader.
      total: Number(counted[0]?.count ?? 0),
      page: pageN,
      perPage: perPageN,
      // Echoed so the screen marks the column it is actually sorted by, rather than
      // the one it asked for: a request this method declined would otherwise draw an
      // arrow over a column the rows are not ordered by.
      order: order ?? null,
      searchable,
      filters,
    };
  }

  /**
   * One row, for the detail screen.
   *
   * Declared after the list route on purpose — Nest matches on segment count, so
   * `:plugin/:resource` and `:plugin/:resource/:id` cannot shadow each other, but
   * keeping the shorter path first keeps the reading order obvious.
   *
   * Gated by the resource's READ permission, not write: looking at a record is the
   * thing a read-only role is for, and until this existed the only way to see a
   * row's full contents was to open the edit form — which a read-only role cannot,
   * and which is the wrong tool for "what does this say?" anyway.
   */
  @Get(":plugin/:resource/:id")
  @ApiOperation({
    summary: "Read one row of a plugin resource",
    description:
      "The detail screen's fetch. Requires the resource's read permission; a row " +
      "belonging to another tenant or site is not found, not forbidden.",
  })
  async detail(
    @Actor() actor: RequestActor,
    @SiteId() siteId: string,
    @Param("plugin") pluginKey: string,
    @Param("resource") resourceKey: string,
    @Param("id") id: string,
  ): Promise<{ resource: ResolvedPluginAdminResource; row: Record<string, unknown> }> {
    const { resource, table } = await this.resolve(actor, siteId, pluginKey, resourceKey);
    this.require(actor, resource.permissions.read);
    const rowId = this.rowId(id);

    const rows = await this.run(table, () =>
      buildPluginSelect(
        table,
        { tenantId: actor.tenantId, siteId },
        { where: { id: rowId }, limit: 1 },
      ),
    );
    const row = rows[0];
    if (!row) {
      throw new NotFoundException(t()("errors.plugins.rowNotFound", { id }));
    }
    return { resource, row };
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
    const created = rows[0] ?? null;
    if (created) {
      this.emit(actor, siteId, pluginKey, resource, table, "created", created, null);
    }
    return { row: created };
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
    const rowId = this.rowId(id);

    // Read before writing: the plugin's handler is told what the row WAS as well
    // as what it now is, and there is no other moment at which the old value still
    // exists. Cheap — a primary-key lookup — and only on a write path.
    const previous = await this.currentRow(table, siteId, actor.tenantId, rowId);

    const row = this.coerce(table, body, false);
    const rows = await this.run(table, () =>
      buildPluginUpdate(table, { tenantId: actor.tenantId, siteId }, row, { id: rowId }),
    );
    if (rows[0]) {
      this.emit(actor, siteId, pluginKey, resource, table, "updated", rows[0], previous);
    }
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
    const rowId = this.rowId(id);

    const previous = await this.currentRow(table, siteId, actor.tenantId, rowId);
    const q = buildPluginDelete(table, { tenantId: actor.tenantId, siteId }, { id: rowId });
    const deleted = await db().$executeRawUnsafe(q.text, ...q.values);
    if (deleted > 0 && previous) {
      this.emit(actor, siteId, pluginKey, resource, table, "deleted", null, previous);
    }
    return { deleted };
  }

  /** The row as it stands, by id, scoped like every other read on this controller. */
  private async currentRow(
    table: PluginTableSchema,
    siteId: string,
    tenantId: string,
    rowId: string,
  ): Promise<Record<string, unknown> | null> {
    const q = buildPluginSelect(table, { tenantId, siteId }, { where: { id: rowId }, limit: 1 });
    const rows = await db().$queryRawUnsafe<Record<string, unknown>[]>(q.text, ...q.values);
    return rows[0] ?? null;
  }

  /**
   * Tells the plugin that a human changed one of its rows.
   *
   * Not awaited, and delivered only to the plugin that owns the table. A plugin
   * whose data has consequences — a stock movement that moves a balance, an order
   * line that changes a total — cannot learn about them any other way: this
   * controller writes what the form posted and has no idea what it means.
   *
   * The save has already succeeded by the time this runs. That ordering is the
   * point: a slow or broken plugin must not be able to fail somebody's Save, and
   * an action that ran first would be able to.
   */
  private emit(
    actor: RequestActor,
    siteId: string,
    pluginKey: string,
    resource: ResolvedPluginAdminResource,
    table: PluginTableSchema,
    operation: "created" | "updated" | "deleted",
    row: Record<string, unknown> | null,
    previous: Record<string, unknown> | null,
  ): void {
    void this.plugins
      .dispatchActionTo(actor.tenantId, siteId, pluginKey, "admin.record.changed", {
        siteId,
        resource: resource.key,
        table: table.name,
        operation,
        rowId: String((row ?? previous)?.id ?? ""),
        row,
        previous,
      })
      .catch(() => undefined);
  }

  /**
   * Which listed columns a search box may look in: the text ones.
   *
   * Derived, not declared, so a plugin already published gets a working search box
   * without shipping a new manifest. Text only — `ILIKE` over a uuid or a timestamp
   * is a way to make the database cast every row of a table for a query that could
   * never usefully match, and a numeric column matched by substring ("3" finding
   * 130,000) answers a question nobody asked.
   */
  private searchableColumns(
    resource: ResolvedPluginAdminResource,
    table: PluginTableSchema,
  ): string[] {
    const textColumns = new Set(
      table.columns.filter((column) => column.type === "text").map((column) => column.name),
    );
    return resource.list.columns
      .map((column) => column.column)
      .filter((column) => textColumns.has(column));
  }

  /**
   * The equality filters this resource offers, and the values each one accepts —
   * both read off the plugin's own admin declaration.
   *
   * A dropdown is only honest where the set of values is knowable, so the source is
   * the form field the plugin declared for that column: a `select` brings its
   * options, a `boolean` brings true/false. Everything else is not filterable, and a
   * value outside the declared options is dropped rather than passed through — which
   * is what stops `?f.status=' OR 1=1` from being a question the database is asked,
   * one layer above the builder that would also have refused it.
   */
  private filtersFor(
    resource: ResolvedPluginAdminResource,
    query: Record<string, unknown>,
  ): Record<string, unknown> {
    const listed = new Set(resource.list.columns.map((column) => column.column));
    const out: Record<string, unknown> = {};

    for (const field of resource.form?.fields ?? []) {
      if (!listed.has(field.column)) continue;
      const raw = query[`${FILTER_PREFIX}${field.column}`];
      if (typeof raw !== "string" || raw === "") continue;

      if (field.input === "boolean") {
        if (raw === "true" || raw === "false") out[field.column] = raw === "true";
        continue;
      }
      if (field.input === "select") {
        const allowed = (field.options ?? []).some((option) => option.value === raw);
        if (allowed) out[field.column] = raw;
      }
    }
    return out;
  }

  /**
   * How the page is ordered: the visitor's choice if it names a column this
   * resource actually lists, else the ordering the plugin declared.
   *
   * The closed set is the point. `orderBy` reaches a query builder that puts the
   * column name into SQL as an identifier — it is checked against the table's
   * columns there, so a hostile value cannot get through either way — but "any
   * column of the table" is still wider than this screen has any business sorting
   * by, and it would let a caller order by a column the plugin deliberately did not
   * surface (`internal_notes`, a cost price) and read its order off the rows. So the
   * allowed set is what the plugin put in `list.columns`, and an unrecognised `sort`
   * is ignored rather than refused: a stale bookmark should show the list, not an
   * error.
   */
  private orderFor(
    resource: ResolvedPluginAdminResource,
    sort: string | undefined,
    dir: string | undefined,
  ): { column: string; direction: "asc" | "desc" } | undefined {
    if (sort && resource.list.columns.some((column) => column.column === sort)) {
      return { column: sort, direction: dir === "desc" ? "desc" : "asc" };
    }
    const declared = resource.list.orderBy;
    if (!declared) return undefined;
    return {
      column: declared.column,
      direction: declared.direction === "desc" ? "desc" : "asc",
    };
  }

  /**
   * A row id, or a 404.
   *
   * Every plugin table's `id` is a `uuid` the platform adds, so anything that is
   * not one names no row. Checked here rather than left to Postgres: `WHERE id =
   * 'abc'` is a type error, which surfaces as a 500 — an ugly answer to a URL
   * somebody mistyped, and one that says "the server broke" about a request that
   * was simply wrong. The detail route made that reachable by typing in the
   * address bar, so update and delete get the same guard.
   */
  private rowId(id: string): string {
    if (!isPluginRowId(id)) {
      throw new NotFoundException(t()("errors.plugins.rowNotFound", { id }));
    }
    return id;
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
