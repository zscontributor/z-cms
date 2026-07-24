import type { PackageMediaDeclaration, Permission } from "@zcmsorg/schemas";

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
   * Declaring the tables here, rather than letting a plugin issue DDL, is what
   * makes that check possible before any of its code has run.
   */
  database?: {
    tables: string[];
  };
}
