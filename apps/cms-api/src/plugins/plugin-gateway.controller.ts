import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Headers,
  HttpCode,
  Post,
} from "@nestjs/common";
import { ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import { db, withTenant } from "@zcmsorg/database";
import { createHash } from "node:crypto";
import type { Permission } from "@zcmsorg/schemas";
import { Internal, Public } from "../auth/decorators";
import {
  ApiInternal,
  ApiPluginToken,
  ApiZodBody,
  ApiZodResponse,
} from "../openapi/decorators";
import { MailService } from "../mail/mail.service";
import { QueueService } from "../queue/queue.module";
import { PluginEgressService } from "./plugin-egress.service";
import { PluginsService } from "./plugins.service";
import { t } from "../common/i18n";
import { toContentDto } from "../common/mappers";
import { PluginTokenService, type PluginTokenClaims } from "./plugin-token.service";

const CONTENT_INCLUDE = {
  contentType: { select: { id: true, key: true, name: true, routePrefix: true } },
  author: { select: { id: true, name: true } },
} as const;

/**
 * Every capability a plugin has, and the scope it costs.
 *
 * This table IS the security policy. A method absent from it does not exist for
 * plugins; a method present in it cannot be called without the scope beside it.
 * `storage.*` needs no scope because the storage is the plugin's own — but note
 * where its rows are keyed from: the token, never the request body.
 */
const METHOD_SCOPES: Record<string, Permission | null> = {
  "storage.get": null,
  "storage.set": null,
  "storage.delete": null,
  "storage.list": null,
  "content.get": "content:read",
  "content.list": "content:read",
  "jobs.enqueue": null,
  "mail.send": "mail:send",
  // The scope is half the answer. The other half is the manifest's `network.hosts`,
  // which PluginEgressService reads from the install on every call: this row lets a
  // plugin reach the internet, and that list decides which two hostnames of it.
  "http.fetch": "network:fetch",
};

@ApiTags("Plugin gateway")
@Controller("plugin-gateway")
export class PluginGatewayController {
  constructor(
    private readonly tokens: PluginTokenService,
    private readonly queue: QueueService,
    private readonly plugins: PluginsService,
    private readonly mail: MailService,
    private readonly egress: PluginEgressService,
  ) {}

  /**
   * Runs a plugin's deferred job. Called by the worker, not by a user.
   *
   * The worker holds credentials but no sandbox, so it must not run plugin code.
   * It calls here; cms-api dispatches the job into the isolated-vm sandbox under
   * the plugin's scoped token, exactly like a live hook. The plugin runs where
   * plugin code always runs. This endpoint is internal-token guarded because a
   * caller can name any plugin and site — only our own worker may.
   */
  @Internal()
  @Post("run-job")
  @HttpCode(200)
  @ApiOperation({
    summary: "Run a plugin's deferred job",
    description:
      "Called by the worker, never by a user. The worker holds credentials but " +
      "has no sandbox, so it must not run plugin code — it calls here, and " +
      "cms-api dispatches into isolated-vm under the plugin's scoped token. " +
      "Internal-token guarded because the body names any tenant, site and plugin " +
      "it likes; only our own worker may.",
  })
  @ApiInternal()
  @ApiZodBody("RunJobInput")
  @ApiZodResponse("PluginActivation", {
    description: "`ok: false` carries the plugin's own error — the job ran, the plugin failed.",
  })
  async runJob(
    @Body()
    body: {
      tenantId?: string;
      siteId?: string;
      pluginKey?: string;
      name?: string;
      payload?: Record<string, unknown>;
    },
  ): Promise<{ ok: boolean; error?: string }> {
    if (!body.tenantId || !body.siteId || !body.pluginKey || !body.name) {
      throw new BadRequestException("Missing tenantId, siteId, pluginKey or name.");
    }
    return this.plugins.runJob(
      body.tenantId,
      body.siteId,
      body.pluginKey,
      body.name,
      body.payload ?? {},
    );
  }

  /**
   * The plugin sandbox's only way to affect the world.
   *
   * `@Public()` bypasses the *user* guard, not authentication: the plugin token
   * below is the credential, and it is verified before anything else happens.
   */
  @Public()
  @Post("call")
  @HttpCode(200)
  @ApiOperation({
    summary: "The host call a sandboxed plugin makes",
    description:
      "Every effect a plugin can have on the world goes through this one door. " +
      "The plugin token in `Authorization` names the plugin, its site and the " +
      "scopes it was granted at install; a method it was not granted is refused " +
      "here, not inside the sandbox. Marked public only because the *user* guard " +
      "does not apply — the plugin token is the credential, and it is checked " +
      "before anything else happens.",
  })
  @ApiPluginToken()
  @ApiZodBody("GatewayCallInput")
  @ApiResponse({
    status: 200,
    description: "The method's result. Shape depends on `method`.",
    schema: { type: "object", properties: { data: {} }, required: ["data"] },
  })
  async call(
    @Headers("authorization") authorization: string | undefined,
    @Body() body: { method?: string; params?: Record<string, unknown> },
  ): Promise<{ data: unknown }> {
    const token = authorization?.startsWith("Bearer ")
      ? authorization.slice(7).trim()
      : undefined;
    if (!token) throw new ForbiddenException(t()("errors.plugins.missingToken"));

    const claims = await this.tokens.verify(token);
    const method = body.method ?? "";

    if (!(method in METHOD_SCOPES)) {
      throw new BadRequestException(t()("errors.plugins.unknownMethod", { method }));
    }

    const required = METHOD_SCOPES[method];
    if (required && !claims.scopes.includes(required)) {
      // The plugin asked for something the admin did not grant. This is the
      // check that makes the consent screen mean something.
      throw new ForbiddenException(
        t()("errors.plugins.scopeNotGranted", { plugin: claims.plg, scope: required }),
      );
    }

    // Tenant comes from the signed token, so a plugin cannot reach across
    // tenants even if it forges every parameter it sends.
    return withTenant(claims.tid, () =>
      this.dispatch(claims, method, body.params ?? {}),
    );
  }

  private async dispatch(
    claims: PluginTokenClaims,
    method: string,
    params: Record<string, unknown>,
  ): Promise<{ data: unknown }> {
    switch (method) {
      case "storage.get": {
        const row = await db().pluginData.findFirst({
          where: {
            siteId: claims.sid,
            pluginId: claims.pid,
            key: this.requireString(params.key, "key"),
          },
        });
        return { data: row?.value ?? null };
      }

      case "storage.set": {
        const key = this.requireString(params.key, "key");
        // siteId/pluginId/tenantId all come from the token. A plugin cannot
        // write into another plugin's namespace or another site's data by
        // sending different ids — it has no way to say them at all.
        const existing = await db().pluginData.findFirst({
          where: { siteId: claims.sid, pluginId: claims.pid, key },
        });

        if (existing) {
          await db().pluginData.update({
            where: { id: existing.id },
            data: { value: (params.value ?? {}) as never },
          });
        } else {
          await db().pluginData.create({
            data: {
              tenantId: claims.tid,
              siteId: claims.sid,
              pluginId: claims.pid,
              key,
              value: (params.value ?? {}) as never,
            },
          });
        }
        return { data: true };
      }

      case "storage.delete": {
        await db().pluginData.deleteMany({
          where: {
            siteId: claims.sid,
            pluginId: claims.pid,
            key: this.requireString(params.key, "key"),
          },
        });
        return { data: true };
      }

      case "storage.list": {
        const prefix = typeof params.prefix === "string" ? params.prefix : undefined;
        const rows = await db().pluginData.findMany({
          where: {
            siteId: claims.sid,
            pluginId: claims.pid,
            ...(prefix ? { key: { startsWith: prefix } } : {}),
          },
          take: 200,
        });
        return { data: rows.map((r) => ({ key: r.key, value: r.value })) };
      }

      case "content.get": {
        const content = await db().content.findFirst({
          where: {
            id: this.requireString(params.contentId, "contentId"),
            siteId: claims.sid,
          },
          include: CONTENT_INCLUDE,
        });
        return { data: content ? toContentDto(content) : null };
      }

      case "content.list": {
        const query = (params.query ?? {}) as {
          contentTypeKey?: string;
          status?: string;
          page?: number;
          perPage?: number;
        };
        const perPage = Math.min(50, Math.max(1, Number(query.perPage) || 20));
        const page = Math.max(1, Number(query.page) || 1);

        const rows = await db().content.findMany({
          where: {
            siteId: claims.sid,
            ...(query.contentTypeKey
              ? { contentType: { key: query.contentTypeKey } }
              : {}),
            ...(query.status ? { status: query.status as never } : {}),
          },
          include: CONTENT_INCLUDE,
          orderBy: { updatedAt: "desc" },
          skip: (page - 1) * perPage,
          take: perPage,
        });
        return { data: rows.map(toContentDto) };
      }

      case "jobs.enqueue": {
        // Enqueues a durable job that will re-invoke THIS plugin, in the sandbox,
        // later. The plugin still cannot run a timer or open a socket — it can
        // only ask the platform to call it again. The job carries the plugin key
        // and the tenant/site from the token, never anything the plugin could use
        // to act as another plugin or on another site.
        const name = this.requireString(params.name, "name");
        const payload = (params.payload ?? {}) as Record<string, unknown>;

        // Deduplicated on (plugin, site, job name, payload). A plugin that
        // enqueues the same job from a loop — or on every content.published in a
        // bulk import — would otherwise queue it hundreds of times. BullMQ
        // refuses a duplicate jobId while the job is still pending, so identical
        // work collapses into one run.
        const fingerprint = createHash("sha256")
          .update(`${claims.plg}|${claims.sid}|${name}|${JSON.stringify(payload)}`)
          .digest("hex")
          .slice(0, 32);

        await this.queue.enqueue(
          "plugin.deferred",
          {
            tenantId: claims.tid,
            siteId: claims.sid,
            pluginKey: claims.plg,
            name,
            payload,
          },
          { jobId: `plugin-deferred-${fingerprint}` },
        );
        return { data: true };
      }

      case "mail.send": {
        // The plugin says WHAT to send. It never says who it is from, which
        // server carries it, or with what credential — all three come from the
        // site's configuration, on the far side of this boundary. The token
        // supplies the tenant, the site and the plugin's identity, so a plugin
        // cannot mail on another site's behalf even by forging every parameter.
        //
        // MailService validates the message, charges it against the site's hourly
        // quota, and queues it. It does NOT wait for the SMTP server: the sandbox
        // gives us three seconds and a mail server can take thirty.
        return {
          data: await this.mail.enqueue(claims.tid, claims.sid, claims.plg, params.message),
        };
      }

      case "http.fetch": {
        // The plugin says WHERE to go and WHAT to say. It does not open the socket,
        // it does not choose the host (its manifest did, and an admin approved that
        // list), and it does not hold the credential it is spending. Same bargain as
        // mail.send, one layer further out: the plugin describes the letter, the
        // host addresses the envelope and licks the stamp.
        return { data: await this.egress.fetch(claims, params) };
      }

      default:
        throw new BadRequestException(
          t()("errors.plugins.methodNotSupported", { method }),
        );
    }
  }

  private requireString(value: unknown, name: string): string {
    if (typeof value !== "string" || !value) {
      throw new BadRequestException(t()("errors.validation.requiredParam", { name }));
    }
    return value;
  }
}
