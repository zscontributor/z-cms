import type {
  PackageMediaDeclaration,
  Permission,
  ProvidedPermission,
} from "@zcmsorg/schemas";
import type { PluginAdminContribution } from "./admin";
import type { PluginTableSchema } from "./table-schema";

/**
 * A plugin declares, up front and in machine-readable form, everything it wants
 * to be able to do. Nothing it did not declare is available to it at runtime.
 *
 * The alternative — the one most plugin ecosystems grew up on — is a plugin that
 * runs in-process with the same privileges as core. There, "what can this plugin
 * do?" has no answer short of reading all of it. Here the answer is this file,
 * the admin approves it explicitly, and the runtime enforces it.
 */

export interface PluginAuthor {
  name: string;
  url?: string;
}

/**
 * Settings form, rendered by the admin straight from this JSON Schema.
 * Same mechanism as themes: a plugin adds an option without admin-web changing.
 */
export interface PluginSettingsSchema {
  type: "object";
  properties: Record<
    string,
    {
      type: "string" | "number" | "boolean";
      title?: string;
      description?: string;
      // "password" does two things. It masks the input, and — the load-bearing
      // one — it withholds the value from the sandbox: a password setting is
      // stripped from `ctx.settings` before the isolate ever starts. A plugin
      // spends such a setting through `network.secrets` and `{{secret:...}}`
      // substitution, or not at all.
      //
      // What it is still NOT is encryption at rest. The value is stored as given,
      // so it is safe from the plugin, not from a database dump.
      format?: "color" | "url" | "image" | "textarea" | "password";
      default?: unknown;
      enum?: string[];
    }
  >;
  required?: string[];
}

/**
 * The hosts a plugin may reach, and the credentials it may spend without seeing.
 *
 * Declared here rather than passed at call time for the same reason `permissions`
 * is: the admin has to be able to read, before install, everything the plugin can
 * do afterwards. "This plugin talks to api.deepl.com" is a sentence an admin can
 * judge. "This plugin uses the network" is not.
 *
 * Nothing here grants anything by itself — it is the *shape* of what `network:fetch`
 * grants, and without that scope in `permissions` it is inert.
 */
export interface PluginNetworkDeclaration {
  /**
   * Exact hostnames, lowercase, no scheme, no port, no path. One optional leading
   * `*.` matches subdomains but never the apex — `*.deepl.com` covers
   * `api.deepl.com` and not `deepl.com`, because those are two decisions and an
   * admin should make them separately.
   *
   * A bare `*` is refused at install. There is no way to ask for the open internet.
   */
  hosts: string[];

  /**
   * Settings this plugin may *spend* but never *read*, as
   * `{ placeholder: settingsKey }`.
   *
   * A settings key named here is withheld from `ctx.settings` — the sandbox never
   * receives its value. The plugin instead writes `{{secret:placeholder}}` into a
   * request header or body, and the gateway substitutes the real value on the far
   * side of the boundary, after the host has already been checked.
   *
   * This is the `mail.send` bargain applied to HTTP: the plugin says what to send
   * and where, the host supplies the credential. An API key the plugin cannot read
   * is an API key a compromised plugin cannot exfiltrate — not to its own hosts,
   * not to anyone's.
   */
  secrets?: Record<string, string>;
}

export interface PluginManifest {
  /** Reverse-DNS id, e.g. "vn.zsoft.plugin.seo". */
  id: string;
  name: string;
  version: string;
  description?: string;
  /**
   * Release notes for THIS version — what changed since the previous one, so an
   * admin approving an update knows what they are getting. Plain text; one change
   * per line reads best. Every version's notes are kept, so the full history is the
   * changelogs of all published versions, newest first.
   *
   * Either a plain string (the English notes) or an object keyed by locale for a
   * translated changelog, `{ en, vi, ja }`. When localized, English (`en`) is
   * required — it is the default a reader sees when their locale is not translated.
   * The admin shows each reader the notes in their own language, English otherwise.
   */
  changelog?: string | Record<string, string>;
  author: PluginAuthor;
  /** Semver range of the Z-CMS engine this build supports. */
  engine: string;

  /**
   * Scopes the plugin is asking for. The admin sees exactly this list on the
   * consent screen, and the gateway rejects any call outside it — a plugin that
   * never asked for `content:read` cannot read content even if it tries.
   */
  permissions: Permission[];

  /**
   * Capabilities this plugin *provides* to themes, e.g. "seo.metadata".
   * Themes feature-detect on these (`ctx.hasCapability(...)`), which is what lets
   * a site swap one SEO plugin for another without touching the theme.
   */
  capabilities?: string[];

  /**
   * Permissions this plugin *introduces* to gate its own admin pages, endpoints
   * and actions — the shop plugin that ships an Orders screen brings the
   * `order:read` that guards it, because that screen is not core's to guard.
   *
   * The complement of `permissions` above, and not to be confused with it:
   * `permissions` are core scopes the plugin *requests to spend* against the host
   * (it asks for `content:read`, the gateway lets it read content);
   * `permissionsProvided` are new keys the plugin *brings into existence* for a
   * role to hold. A plugin can never request one of these (there is no core API
   * behind it) and a community plugin can never provide a core one — every key
   * here is namespaced (`x:<slug>:...`) and validated at install by
   * `validateProvidedPermissions`. First-party plugins may mint bare keys.
   *
   * Each key's `defaultRoles` says which roles hold it the moment the plugin is
   * active, so a plugin can wire "EDITOR sees orders" without the operator
   * hand-editing any role.
   */
  permissionsProvided?: ProvidedPermission[];

  /**
   * What the catalogue shows: up to three screenshots and, optionally, a video.
   *
   * A plugin is harder to photograph than a theme — much of what it does has no
   * screen — but the ones that DO add a screen (an editor panel, a settings page,
   * a storefront) are the ones an admin most wants to see before granting them
   * the permissions above.
   *
   * The images ship inside the signed package, so they are covered by the same
   * signature as the code.
   */
  media?: PackageMediaDeclaration;

  /**
   * Where this plugin is allowed to reach on the internet, and with which of its
   * settings. Inert without `network:fetch` in `permissions` above.
   */
  network?: PluginNetworkDeclaration;

  settingsSchema?: PluginSettingsSchema;

  /**
   * Relational tables this plugin owns.
   *
   * Almost no plugin needs this — `ctx.storage` is the normal answer, and a
   * plugin that omits `database` has no schema footprint at all. It exists for
   * the plugin that genuinely has relational data, and it is bounded by two
   * rules the platform enforces at install time (see `validatePluginTables`):
   *
   *   - a plugin never touches a core table,
   *   - every table it names starts with `pluginTablePrefix(id)`.
   *
   * A plugin that declares a table outside its prefix is refused installation.
   * Declaring the tables here — as a schema core turns into DDL, never as SQL the
   * plugin writes — is what makes that check possible before any of its code has
   * run, and what keeps a plugin-chosen string from ever reaching a `CREATE TABLE`
   * as anything but an already-validated identifier.
   *
   * Owning tables is a first-party privilege: a community plugin is refused a
   * `database` block at install and gets `ctx.storage` instead. The rows a plugin
   * does own are reached through `ctx.db`, which scopes every query to the site
   * and tenant from the plugin's token.
   */
  database?: {
    tables: PluginTableSchema[];
  };

  /**
   * Screens this plugin adds to the admin — a sidebar entry and a list/detail/
   * form over one of its own tables, declared and rendered by core. The plugin
   * ships no admin code; it describes a screen and core draws it, gated by the
   * permissions the entry names. See {@link PluginAdminContribution}.
   */
  admin?: PluginAdminContribution;
}
