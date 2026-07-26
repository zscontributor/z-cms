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
}

export interface AuthedRequest extends Request {
  actor: RequestActor;
}

/** Requests from site-runtime, authenticated by a shared internal token. */
export interface InternalRequest extends Request {
  internal: true;
}
