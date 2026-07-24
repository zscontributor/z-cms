import { createParamDecorator, ExecutionContext, SetMetadata } from "@nestjs/common";
import type { Permission } from "@zcmsorg/schemas";
import type { AuthedRequest, RequestActor } from "../common/request-context";

/** Marks a route as reachable without a session (login, refresh, health). */
export const PUBLIC_KEY = "auth:public";
export const Public = () => SetMetadata(PUBLIC_KEY, true);

/**
 * Marks a route as callable only by another of our own services, with a shared
 * internal token instead of a user session.
 *
 * The scope narrows WHICH service. `"privileged"` (the default) accepts only
 * CMS_INTERNAL_TOKEN — the worker channel — and guards side-effecting endpoints
 * like mail delivery and job dispatch. `"render"` additionally accepts
 * SITE_RUNTIME_INTERNAL_TOKEN when one is configured, for the read-only endpoints
 * site-runtime calls to draw a page. Splitting them means a token exfiltrated
 * from site-runtime (which runs third-party theme code in-process) cannot reach
 * `/mail/deliver` and send mail as any tenant.
 */
export type InternalScope = "privileged" | "render";
export const INTERNAL_KEY = "auth:internal";
export const Internal = (scope: InternalScope = "privileged") =>
  SetMetadata(INTERNAL_KEY, scope);

/** Requires the actor's role to grant every listed permission. */
export const PERMISSIONS_KEY = "auth:permissions";
export const RequirePermissions = (...permissions: Permission[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);

/** Requires a valid X-Site-Id header the actor actually has a role on. */
export const SITE_SCOPED_KEY = "auth:site-scoped";
export const SiteScoped = () => SetMetadata(SITE_SCOPED_KEY, true);

export const Actor = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): RequestActor => {
    return ctx.switchToHttp().getRequest<AuthedRequest>().actor;
  },
);

/** The site id from X-Site-Id, guaranteed present on @SiteScoped() routes. */
export const SiteId = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string => {
    const actor = ctx.switchToHttp().getRequest<AuthedRequest>().actor;
    return actor.siteId!;
  },
);
