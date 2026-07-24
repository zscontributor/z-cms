import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { Reflector } from "@nestjs/core";
import { getSystemDb } from "@zcmsorg/database";
import {
  permissionsForRole,
  type AccessTokenClaims,
  type Permission,
  type Role,
} from "@zcmsorg/schemas";
import { timingSafeEqual } from "node:crypto";
import { t } from "../common/i18n";
import { RevocationService } from "./revocation.service";
import { SecurityEventService } from "../audit/security-event.service";
import type { AuthedRequest } from "../common/request-context";
import {
  INTERNAL_KEY,
  type InternalScope,
  PERMISSIONS_KEY,
  PUBLIC_KEY,
  SITE_SCOPED_KEY,
} from "./decorators";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * One guard does authentication and authorisation, in a fixed order:
 *
 *   1. public route?            -> allow
 *   2. internal route?          -> require the shared internal token
 *   3. valid access token?      -> otherwise 401
 *   4. site-scoped route?       -> require X-Site-Id the user has a role on
 *   5. declared permissions?    -> the role must grant all of them
 *
 * Step 4 is the one that matters most: it is where "which site am I acting on"
 * is *proven* rather than trusted. The site id arrives in a header, so it is
 * attacker-controlled; we only accept it after confirming the user holds a
 * membership on that site (or a tenant-wide role), and only sites inside their
 * own tenant can match, because the lookup is filtered by the token's tenant.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly revocations: RevocationService,
    private readonly events: SecurityEventService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const handler = [context.getHandler(), context.getClass()];

    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, handler)) {
      return true;
    }

    const internalScope = this.reflector.getAllAndOverride<InternalScope>(
      INTERNAL_KEY,
      handler,
    );
    if (internalScope) {
      return this.checkInternalToken(req, internalScope);
    }

    const token = this.extractBearer(req);
    if (!token) throw new UnauthorizedException(t()("errors.auth.missingToken"));

    let claims: AccessTokenClaims;
    try {
      claims = await this.jwt.verifyAsync<AccessTokenClaims>(token, {
        secret: this.config.getOrThrow<string>("JWT_SECRET"),
      });
    } catch {
      throw new UnauthorizedException(t()("errors.auth.invalidToken"));
    }

    // The token is well-formed and unexpired — but its session may have been
    // ended (logout, or a theft-triggered family revocation). A stateless JWT
    // cannot know that on its own, so ask.
    if (claims.fid && (await this.revocations.isRevoked(claims.fid))) {
      this.events.record("auth.revoked_token_used", {
        userId: claims.sub,
        tenantId: claims.tid,
        familyId: claims.fid,
        path: req.path,
        ip: this.clientIp(req),
      });
      throw new UnauthorizedException(t()("errors.auth.sessionRevoked"));
    }

    const db = getSystemDb();
    const user = await db.user.findFirst({
      where: { id: claims.sub, tenantId: claims.tid },
      include: { tenant: true },
    });
    if (!user) throw new UnauthorizedException(t()("errors.auth.accountNotFound"));

    const rawSiteId = this.header(req, "x-site-id");
    // X-Site-Id is attacker-controlled, so it is shape-checked before it ever
    // reaches Prisma. Without this, a header of "'; drop--" is not a security
    // hole (queries are parameterised) but it *is* an unhandled driver error
    // surfacing as a 500, which turns a rejected request into a noisy one.
    const requestedSiteId =
      rawSiteId && UUID_RE.test(rawSiteId) ? rawSiteId : undefined;
    if (rawSiteId && !requestedSiteId) {
      throw new ForbiddenException(t()("errors.auth.invalidSiteHeader"));
    }

    const siteScoped = this.reflector.getAllAndOverride<boolean>(
      SITE_SCOPED_KEY,
      handler,
    );

    // Tenant-wide memberships (siteId NULL) apply to every site; a per-site
    // membership only to its own. Filtering on tenantId here is what stops a
    // header from pointing at another tenant's site.
    const memberships = await db.membership.findMany({
      where: {
        userId: user.id,
        tenantId: user.tenantId,
        ...(requestedSiteId
          ? { OR: [{ siteId: requestedSiteId }, { siteId: null }] }
          : {}),
      },
    });

    let role: Role | undefined;
    let siteId: string | undefined;

    if (requestedSiteId) {
      const site = await db.site.findFirst({
        where: { id: requestedSiteId, tenantId: user.tenantId },
        select: { id: true },
      });

      if (site && memberships.length > 0) {
        // A role granted directly on the site beats the tenant-wide fallback.
        const specific = memberships.find((m) => m.siteId === requestedSiteId);
        const wide = memberships.find((m) => m.siteId === null);
        role = (specific ?? wide)?.role as Role | undefined;
        siteId = site.id;
      }
    }

    if (siteScoped && !siteId) {
      throw new ForbiddenException(t()("errors.auth.siteRequired"));
    }

    // Routes that are not site-scoped (e.g. GET /sites) still need a role for
    // permission checks; fall back to the tenant-wide one.
    role ??= memberships.find((m) => m.siteId === null)?.role as Role | undefined;
    if (!role) {
      const anyMembership = await db.membership.findFirst({
        where: { userId: user.id, tenantId: user.tenantId },
      });
      role = anyMembership?.role as Role | undefined;
    }
    if (!role) throw new ForbiddenException(t()("errors.auth.noRole"));

    const permissions = [...permissionsForRole(role)];

    req.actor = {
      userId: user.id,
      tenantId: user.tenantId,
      email: user.email,
      role,
      permissions,
      siteId,
    };

    const required =
      this.reflector.getAllAndOverride<Permission[]>(PERMISSIONS_KEY, handler) ?? [];
    const missing = required.filter((p) => !permissions.includes(p));
    if (missing.length > 0) {
      // A denied request never reaches a service, so it would leave no audit row
      // at all — and "someone repeatedly tried to do something they may not" is
      // precisely what an operator wants to see. Recorded here, at the refusal.
      this.events.record("auth.permission_denied", {
        userId: user.id,
        tenantId: user.tenantId,
        siteId,
        role,
        missing,
        path: req.path,
        method: req.method,
        ip: this.clientIp(req),
      });

      throw new ForbiddenException(
        t()("errors.auth.missingPermissions", {
          permissions: missing.join(", "),
          role,
        }),
      );
    }

    return true;
  }

  private checkInternalToken(req: AuthedRequest, scope: InternalScope): boolean {
    const provided = this.header(req, "x-internal-token") ?? "";

    // The privileged (worker) token is accepted everywhere. The render token, if
    // configured, is accepted only on "render" endpoints — so site-runtime's
    // token opens `/render/resolve` but not `/mail/deliver`. When it is unset,
    // this collapses to the single-token behaviour that predates the split.
    const accepted = [this.config.getOrThrow<string>("CMS_INTERNAL_TOKEN")];
    if (scope === "render") {
      const renderToken = this.config.get<string>("SITE_RUNTIME_INTERNAL_TOKEN");
      if (renderToken) accepted.push(renderToken);
    }

    // Constant-time compare against each candidate: a naive === leaks the token
    // one byte at a time to anyone who can measure the response.
    const b = Buffer.from(provided);
    const matched = accepted.some((tok) => {
      const a = Buffer.from(tok);
      return a.length === b.length && timingSafeEqual(a, b);
    });
    if (!matched) {
      throw new UnauthorizedException(t()("errors.auth.invalidInternalToken"));
    }
    return true;
  }

  private extractBearer(req: AuthedRequest): string | undefined {
    const header = this.header(req, "authorization");
    if (!header?.startsWith("Bearer ")) return undefined;
    return header.slice("Bearer ".length).trim() || undefined;
  }

  private clientIp(req: AuthedRequest): string {
    return req.ip ?? req.socket?.remoteAddress ?? "unknown";
  }

  private header(req: AuthedRequest, name: string): string | undefined {
    const value = req.headers[name];
    return Array.isArray(value) ? value[0] : value;
  }
}
