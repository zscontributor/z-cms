# Plugin architecture

## The principle

> Plugin code **never** runs inside the cms-api process.

In the conventional plugin model, third-party code runs in-process with core and
with all of core's privileges. The consequence is that the question "what can
this plugin do?" has no answer shorter than reading its entire source.

In Z-CMS the answer is a file — `plugin.json` — an admin approves it, and the
runtime **enforces** it.

```
cms-api                    plugin-runtime                  isolate
(has DB, S3, session)      (NO credentials)                (nothing at all)
    │                            │                             │
    │  POST /execute {key}       │                             │
    ├───────────────────────────►│  loads the bundle from disk │
    │                            ├────────────────────────────►│ runs the hook
    │                            │                             │
    │  ◄── RPC (scoped token) ───┤ ◄─── ctx.content.get() ─────┤
    │  checks scope + RLS        │                             │
```

Three things in that diagram matter:

1. cms-api sends a **key**, not code. A compromised cms-api still cannot use this
   endpoint to run arbitrary JavaScript.
2. plugin-runtime has **no** `DATABASE_URL`, `S3_*` or `REDIS_URL`. Not "does not
   use them" — does not have them.
3. Permission checks happen on the **other side** of the trust boundary. A plugin
   that patches the checks on its own side gains nothing.

---

## What happened: the first sandbox was **broken**

The first version used `node:vm` plus a worker thread. It *looked* right. Then we
wrote a hostile plugin to attack it:

```
BLOCKED  require('fs')          blocked: Only "@zcmsorg/plugin-sdk" is available
BLOCKED  process.env            blocked: process is not defined
BLOCKED  fetch()                blocked: fetch is not defined
LEAKED   constructor escape     SUCCEEDED
```

Digging further, the escapee had:

```
REACHED  read /etc/passwd       ## User Database ...
REACHED  spawn shell            z-soft
```

`this.constructor.constructor("return process")()` climbs out of the vm context
and back into Node's realm. **`node:vm` is not, and has never been, a security
boundary** — Node's own documentation says so, and people keep using it as one.

No code review would have caught this. **Only a real attack caught it.**

## Today: `isolated-vm`

A plugin runs inside its own **V8 isolate** — its own heap, holding no reference
whatsoever to Node's realm. There is no `process` to escape *to*.

```
PASS  node builtins (fs, child_process, net)      {"fs":"blocked", ...}
PASS  process, env and globals                    {"process":"blocked", ...}
PASS  constructor escape (the one node:vm lost)   {"escape.passwd":"blocked","escape.shell":"blocked"}
PASS  infinite loop is killed                     Plugin handler exceeded 5000ms
PASS  memory bomb hits the isolate limit          Isolate is already disposed
PASS  plugin cannot reach host globals            {"global":"blocked", ...}
```

Re-run it at any time:

```bash
pnpm --filter @zcmsorg/plugin-runtime verify:sandbox
```

> This suite once **lied**. Run under `tsx`, it could not find `worker.js`, so
> every run failed — and every assertion of the form "this must fail" passed, for
> the wrong reason. It reported "the sandbox is safe" while testing nothing. The
> runner now throws loudly if the worker is missing, and the script builds before
> it tests.

---

## Four layers of defence

| Layer | What it stops | Verified by |
| --- | --- | --- |
| **V8 isolate** | No `require`, `process`, `fs`, `fetch`; no host globals | `verify:sandbox` 1,2,3,6 |
| **Timeout + memory** | Infinite loops (5s action / 800ms filter), memory bombs (64MB) | `verify:sandbox` 4,5 |
| **Scoped token** | A plugin calling an API outside its grant → 403 | tested end-to-end |
| **Container** | If all three above fail: read-only FS, `cap_drop: ALL`, non-root, no credentials | `docker-compose.yml` |

The last layer *assumes the first three have already failed*. "The sandbox cannot
be broken" is not a claim anyone should bet a platform on.

---

## The anatomy of a plugin

### Theme integration boundary

Themes do not import plugins or call plugin-runtime. An active plugin contributes
a capability; cms-api may attach a core-owned, allow-listed public projection to
`RenderPayload.integrations`; and the theme reads it through
`ctx.getIntegration(capability)`. Interactive browser UI remains owned by
site-runtime and is positioned by the theme through `ctx.renderSlot(slot)`.

This is intentionally stricter than letting a plugin return arbitrary JSON. A
plugin receives private settings, including credentials, inside its sandbox. If
its return value were copied blindly into the public render payload, it could
publish those credentials. Every public projector therefore lives in core and
names each field it permits.

A plugin is one call to `definePlugin`, and everything it can do is visible in that
object. There is no ambient anything: no `import` of the database, no `fetch`, no
`process`. What arrives as `ctx` is what exists.

```ts
import { definePlugin } from "@zcmsorg/plugin-sdk";

export default definePlugin({
  // Runs once when the plugin is activated. 10s budget.
  setup: async (ctx) => { await ctx.storage.set("installed-at", Date.now()); },

  // Fire-and-forget. The CMS does not wait for these. 5s budget.
  actions: {
    "content.published": async (content, ctx) => { … },
    "mail.failed":       async (mail, ctx) => { … },
  },

  // Transform a value the CMS is about to use. The CMS *does* wait. 800ms budget.
  filters: {
    "content.seo":  (seo, content, ctx) => ({ ...seo, title: `${seo.title} · Blog` }),
    "mail.sending": (mail, ctx) => ({ ...mail, html: withUnsubscribe(mail.html) }),
  },

  // Deferred work, dispatched from the queue back into this same sandbox.
  jobs: {
    "recheck-all": async (payload, ctx) => { … },
  },
});
```

The vocabulary is fixed — a plugin cannot invent a hook the host does not fire:

| Kind | Hooks |
| --- | --- |
| **Actions** | `content.created`, `content.updated`, `content.published`, `content.unpublished`, `content.deleted`, `theme.activated`, `plugin.activated`, `mail.sent`, `mail.failed` |
| **Filters** | `content.seo` — the metadata a page renders with; `mail.sending` — the letter, before it is handed to SMTP |

`content.seo` is the one the whole capability story rests on: it is how an SEO plugin
rewrites a page's title, description and JSON-LD without the theme knowing which
plugin (or whether any) is installed.

A plugin can also declare a **`settingsSchema`** (JSON Schema) in its manifest. The
admin generates the settings form from it, and the values arrive as `ctx.settings` —
so a plugin gets a configuration UI without shipping a line of admin code.

---

## Requesting and granting permissions

A plugin declares what it needs in its manifest:

```json
{ "permissions": ["content:read"], "capabilities": ["seo.metadata"] }
```

The admin sees exactly that list, and **may grant only part of it**:

```bash
POST /api/v1/plugins/vn.zsoft.plugin.seo/install
{ "grantedPermissions": ["content:read"] }
```

Two rules are enforced at the API:

- Granting a permission the plugin **never requested** → **400**. A plugin's
  privileges may not exceed its own manifest.
- A plugin calling an API outside `grantedPermissions` → **403** at the gateway.

Verified: revoke `content:read`, then publish →
`Plugin "vn.zsoft.plugin.seo" was not granted the "content:read" permission` —
**and the website still returns HTTP 200**. A broken plugin breaks the plugin,
not the site.

The credential a plugin runs under is not a user session. It is minted per
invocation, lives **60 seconds**, names one plugin and one site, and carries the
granted scopes *inside the signed token* — the gateway never takes a plugin's
word for what it is allowed to do. It is signed with a different key than user
tokens, so a plugin token can never be replayed as a user session, nor the
reverse.

`METHOD_SCOPES` in `plugin-gateway.controller.ts` **is** the policy: a method
that is not in that table does not exist for plugins, and a method that is in it
cannot be called without the scope written beside it.

Two families of method carry **no** scope, deliberately: `storage.*` and
`jobs.enqueue`. Neither can reach anything but the plugin's own data — storage keys are
namespaced from the token, and a deferred job re-enters the same sandbox under the same
grants. A permission prompt for "may this plugin write to its own scratch space" would
train admins to click through prompts, which is how you lose the ones that matter.

---

## The four shapes a plugin's code can take

| | Action | Filter | Call | Job |
| --- | --- | --- | --- | --- |
| When | after an event happened | transforms a value in the render path | someone asks the plugin a question | later, off the request path |
| Does the CMS wait? | **no** (fire-and-forget) | **yes** | **yes** | no — the queue runs it |
| Returns a value? | no | yes | **yes** | no |
| Timeout | 5s | **800ms** | 30s | 30s |
| If the plugin fails | log it, move on | skip it, use the original value | the caller gets the error | BullMQ retries |

(`setup` gets 10s, on activation.)

Publishing a post must **not** wait for third-party code, and must **not** fail
because that code is broken. A plugin reacts to the CMS; it does not block it.

A filter does block — which is why it is capped hard and why its result is
**cached alongside the render payload**: one sandbox call per page per TTL, not
one per visitor. A public page that makes a serial HTTP call through every
installed plugin on every request is precisely how a plugin marketplace turns
into a platform-wide incident.

### Call: the shape that lets a plugin *be* a service

A call is the one where **the CMS asks and the plugin answers**. Nothing else
expresses that: an action returns nothing, a job answers nobody, and a filter
returns a value but has 800ms because a page is waiting on it.

The zAI plugin is why this exists. Reaching OpenAI through `ctx.http` takes seconds,
and the answer has to come back to whoever asked. So a call gets the job's 30s
budget — nothing is rendering while it runs, which is exactly why it may be slow and
a filter may not.

Callers reach a call **by capability, not by plugin key**:

```ts
const { answer } = await plugins.callCapability(
  tenantId, siteId, "ai.assistant", "chat", { messages },
);
```

cms-api asks for whoever provides `ai.assistant`. It does not know zAI's id, which is
what makes an AI plugin swappable for a different one without a line of core changing
— the same reason a theme probes `ctx.hasCapability` instead of naming a plugin.

The exception, and it is deliberate: `{ requireCore: true }`. The admin content
operator turns the model's reply into content CRUD under the *actor's* permissions,
and any marketplace package can put `"capabilities": ["ai.assistant"]` in its
manifest. A capability string is a claim; `isCore` is a platform-controlled column.
That one call insists on the second.

---

## Mail: a plugin writes the letter, the host addresses the envelope

`ctx.mail.send` lets a plugin email people. It costs the `mail:send` scope, and
it is the most dangerous-looking capability in the vocabulary for a reason that
has nothing to do with the CMS: an SMTP server handed to third-party code is a
spam cannon pointed at the operator's own domain reputation, and reputation is
not restored by uninstalling the plugin.

So the split is drawn at the envelope:

```ts
await ctx.mail.send({
  to: "subscriber@example.com",
  subject: "Your weekly digest",
  html: "<h1>This week</h1>…",
  replyTo: "editors@example.com",   // optional
});
```

There is **no `from`**, and its absence is the design. The sender is whatever an
admin configured in *Settings → Mail*, resolved on the far side of the gateway. A
plugin that could set it could send as `billing@` the site's own domain, signed
by the operator's SPF record — which is not a plugin capability, it is a
phishing kit. `replyTo` is the honest way to steer a reply and it is the one a
plugin gets.

A plugin also never sees the SMTP host, port, username or password. They are not
in `ctx.settings`, not in the sandbox, and never on the wire to it. The plugin
says *what* to send; the host decides *how*.

**`send` resolves when the mail is queued, not when it lands.** SMTP takes
seconds and can hang for a minute; an action handler gets five seconds. Delivery
happens on the `mail.send` job, with BullMQ's exponential backoff — so a mail
server that is down at 09:00 sends at 09:05 instead of losing the email. The
outcome comes back as an event, not a return value:

| Hook | Kind | When |
| --- | --- | --- |
| `mail.sending` | filter | immediately before the SMTP hand-off — rewrite the letter, or cancel it |
| `mail.sent` | action | the server accepted it |
| `mail.failed` | action | the queue gave up, after the retries |

`mail.sending` is the hook a mail plugin actually wants: append an unsubscribe
footer, wrap the html in the site's template, tag the subject, or refuse the send
entirely by returning `send: false`. It fires for **every** email the site sends
— the CMS's own invitations included — because a plugin that only sees its own
mail cannot implement a suppression list, which is the main thing anyone builds
here.

```ts
filters: {
  "mail.sending": (mail, ctx) => ({
    ...mail,
    html: mail.html ? `${mail.html}<hr><a href="…">Unsubscribe</a>` : undefined,
  }),
}
```

Note what the filter's value does **not** contain: `to`. The recipients are in
the *context*, not the value, so a plugin may edit the letter and refuse to post
it — but it may not readdress it to somewhere else. Cancelling another plugin's
mail is real power; silently redirecting it would be a mail interception
primitive.

Two limits sit on the plugin path and neither applies to the CMS's own mail
(rate-limiting a password reset would be breaking the product to defend against
the wrong thing):

- **A per-site hourly quota**, counted per *recipient*, not per call —
  `MAIL_PLUGIN_HOURLY_LIMIT`, 200 by default. It is what bounds how bad a
  compromised plugin gets to be. Unlike the login limiter it **fails closed**: if
  Redis cannot be reached the send is refused, because an uncounted send is
  precisely what the quota exists to prevent.
- **Deduplication on content**, as with `ctx.jobs.enqueue`. A hook that fires
  twice on one publish sends one email.

---

## Network: the plugin names the host, the host opens the socket

A translation plugin has to reach DeepL. An AI plugin has to reach OpenAI. A
plugin ecosystem that cannot leave the building is not an ecosystem, and the honest
answer to "can a plugin call an external service?" has to be yes.

The answer is **not** to put `fetch` in the sandbox. There still isn't one — the
isolate has no network stack, and [the attack tests](../apps/plugin-runtime/src/verify-sandbox.ts)
still prove it. `ctx.http.fetch` is the same RPC as `ctx.storage.get`: the plugin
describes a request, and **cms-api** is the process that dials.

That indirection is the whole feature. It is what lets an admin approve this:

```json
{
  "permissions": ["network:fetch"],
  "network": {
    "hosts": ["api.deepl.com"],
    "secrets": { "deeplKey": "apiKey" }
  }
}
```

```ts
const res = await ctx.http.fetch({
  url: "https://api.deepl.com/v2/translate",
  method: "POST",
  headers: { authorization: "DeepL-Auth-Key {{secret:deeplKey}}" },
  body: { text: [value], target_lang: "VI" },
});
```

Read those two together, because neither works alone. `network:fetch` is a scope
that grants nothing on its own; `network.hosts` is a list that grants nothing
without the scope. **The question an admin is asked is never "may this plugin use
the internet?" — it is "may this plugin reach `api.deepl.com`?"**, and the consent
screen shows exactly that list. A scope that granted the open internet would be one
nobody could reason about, so there is no way to ask for it: `"*"` is refused at
install.

### What the gateway does that the plugin cannot be trusted to

Every one of these lives in
[`plugin-egress.ts`](../apps/cms-api/src/plugins/plugin-egress.ts) and
[`plugin-egress.service.ts`](../apps/cms-api/src/plugins/plugin-egress.service.ts),
and every one of them is a way this feature would otherwise be a critical bug:

- **The host must be one the manifest declared.** Read from the installed version's
  manifest, from the database, on this call — never from the token and never from
  the request. `*.openai.com` matches `api.openai.com` and deliberately not
  `openai.com` (two hosts, two decisions) and not `evil-openai.com` (a suffix match
  on the string, rather than the labels, is how you hand an attacker the domain).

- **The address it resolves to must be public**, and that is checked **at connect
  time**, inside the dispatcher's `lookup`. Not before it. A hostname the plugin
  declared honestly, on a domain it owns, whose A record points at `127.0.0.1`, is
  the entire attack — and a check that resolves the name and then hands the *name*
  to an HTTP client leaves a window for the record to change between the two. Here
  the addresses that pass the check are the addresses that get dialled.
  `169.254.169.254` — one unauthenticated GET from the instance's IAM credentials —
  is unreachable from a plugin whatever its manifest says.

- **Redirects are followed one hop at a time**, and each hop goes through both
  checks again. `maxRedirections` in any HTTP client would walk an allowlisted host's
  `Location: https://169.254.169.254/` straight into the metadata service. Cross-origin
  hops drop the plugin's headers, because those headers may hold a substituted secret
  and the first host does not get to choose who receives it.

- **HTTPS, port 443, no credentials in the authority.** `https://api.deepl.com@evil.com/`
  is a request to `evil.com`, and a filter that string-matched the URL rather than
  parsing it would read the opposite.

- **Bounded**: 10s, 1MB of response (counted as bytes arrive, not trusted from
  `content-length`), and a per-site hourly quota (`PLUGIN_HTTP_HOURLY_LIMIT`, 1000
  by default) that **fails closed**, exactly like mail's.

### Secrets: spent, never read

This is the part worth dwelling on, because it is the part that makes a *compromised*
plugin survivable rather than merely a *well-behaved* one safe.

**A setting declared `format: "password"` never enters the sandbox.** It is stripped
from `ctx.settings` before the isolate starts. The plugin asked for a field to put a
key in; that is not the same as asking to read it back.

To spend it, the plugin maps it in `network.secrets` and writes `{{secret:deeplKey}}`
where the key would go. The gateway substitutes the real value **after** it has
approved the host — the plugin never holds the string.

The order matters and it is not stylistic. Substitution into the URL happens *before*
the URL is parsed and the host is checked, because a plugin can write
`https://{{secret:apiKey}}/` — and a check that ran first would be validating a
hostname that no longer exists by the time we dial. Substitute, then parse, then judge
what you will actually connect to. For the same reason, **every error message is
redacted before it goes back to the plugin**: the refusal above names the host it
refused, and the host *was* the key.

What this buys: the strongest thing a compromised plugin can do with a key it cannot
read is spend it at the host its own manifest declared and an admin approved. It
cannot post the key to a pastebin, because it does not have the key.

### The proof: zAI is now actually a plugin

The design is only worth anything if it survives the hardest case in the repo, so it
was made to.

`apps/cms-api/src/ai/ai.module.ts` used to open with `const ZAI_KEY =
"vn.zsoft.plugin.zai"` and contain three `fetch()` calls — to `api.openai.com`,
`api.anthropic.com` and `generativelanguage.googleapis.com` — reading the API keys
straight out of the plugin's settings row. The "plugin" was a settings form with a
capability string on it. The real rule for the marketplace was therefore: *you may
call an external service if Z-SOFT writes a NestJS module for you.*

All of that is gone. The provider calls live in
[`plugins/zai/src/index.ts`](../plugins/zai/src/index.ts), in the sandbox, and go out
through `ctx.http` under three declared hosts. Core no longer names zAI at all — it
asks for `ai.assistant` — and a test asserts the file contains no provider hostname,
no `ApiKey`, and no `fetch(`.

What zAI has, and what it conspicuously does not:

- It talks to three paid APIs and **holds none of their keys**. They are
  password-format settings, so they never enter the isolate; it writes
  `{{secret:openaiKey}}` and the gateway fills it in.
- It has to *pick* a provider, which means knowing which keys exist — so `ctx.secrets`
  gives it `{ openaiKey: true, claudeKey: false }`. Booleans. The host answers "is it
  configured?" and still refuses "what is it?".
- A compromised zAI can spend the site's OpenAI quota. It cannot steal the key, and it
  cannot post the site's content anywhere but to OpenAI, Anthropic or Google.

### zAI is a built-in, and built-ins are signed too

zAI ships with z-cms, so it never goes through the marketplace — but "ships with us"
is not the same as "trustworthy". It is the code with the most privilege in the
system, and until recently it was the only code with no signature between it and the
isolate: plugin-runtime read `plugins/zai/dist/index.js` off the volume and ran it.

It is now a signed `.zcms`, committed next to its source, verified against
`FIRST_PARTY_PUBLIC_KEY` before it executes. Editing `dist/index.js` on the volume
does nothing, because nothing reads it. So does the manifest come out of the signed
payload — otherwise anyone who could edit `plugin.json` could widen `network.hosts`
past the three the admin approved, without touching a byte of signed code. See
[distribution.md](./distribution.md#the-third-question-is-our-own-code-our-own-code).

**On a new site, zAI arrives installed and switched OFF, with nothing granted.**
Both halves are deliberate:

- *Installed*, because a plugin nobody can find is a plugin nobody uses. zAI is part
  of what z-cms is; making every site hunt for it in a catalogue is a worse product
  for no security gain.
- *INACTIVE, `grantedPermissions: []`*, because the alternative is a site that boots
  running a plugin holding `network:fetch`, approved by nobody. **Turning it on is
  where the consent screen appears** — and that screen is where an admin learns it
  reaches `api.openai.com` and two other hosts. A consent screen skipped for the
  plugins we happen to ship is a consent screen that means nothing, and ours are the
  ones it should mean the most for.

`installCorePlugins` is idempotent and never revokes: re-running the seed will not
reset a grant an admin made, nor switch off a plugin they turned on.

### How this compares

WordPress does not solve this problem; it avoids having it. Plugins there are PHP
running in-process with core, free to `curl` anywhere — `wp_remote_get()` is a
convenience, not a boundary, and `WP_HTTP_BLOCK_EXTERNAL` is an opt-in constant
most sites never set. What actually guards the ecosystem is human review and a
guideline requiring plugins to *disclose* the services they call. That is
disclosure and trust, not enforcement, and the WordPress plugin ecosystem's
security record is the price.

The model here is the browser extension's: declare your hosts up front
(`host_permissions`), have the user approve them by name, and let the platform —
not the extension — hold the socket.

---

## Storage: a plugin does not touch core tables

`ctx.storage` is the normal answer for almost every plugin: a key/value space in
the `plugin_data` table, namespaced by `(plugin, site)`:

```ts
await ctx.storage.set(`audit:${contentId}`, { issues: [...] });
```

`tenant_id`, `site_id` and `plugin_id` are stamped **from the token**, never from
a parameter the plugin sends. A plugin has no way of even *naming* someone else's
id. And a plugin that only uses `ctx.storage` cannot reach the core schema at
all, because it holds no database handle: the runtime process has no
`DATABASE_URL`.

A few plugins genuinely need relational tables — an analytics plugin with
millions of rows should not be storing them as JSON blobs. Those get real tables,
under two laws that are now **enforced, not merely stated**
(`packages/plugin-sdk/src/database.ts`):

1. **A plugin never alters, drops or migrates a core table.** Not "should not" —
   it is not granted the privilege.
2. **Every table a plugin owns is named with the prefix derived from its own
   id**, so ownership is legible from the name alone and two plugins can never
   collide:

   ```
   "vn.zsoft.plugin.seo"  ->  p_vn_zsoft_plugin_seo__
   ```

The prefix is **derived, not declared**. A plugin allowed to pick its own prefix
would pick `content_`, and the rule would be back to trusting the plugin. It is a
pure function of the plugin id, which the marketplace already guarantees is
unique — and of the *full* reverse-DNS id, not its last segment, because two
publishers are both entitled to ship a plugin called "seo".

A plugin declares its tables in `manifest.database.tables`, and
`apps/cms-api/src/plugins/plugins.controller.ts` **refuses to install** a plugin
that names a table outside its prefix — before the plugin exists on the site and
before a single line of its code has run. That is the only moment at which
rejecting it is cheap. `validatePluginTables()` also rejects names that are not
valid identifiers, and names longer than 63 bytes (Postgres would silently
truncate, and two tables differing only past byte 63 would become one table).

---

## Capabilities: swapping a plugin does not mean changing the theme

A plugin *provides* a capability; a theme *probes* for one:

```tsx
if (ctx.hasCapability("commerce.products")) {
  return <ProductSection />;
}
```

So a site can move from one SEO plugin to another without editing its theme — as
long as both declare `seo.metadata`.

---

## What we still owe (plainly)

- **Nothing quarantines a plugin for misbehaving.** A *revoked* plugin is
  quarantined automatically — the hourly marketplace sync pulls a signed revocation
  list and moves it to `QUARANTINED`, which an admin cannot simply click back on
  (see [distribution.md](./distribution.md)). But a plugin that merely fails, hangs
  or gets killed on every single invocation keeps being invoked. Repeated failures
  should trip a breaker.
- **No admin UI for plugins that need client-side code.** Today there is only the
  JSON-driven UI (enough for ~70–80% of plugins). The case that needs a real UI
  should be a sandboxed iframe plus a postMessage bridge — **not** Module
  Federation for community plugins.
- **No plugin-provided blocks.** Themes render blocks; a plugin's block would
  have to be rendered server-side inside the sandbox and returned as sanitised
  HTML.
- **Egress is not blocked at the infrastructure layer, and this now matters more
  than it did.** The isolate gives a plugin no way to open a socket, and every
  outbound request goes through cms-api, where the manifest's host list and the
  address rules are enforced. But that enforcement lives in *one* process, and the
  plugin-runtime container can still reach the internet directly if something ever
  escapes the isolate. Restricting its egress to cms-api and nothing else is what
  makes the host allowlist a boundary rather than a policy — until then, the
  allowlist rests entirely on isolated-vm holding.
- **The marketplace review step is only half automated.** Signing, verification and
  **static scanning** all exist — a submission that calls `eval`, reaches for
  `process` or opens a socket is refused before a human ever sees it
  (`@zcmsorg/scanner`, 12 cases in `pnpm verify`). What is missing is
  dependency-vulnerability scanning and human review of a first-time publisher.
