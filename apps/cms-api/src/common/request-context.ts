import type { Request } from "express";
import type { Permission, Role } from "@zcmsorg/schemas";

/** Who is making this request, and which site they are acting on. */
export interface RequestActor {
  userId: string;
  tenantId: string;
  email: string;
  /** Effective role for the site in `siteId` (or the tenant-wide role). */
  role: Role;
  permissions: Permission[];
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
