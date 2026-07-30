import type { Request } from "express";
import type { PermissionKey, Role } from "@zcmsorg/schemas";

/** Who is making this request, and which site they are acting on. */
export interface RequestActor {
  userId: string;
  tenantId: string;
  email: string;
  /** Effective role for the site in `siteId` (or the tenant-wide role). */
  role: Role;
  /**
   * Every permission this actor holds on this request: the role's core grants,
   * plus any provided-permission the site's active plugins grant that role. A
   * plain key list because at this point a core grant and a plugin grant are the
   * same thing — something the user may do.
   */
  permissions: PermissionKey[];
  /** Present only when the request carried a valid X-Site-Id. */
  siteId?: string;
  /**
   * The sites this actor may see at all, when their access is limited to some.
   *
   * `undefined` means "every site in the tenant" — the actor holds a tenant-wide
   * membership (siteId NULL), which is what an OWNER of the whole installation
   * has. A list means they hold only per-site memberships and nothing outside it
   * exists as far as they are concerned.
   *
   * `siteId` above answers "which site is this request about"; this answers
   * "which sites may be listed, opened or named at all" — the question every
   * route that is NOT @SiteScoped (GET /sites, GET /sites/:id) has to ask for
   * itself, because there is no X-Site-Id for the guard to check against.
   */
  siteIds?: string[];
}

export interface AuthedRequest extends Request {
  actor: RequestActor;
}

/** Requests from site-runtime, authenticated by a shared internal token. */
export interface InternalRequest extends Request {
  internal: true;
}
