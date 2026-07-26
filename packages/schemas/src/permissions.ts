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
  /**
   * Draw a theme in the GUI Theme Editor: create, edit and delete a ThemeDraft.
   *
   * Authoring only. A draft is a drawing in this tenant's own database — it renders
   * nowhere, ships nothing, and is verified by nothing, so drawing one is no graver
   * than configuring a theme, and it sits in the same role. The consequential acts
   * come later and are gated separately: BUILDING a draft turns it into signed code
   * (theme:sideload, since it installs unreviewed code onto this instance), and
   * SUBMITTING publishes it to the marketplace under a publisher identity.
   *
   * Splitting it this way is the point. If "draw" and "publish" were one permission,
   * every designer allowed to move a widget would also be allowed to put this
   * company's name on a package a stranger downloads.
   */
  "theme:author",
  /**
   * Put a theme on the public marketplace, under this instance's publisher identity.
   *
   * Separate from `theme:author` for the same reason `theme:sideload` is: drawing is
   * a document in this tenant's database, and publishing puts the company's name on
   * a package a stranger downloads. A designer allowed to move a widget is not
   * thereby allowed to speak for the company in public.
   *
   * OWNER only. It cannot be undone by us — once the marketplace counter-signs an
   * approved package, it is out there.
   */
  "theme:publish",
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
  /**
   * Operate the plugin's OWN relational tables — the ones it declared in
   * `manifest.database` and core created for it, reached through `ctx.db`.
   *
   * Like `network:fetch`, this scope is meaningless on its own and belongs to no
   * role: no human action needs it, it exists for plugins, and an admin grants it
   * to one at install. And like a plugin's tables themselves, it is a first-party
   * privilege — the gateway refuses `db.*` to a plugin that is not first-party
   * even when the scope was granted, because a community plugin has no tables for
   * it to name. A plugin that only uses `ctx.storage` never asks for it.
   */
  "data:own",
  "audit:read",
  /**
   * Read the shop's orders — the customer names, contact details and delivery
   * addresses attached to each.
   *
   * Still in the vocabulary, but held by no role by default: the commerce plugin
   * PROVIDES it (to EDITOR, via `permissionsProvided`) when it is active on a site,
   * so a site with no shop never grants it. It stays a first-class core permission
   * — the Orders controller gates on it, the consent screen describes it — because
   * commerce is a FIRST-PARTY plugin, and a first-party plugin may mint bare keys.
   */
  "order:read",
  /**
   * Move an order along: confirm it, mark it fulfilled, cancel or refund it.
   * Provided by the commerce plugin to ADMIN when active — a refund moves money, so
   * it is a graver trust than `order:read`. Held by no role by default.
   */
  "order:manage",
  /**
   * Configure the storefront: currency, shipping, which payment methods are on.
   * Provided by the commerce plugin to ADMIN when active. Held by no role by default.
   */
  "commerce:configure",
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
  // NB: order:read is deliberately NOT here. The shop is a plugin now — the
  // commerce plugin *provides* order:read to EDITOR (via permissionsProvided with
  // defaultRoles), so a site without commerce active never grants it, and the
  // Orders menu is absent there. Baking it into the role would put a shop on every
  // site whether or not one is installed — exactly the WooCommerce-unlike behaviour
  // this change removes.
];

const ADMIN: Permission[] = [
  ...EDITOR,
  "site:update",
  "content-type:manage",
  "theme:install",
  "theme:activate",
  "theme:configure",
  "theme:author",
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
  // order:manage and commerce:configure are likewise NOT baked in — the commerce
  // plugin provides them to ADMIN when it is active. See the EDITOR note above.
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
  // Publishing under the company's name is the owner's call, like the two above.
  "theme:publish",
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

// ---------------------------------------------------------------------------
// Plugin-provided permissions
// ---------------------------------------------------------------------------

/**
 * A permission key as it flows through a session and a `can()` check — a plain
 * string, because at that point it may be one of two things:
 *
 *   - a {@link Permission}, from the fixed core vocabulary above, or
 *   - a permission a plugin *introduced* (see {@link ProvidedPermission}).
 *
 * The two are deliberately different acts and must not be confused. The core
 * enum is what a plugin *requests to spend* against the host — a plugin asks for
 * `content:read` and the gateway lets it read content. A provided permission is
 * what a plugin *introduces to gate its own surface* — the Orders page a commerce
 * plugin ships is not core's to guard, so the plugin brings the key that guards
 * it. A plugin can never request a provided permission (there is no core API
 * behind it), and it can never provide a core one (core already owns that word).
 *
 * `can(user, key)` is a membership test over the user's effective permission
 * list, so it does not care which kind a key is. Everything upstream of that
 * check — what a plugin may request, what it may provide, what a role grants —
 * does care, and keeps them apart.
 */
export type PermissionKey = string;

/**
 * A permission a plugin introduces at install time to gate its own admin pages,
 * endpoints and actions — WordPress's `add_cap` ("manage_woocommerce"), made
 * legible and namespaced.
 *
 * The plugin declares these in its manifest. The admin sees them on the consent
 * screen next to the core scopes, and `defaultRoles` says which existing roles
 * should hold the new permission the moment the plugin is active — so a shop
 * plugin can say "EDITOR sees orders" without the operator hand-editing roles.
 */
export interface ProvidedPermission {
  /**
   * The permission key. Namespaced (see {@link pluginPermissionPrefix}) so a
   * community plugin can never mint a key that collides with a core permission
   * or another plugin's. First-party (core) plugins are the sole exception and
   * may register bare `resource:action` keys — on this instance they ARE the
   * platform, and a commerce plugin extracted from core keeps `order:read`.
   */
  key: PermissionKey;
  /** One line the admin reads on the consent screen. What holding this allows. */
  description: string;
  /**
   * Roles that should hold this permission by default once the plugin is active.
   * Resolved per session by {@link pluginPermissionGrants}; omit for a permission
   * no role gets automatically (one an operator assigns deliberately, later).
   */
  defaultRoles?: Role[];
}

/**
 * The prefix every provided permission of a community plugin must start with.
 *
 *   "vn.zsoft.plugin.crm"  ->  "x:vn_zsoft_plugin_crm:"
 *
 * Same reasoning as the table prefix: derived from the plugin id (which the
 * marketplace guarantees unique), never chosen by the plugin — a plugin that got
 * to pick its own namespace would pick `order` and we would be back to trusting
 * it. The leading `x:` marks the whole key as plugin-introduced at a glance, so a
 * `can()` on a permission core has never heard of is obviously not a core bug.
 */
export function pluginPermissionPrefix(pluginId: string): string {
  const slug = pluginId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

  return `x:${slug}:`;
}

/** Postgres/consent identifiers stay legible; a longer key is a bug, not a name. */
const MAX_PERMISSION_KEY_LENGTH = 96;

export interface ProvidedPermissionViolation {
  key: string;
  reason: "missing-prefix" | "reserved-core" | "malformed" | "too-long";
}

/**
 * Checks a plugin's declared provided-permissions before any of its code runs —
 * the install-time gate, the only cheap moment to refuse them.
 *
 * `isCore` relaxes the namespacing rule for first-party plugins (see
 * {@link ProvidedPermission.key}); everything else is held to the prefix. A key
 * that duplicates a core permission is refused from a community plugin
 * ("reserved-core") because core already answers for that word — an admin who
 * granted a role `order:read` meant the platform's, not a stranger's.
 */
export function validateProvidedPermissions(
  pluginId: string,
  isCore: boolean,
  provided: readonly ProvidedPermission[] | undefined,
): ProvidedPermissionViolation[] {
  if (!provided?.length) return [];

  const corePermissions = new Set<string>(PERMISSIONS);
  const prefix = pluginPermissionPrefix(pluginId);
  const violations: ProvidedPermissionViolation[] = [];

  for (const { key } of provided) {
    if (key.length > MAX_PERMISSION_KEY_LENGTH) {
      violations.push({ key, reason: "too-long" });
      continue;
    }

    if (isCore) {
      // A first-party key is a bare, well-formed core-shaped word (`order:read`)
      // or a namespaced one — both are theirs to mint. Only shape is enforced.
      if (!/^(x:[a-z0-9_]+:)?[a-z-]+:[a-z-]+$/.test(key)) {
        violations.push({ key, reason: "malformed" });
      }
      continue;
    }

    if (corePermissions.has(key)) {
      violations.push({ key, reason: "reserved-core" });
      continue;
    }

    if (!key.startsWith(prefix)) {
      violations.push({ key, reason: "missing-prefix" });
      continue;
    }

    // After the prefix, one or two lowercase `resource:action` segments.
    const tail = key.slice(prefix.length);
    if (!/^[a-z][a-z0-9-]*(:[a-z][a-z0-9-]*)?$/.test(tail)) {
      violations.push({ key, reason: "malformed" });
    }
  }

  return violations;
}

/**
 * The provided-permission keys a user with these roles holds by default, given
 * the permissions currently active on their site.
 *
 * Pure and additive: it never removes a core grant, it only unions in the plugin
 * keys whose `defaultRoles` intersect the user's roles. The caller (session
 * assembly) concatenates the result onto {@link permissionsForRole}, so a `can()`
 * check downstream sees one flat list and cannot tell a core grant from a plugin
 * one — which is exactly right, because at the point of the check they are the
 * same kind of thing: a permission the user holds.
 */
export function pluginPermissionGrants(
  roles: readonly Role[],
  active: readonly ProvidedPermission[],
): PermissionKey[] {
  const held = new Set<Role>(roles);
  const keys = new Set<PermissionKey>();

  for (const perm of active) {
    if (perm.defaultRoles?.some((r) => held.has(r))) keys.add(perm.key);
  }

  return [...keys];
}
