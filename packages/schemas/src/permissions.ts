import { z } from "zod";

/**
 * Permissions are strings of the form "resource:action". Roles are just named
 * bundles of them.
 *
 * They are spelled out rather than derived, because this same vocabulary is
 * what plugins will request at install time ("this plugin wants content:read")
 * and what the admin approves. A role hierarchy where ADMIN silently implies
 * everything would make that consent screen meaningless.
 */

export const PERMISSIONS = [
  "site:read",
  /**
   * Create a site — and, with it, claim a hostname.
   *
   * Deliberately NOT in ADMIN, which has `site:update`. A hostname is unique
   * across the whole platform, not just the tenant (see Domain.hostname), so
   * creating a site takes a name out of everyone else's reach. That is the same
   * class of act as deleting one, and it sits in the same role.
   */
  "site:create",
  "site:update",
  "site:delete",
  "content:read",
  "content:create",
  "content:update",
  "content:delete",
  "content:publish",
  "content-type:read",
  "content-type:manage",
  "media:read",
  "media:upload",
  /**
   * Change how the library is filed: rename a file, write its alt text, move it
   * between folders, and create/rename/move the folders themselves.
   *
   * Folders are deliberately not a permission of their own. A folder holds no
   * bytes — it is a label on the library, and the right to relabel the library is
   * the same right whether it is exercised on a file or on the folder it sits in.
   * Deleting a folder still needs `media:delete`, because that is the one folder
   * operation someone can regret.
   */
  "media:update",
  "media:delete",
  "menu:read",
  "menu:manage",
  "theme:read",
  "theme:install",
  "theme:activate",
  "theme:configure",
  /**
   * Install a theme or plugin FROM A FILE, bypassing the marketplace review queue.
   *
   * A tier above `theme:install`/`plugin:install`, and deliberately so: those pull
   * code the marketplace already reviewed and counter-signed; this introduces code
   * that NOTHING outside this instance vouched for. For a theme it is graver still —
   * a theme runs unsandboxed inside site-runtime — which is why the theme variant is
   * additionally gated behind an env flag the operator must set on purpose. Belongs
   * to OWNER only, next to `package:review`: on a self-hosted instance the owner IS
   * the reviewer, and sideloading is them exercising exactly that authority.
   */
  "theme:sideload",
  "plugin:sideload",
  "plugin:read",
  "plugin:install",
  "plugin:activate",
  "plugin:configure",
  "user:read",
  "user:invite",
  "user:manage",
  "settings:read",
  "settings:update",
  /**
   * Send email through the site's own mail configuration.
   *
   * Separate from `settings:update` because they are different questions. Reading
   * and writing the SMTP host is configuration; *using* it is the ability to put a
   * message in someone's inbox with this site's name on the envelope. A plugin
   * that wants to email subscribers needs the second and has no business with the
   * first — and an admin approving it should be asked about exactly that.
   */
  "mail:send",
  /**
   * Make an outbound HTTP request — but only to the hosts the plugin named in its
   * manifest, and only through the gateway, which is the process that actually
   * opens the socket. The plugin never gets one.
   *
   * This scope is meaningless on its own, and deliberately so. The question an
   * admin is asked is never "may this plugin reach the internet?" — it is "may
   * this plugin reach api.deepl.com?", because `network.hosts` from the manifest
   * is shown beside it and the gateway refuses every host outside that list. A
   * scope that granted the open internet would be one nobody could reason about.
   *
   * It belongs to no role. No human action needs it: it exists for plugins, and
   * an admin grants it to one at install.
   */
  "network:fetch",
  "audit:read",
  /**
   * Clear or reject a package the malware scanner quarantined.
   *
   * A marketplace duty, not a tenant one: on z-cms.org it belongs to the platform
   * operator. It is granted to OWNER because a self-hosted instance IS its own
   * marketplace — its owner is the reviewer. It is deliberately NOT in ADMIN.
   */
  "package:review",
] as const;

export const PermissionSchema = z.enum(PERMISSIONS);
export type Permission = (typeof PERMISSIONS)[number];

export const ROLES = ["OWNER", "ADMIN", "EDITOR", "AUTHOR", "VIEWER"] as const;
export const RoleSchema = z.enum(ROLES);
export type Role = (typeof ROLES)[number];

const READ_ONLY: Permission[] = [
  "site:read",
  "content:read",
  "content-type:read",
  "media:read",
  "menu:read",
  "theme:read",
  "plugin:read",
  "settings:read",
];

const AUTHOR: Permission[] = [
  ...READ_ONLY,
  "content:create",
  // An AUTHOR may edit content but not publish it — that is the whole point of
  // separating AUTHOR from EDITOR. Ownership of the specific row is checked in
  // the service layer, since permissions alone cannot express "own posts only".
  "content:update",
  "media:upload",
  // An author who may not set alt text on the image they just uploaded would
  // have to ask an editor to make their own post accessible.
  "media:update",
];

const EDITOR: Permission[] = [
  ...AUTHOR,
  "content:delete",
  "content:publish",
  "media:delete",
  "menu:manage",
];

const ADMIN: Permission[] = [
  ...EDITOR,
  "site:update",
  "content-type:manage",
  "theme:install",
  "theme:activate",
  "theme:configure",
  "plugin:install",
  "plugin:activate",
  "plugin:configure",
  "user:read",
  "user:invite",
  "settings:update",
  // The one who configures the mail server is the one who has to prove it works.
  // Without this, "send a test email" would be a button no role could press.
  "mail:send",
  "audit:read",
];

const OWNER: Permission[] = [
  ...ADMIN,
  "site:create",
  "site:delete",
  "user:manage",
  "package:review",
  // Introducing unreviewed code is the owner's call, and the owner's alone — the
  // same reasoning as package:review, which sits right above.
  "theme:sideload",
  "plugin:sideload",
];

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  VIEWER: READ_ONLY,
  AUTHOR: AUTHOR,
  EDITOR: EDITOR,
  ADMIN: ADMIN,
  OWNER: OWNER,
};

export function permissionsForRole(role: Role): readonly Permission[] {
  return ROLE_PERMISSIONS[role];
}

export function roleHasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

/**
 * The roles ordered by how much they can do.
 *
 * This is NOT a second definition of what a role grants — ROLE_PERMISSIONS above
 * remains the only one, and it is deliberately not a hierarchy. This ranking
 * answers a different question, the one user management cannot avoid asking:
 * *may this person hand out that role?*
 *
 * Without an order, an ADMIN (who holds `user:invite`) could invite an OWNER and
 * be handed `user:manage`, `site:delete` and `package:review` by proxy. Every
 * grant is therefore checked against the granter's own rank: you may hand out
 * your role, or one below it, never one above.
 */
export const ROLE_RANK: Record<Role, number> = {
  VIEWER: 0,
  AUTHOR: 1,
  EDITOR: 2,
  ADMIN: 3,
  OWNER: 4,
};

/** True when `role` may grant `target` — its own rank, or lower. */
export function canGrantRole(role: Role, target: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[target];
}

/** The strongest of a set of roles. Used to collapse memberships into one badge. */
export function highestRole(roles: readonly Role[], fallback: Role = "VIEWER"): Role {
  return roles.reduce<Role>(
    (best, role) => (ROLE_RANK[role] > ROLE_RANK[best] ? role : best),
    fallback,
  );
}
