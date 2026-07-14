import type { Translate } from "@zcmsorg/i18n";
import { PERMISSIONS, type Permission } from "@zcmsorg/schemas";
import type { BadgeTone } from "./format";

/**
 * The consent screen is only meaningful if the admin can read it. A raw scope
 * string like `content:update` tells a developer something and an editor nothing,
 * so every permission in packages/schemas/src/permissions.ts gets a sentence in
 * the catalogue (`plugins.permissions.<scope>`), and this module supplies the one
 * thing a translator must not decide: whether granting it is dangerous.
 *
 * That map is exhaustive by construction — it is typed as Record<Permission, …>,
 * so adding a permission to the vocabulary without classifying it fails the
 * typecheck rather than shipping a checkbox that quietly looks harmless.
 */

export interface PermissionCopy {
  /** What the plugin will be able to do, as a sentence. */
  label: string;
  /** Why it matters / what the blast radius is. Shown under the label. */
  detail: string;
  /** Destructive, or touches people's data / the site's configuration. */
  sensitive: boolean;
}

const SENSITIVE: Record<Permission, boolean> = {
  "site:read": false,
  // Creating a site claims a hostname across the entire platform — a name nobody
  // else can ever take again. A plugin that can do that unprompted is not a
  // harmless one, whatever it created.
  "site:create": true,
  "site:update": true,
  "site:delete": true,
  "content:read": false,
  "content:create": false,
  "content:update": false,
  "content:delete": true,
  "content:publish": true,
  "content-type:read": false,
  "content-type:manage": true,
  "media:read": false,
  "media:upload": false,
  // Relabelling the library — rename, alt text, move between folders. It changes
  // nothing a backup cannot restore, which is the line `media:delete` crosses.
  "media:update": false,
  "media:delete": true,
  "menu:read": false,
  "menu:manage": false,
  "theme:read": false,
  "theme:install": true,
  "theme:activate": true,
  "theme:configure": false,
  "plugin:read": false,
  "plugin:install": true,
  "plugin:activate": true,
  "plugin:configure": true,
  "user:read": true,
  "user:invite": true,
  "user:manage": true,
  "settings:read": false,
  "settings:update": true,
  // Sending mail as the platform is a spam and phishing vector, and it reaches
  // people outside the tenant. A plugin asking for it is asking for a lot.
  "mail:send": true,
  // The plugin can carry this site's data to a third party. The hosts are named
  // and the sandbox still cannot open a socket — but who the data goes to is a
  // decision only the admin can make, and they cannot make it unprompted.
  "network:fetch": true,
  "audit:read": true,
  // Clearing a quarantined package is deciding that code the scanner distrusted
  // may run. There is no more sensitive permission in the system.
  "package:review": true,
  // Introducing unreviewed code from a file — for a theme, code that runs
  // unsandboxed. As grave as package:review, and for the same reason.
  "theme:sideload": true,
  "plugin:sideload": true,
};

const KNOWN = new Set<string>(PERMISSIONS);

export function isKnownPermission(value: string): value is Permission {
  return KNOWN.has(value);
}

/**
 * A manifest is platform data, not our data: a plugin published against a newer
 * schema may request a scope this build has never heard of. We still show it —
 * hiding a scope from the consent screen would be exactly the wrong failure
 * mode — but it is described honestly and treated as sensitive.
 */
export function describePermission(permission: string, t: Translate): PermissionCopy {
  if (!isKnownPermission(permission)) {
    return {
      label: permission,
      detail: t("plugins.permissions.unknown"),
      sensitive: true,
    };
  }
  return {
    label: t(`plugins.permissions.${permission}.label`),
    detail: t(`plugins.permissions.${permission}.detail`),
    sensitive: SENSITIVE[permission],
  };
}

/** True of the sandbox, not of the manifest: enforced by the V8 isolate. */
export const SANDBOX_DENIAL_KEYS: string[] = [
  "plugins.sandbox.database",
  "plugins.sandbox.filesystem",
  "plugins.sandbox.network",
  "plugins.sandbox.environment",
  "plugins.sandbox.crossTenant",
];

/**
 * The denials to show, given what this plugin declared.
 *
 * The network line stays true for a plugin that declared hosts — it still cannot
 * open a socket, and it still cannot reach a host it did not name — which is
 * exactly why it must not sit in a list headed "the plugin CANNOT" next to a
 * checkbox granting network access. Two true statements that read as a
 * contradiction cost more trust than the one we would gain by keeping it.
 *
 * A consent screen the admin stops believing is a consent screen that has stopped
 * working, so a plugin with hosts gets the hosts spelled out instead.
 */
export function sandboxDenialKeys(networkHosts: readonly string[]): string[] {
  if (networkHosts.length === 0) return SANDBOX_DENIAL_KEYS;
  return SANDBOX_DENIAL_KEYS.filter((key) => key !== "plugins.sandbox.network");
}

// ---------------------------------------------------------------------------
// Install status
// ---------------------------------------------------------------------------

export type PluginStatus =
  | "INSTALLING"
  | "INACTIVE"
  | "ACTIVE"
  | "FAILED"
  | "DISABLED"
  | "QUARANTINED";

const STATUS_TONES: Record<PluginStatus, BadgeTone> = {
  INSTALLING: "info",
  INACTIVE: "neutral",
  ACTIVE: "success",
  FAILED: "danger",
  DISABLED: "warning",
  QUARANTINED: "danger",
};

export function describeStatus(
  status: string | null,
  installed: boolean,
  t: Translate,
): { label: string; tone: BadgeTone } {
  if (!installed || !status) {
    return { label: t("plugins.status.NOT_INSTALLED"), tone: "neutral" };
  }
  const tone = STATUS_TONES[status as PluginStatus];
  // An unknown status is shown verbatim rather than guessed at — the API may be
  // newer than this build.
  if (!tone) return { label: status, tone: "neutral" };
  return { label: t(`plugins.status.${status}`), tone };
}
