import type { ContentDto, MailMessageInput } from "@zcmsorg/schemas";

/**
 * Everything a plugin is allowed to touch.
 *
 * This object is the *entire* surface. There is no `require`, no `fs`, no
 * `process.env`, no database handle and no network client inside a plugin — the
 * runtime removes them. If a capability is not a method on this interface, a
 * plugin cannot do it.
 *
 * `http` is not an exception to that, it is an illustration of it: a plugin still
 * has no socket. It hands the host a description of a request and the host, which
 * checked the host against the manifest first, makes it.
 *
 * Every method is async because none of them execute in the plugin's process:
 * they are RPC calls back to the host, which re-checks the plugin's granted
 * scopes on each one. A plugin that was granted `content:read` but not
 * `content:update` gets a rejection from the host, not a local check it could
 * have patched out.
 */

export interface PluginLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/** Key-value storage, namespaced to (plugin, site). Not shared between either. */
export interface PluginStorage {
  get<T = unknown>(key: string): Promise<T | null>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix?: string): Promise<{ key: string; value: unknown }[]>;
}

/** Read access to the site's content. Requires the `content:read` scope. */
export interface PluginContentApi {
  get(contentId: string): Promise<ContentDto | null>;
  list(query?: {
    contentTypeKey?: string;
    status?: string;
    page?: number;
    perPage?: number;
  }): Promise<ContentDto[]>;
}

export interface PluginJobsApi {
  /** Queues background work. The plugin does not get to run a timer itself. */
  enqueue(name: string, payload: Record<string, unknown>): Promise<void>;
}

/**
 * Send email through the site's mail server. Requires the `mail:send` scope.
 *
 * Three things a plugin does NOT get here, and each one is the answer to a way
 * this could go wrong:
 *
 *   - No `from`. The envelope sender is the site's, set by an admin in Settings →
 *     Mail. A plugin that could choose it could send as `billing@` the site's own
 *     domain, signed by the operator's SPF record. `replyTo` is the honest way to
 *     steer a reply and it is the one the plugin gets.
 *
 *   - No SMTP credentials, host, or port. They are never in `settings`, never in
 *     the sandbox, and never on the wire to it. The plugin says *what* to send;
 *     the host decides *how*.
 *
 *   - No delivery result. `send` resolves when the mail is accepted onto the
 *     queue, not when it lands — SMTP is slow and a hook has ~5 seconds. Delivery
 *     happens in the background, with retries, and the outcome comes back as the
 *     `mail.sent` / `mail.failed` actions, which a plugin may subscribe to.
 *
 * Sends are rate-limited per site and deduplicated on their content. A plugin's
 * bug is not allowed to become the operator's spam incident.
 */
export interface PluginMailApi {
  send(message: MailMessageInput): Promise<{ queued: true }>;
}

/**
 * Reach an outside service. Requires the `network:fetch` scope AND a `network`
 * declaration in the manifest naming the host.
 *
 * This is not `fetch`. There is no `fetch` in the sandbox and there is no socket
 * under this method — the plugin describes a request, the gateway makes it, and
 * the plugin gets a value back. Everything that follows from that is the point:
 *
 *   - **The host must be one the plugin declared.** Checked against the manifest
 *     of the installed version, read from the database at call time, never from
 *     anything the plugin sends. A plugin cannot reach a host the admin did not
 *     see on the consent screen.
 *
 *   - **Not the network the server sits on.** The gateway resolves the hostname
 *     and refuses private, loopback and link-local addresses — including on every
 *     redirect, which it follows one hop at a time and re-checks each time.
 *     `169.254.169.254` is not reachable from a plugin, whatever it declared.
 *
 *   - **Credentials the plugin never sees.** A setting declared under
 *     `network.secrets` is withheld from `ctx.settings`. The plugin writes
 *     `{{secret:name}}` where the key would go and the gateway substitutes it
 *     after the host check. The plugin spends the key without holding it.
 *
 *   - **Bounded.** 10s per request, 1MB of response, a per-site hourly quota. A
 *     plugin's retry loop is not allowed to become the operator's egress bill.
 *
 * The response body arrives as text. `json()` is a convenience the SDK does not
 * have anywhere to put — parse it yourself if you want it typed.
 */
export interface PluginHttpRequest {
  url: string;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** `{{secret:name}}` anywhere in a value is substituted by the host. */
  headers?: Record<string, string>;
  /** Text, or an object the host will JSON-encode. Same substitution applies. */
  body?: string | Record<string, unknown>;
}

export interface PluginHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface PluginHttpApi {
  fetch(request: PluginHttpRequest): Promise<PluginHttpResponse>;
}

export interface PluginContext<S = Record<string, unknown>> {
  /** The plugin's own settings for THIS site, merged with schema defaults. */
  settings: S;

  /**
   * Which of the plugin's declared `network.secrets` the admin has actually filled
   * in — `{ openaiKey: true, claudeKey: false }`. The names are the placeholders
   * from the manifest, never the settings keys, and never the values.
   *
   * A plugin needs this and cannot derive it. zAI has to pick a provider, and
   * "which providers have a key?" is a different question from "what is the key?" —
   * the host answers the first and refuses the second. Without it a plugin would
   * have to try a request in order to discover it was never configured, and read a
   * 401 from OpenAI to find out that the admin left a box blank.
   */
  secrets: Record<string, boolean>;
  site: { id: string; name: string; locale: string };
  log: PluginLogger;
  storage: PluginStorage;
  content: PluginContentApi;
  jobs: PluginJobsApi;
  mail: PluginMailApi;
  http: PluginHttpApi;
}
