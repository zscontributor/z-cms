# Z-CMS architecture

This document records **decisions and the reasons behind them**, not a description
of the code. The code already says what it does; the expensive thing to know is
why it does it that way.

## Founding principle

> Familiar CMS experience, SaaS-grade architecture.

An end user should recognise everything: install a theme, change the colours,
write a post, install a plugin. Underneath, Z-CMS deliberately does **not** copy
the conventional plugin model, where third-party code runs inside the web
server's process with the full privileges of core, and one broken plugin takes
the whole site down with it.

Three boundaries that are not allowed to break:

1. **A theme must not know the database exists.** It receives a `RenderPayload`
   and imports nothing but `@zcmsorg/theme-sdk`.
2. **Plugin code must never run inside the cms-api process.**
3. **Tenant isolation is guaranteed by the database, not by code.**

---

## Architecture at a glance

This is the map to read before the decisions below. Boxes are deployable services
or durable infrastructure; arrows show who initiates a call. A theme and a plugin
are packages, not services: the theme is loaded by `site-runtime`, while plugin
code is loaded only by `plugin-runtime` and then only inside a V8 isolate.

```text
                                      Z-CMS

  USERS / INTERNET                    APPLICATION SERVICES
  =================                   ====================

  +-------------------+     +---------------------+
  | Public visitor    |     | site-runtime        |
  | site.example.com  |---->| public SSR + themes |-----+
  +-------------------+     +---------------------+     | one render API call
                                                        |
  +-------------------+     +---------------------+     v
  | Administrator     |     | admin-web           |   +---------------------------+
  | example.com/admin |---->| administrative UI   |-->| cms-api                   |
  +-------------------+     +---------------------+   | NestJS control/data plane |
                              authenticated JSON API | - auth + permissions      |
                                                     | - content/media/menus      |
                                                     | - themes/plugins/settings |
                                                     | - render payload builder   |
                                                     | - plugin gateway          |
                                                     | - audit + queue producer  |
                                                     +--+--------+---------+-----+
                                                        |        |         |
                                  +---------------------+        |         +----------+
                                  |                              |                    |
                                  v                              v                    v
       +----------+-----------+       +-----------+----------+      +----------+----------+
       | PostgreSQL           |       | Redis                |      | S3-compatible store |
       | - platform catalogue |       | - render cache       |      | - media objects     |
       | - tenant data + RLS  |       | - cache generations |      | - signed packages   |
       | - audit/plugin state |       | - rate limits/tokens  |      +---------------------+
       +----------------------+       | - BullMQ queues      |
                                      +-----------+----------+
                                                  |
                                                  | consumes jobs
                                                  v
                                      +-----------+----------+
                                      | worker               |
                                      | - mail delivery      |
                                      | - image variants     |
                                      | - sitemap/cleanup    |
                                      | - deferred plugins   |
                                      | - marketplace sync   |
                                      +----------------------+

  PLUGIN SECURITY BOUNDARY
  ========================

       cms-api -- execute { plugin key, hook, scoped token } --> plugin-runtime
                                                                  |
                                                                  v
                                                        +---------+---------+
                                                        | isolated-vm      |
                                                        | V8 isolate       |
                                                        | no DB/S3/Redis   |
                                                        | no process/fetch |
                                                        +---------+---------+
                                                                  |
                                       scoped SDK RPC only         |
       cms-api plugin gateway <------------------------------------+
       checks token + permission + tenant RLS before doing anything

  PACKAGE SUPPLY CHAIN
  ====================

       Publisher --> signed theme/plugin --> Marketplace/registry
                                              |
                                              | verify + mirror metadata/package
                                              v
                                           cms-api --> S3 package store
                                              |
                 +----------------------------+---------------------------+
                 |                                                        |
                 v                                                        v
       site-runtime verifies signature                          plugin-runtime verifies signature
       before importing a theme                                 before isolating a plugin
```

### Component responsibilities

| Component | Owns | Must not own |
| --- | --- | --- |
| `admin-web` | Administrative UI, schema-driven settings forms | Database access, plugin execution |
| `site-runtime` | Host/path routing, theme loading, SSR, metadata and runtime-owned browser widgets | Draft filtering, database credentials, plugin secrets |
| `cms-api` | Authentication, permissions, tenant context, business rules, render payloads and gateways | Executing third-party plugin code |
| `plugin-runtime` | Package verification and isolated plugin execution | Database, Redis, S3 or SMTP credentials |
| `worker` | Slow, scheduled and retryable work | Serving synchronous browser requests |
| PostgreSQL | Durable state and tenant isolation through RLS | Caching or package execution |
| Redis | Cache generations, rate limits, token revocation and BullMQ | Durable source-of-truth content |
| S3-compatible storage | Media and signed package bytes | Authorization decisions |
| Marketplace | Package catalogue, signatures and revocation feed | Tenant installation state |

### Repository map

The monorepo mirrors the runtime boundaries. A contributor looking for a change
should start here rather than importing across app boundaries.

```text
  z-cms/
  |
  +-- apps/
  |   +-- admin-web/       administrative Next.js application
  |   +-- site-runtime/    public Next.js renderer and theme loader
  |   +-- cms-api/         NestJS API, render builder and security gateways
  |   +-- plugin-runtime/  isolated-vm host with no platform credentials
  |   +-- worker/          BullMQ consumers and scheduled work
  |
  +-- packages/
  |   +-- schemas/         shared HTTP/domain DTOs and validation contracts
  |   +-- database/        Prisma client, tenant transaction context and RLS checks
  |   +-- theme-sdk/       the only platform API a theme may import
  |   +-- plugin-sdk/      capability-based API exposed inside a plugin isolate
  |   +-- queue/           typed job names and payloads shared by API and worker
  |   +-- package/         .zcms archive, signature and manifest verification
  |   +-- i18n/            locale negotiation, catalogues and locale metadata
  |   +-- scanner/         static checks applied to marketplace submissions
  |   +-- cli/             scaffolding, build and package developer commands
  |
  +-- themes/              first-party examples and the built-in fallback theme
  +-- plugins/             first-party plugins such as SEO and zAI
  +-- infrastructure/      Docker images, Compose topology and database bootstrap
  +-- docs/                architectural decisions and operating contracts
```

The important distinction is between the **control plane** and the **render
plane**. Admin writes go through permissions, validation, audit and cache
invalidation. Public reads receive one pre-shaped `RenderPayload`; a public
theme never assembles a page by querying internal APIs itself.

### Flow 1 — public page render

```text
  Browser             site-runtime             cms-api             Redis/PostgreSQL
     |                      |                       |                       |
     | GET /vi/blog/post    |                       |                       |
     | Host: example.com    |                       |                       |
     |--------------------->|                       |                       |
     |                      | GET /render/resolve   |                       |
     |                      | hostname + path + page|                       |
     |                      |---------------------->|                       |
     |                      |                       | read cache generation |
     |                      |                       | and render cache      |
     |                      |                       |---------------------->|
     |                      |                       |                       |
     |                      |                       | cache miss: open one  |
     |                      |                       | tenant transaction,   |
     |                      |                       | SET LOCAL tenant_id,  |
     |                      |                       | read published data   |
     |                      |                       |---------------------->|
     |                      |                       |                       |
     |                      |<----------------------| RenderPayload         |
     |                      |  site + theme + menus + content/archive       |
     |                      |  + alternates + capabilities + integrations   |
     |                      |                       |                       |
     |                      | verify/load theme package                     |
     |                      | build ThemeContext                            |
     |                      | render template + integration slots           |
     |<---------------------|                                               |
     | HTML + metadata + CSS|                                               |
```

On a cache hit, the database and plugin runtime are not on the visitor's path.
On a miss, `cms-api` still returns only published content. `site-runtime` is not
trusted to remove drafts after the fact.

Theme/plugin integration also follows this flow:

```text
  active plugin manifest             cms-api public projector
  capabilities: ["ai.assistant"] ---> allow-lists safe public fields
                                                |
                                                v
                                   RenderPayload.integrations
                                                |
                                                v
  theme: ctx.hasCapability() / ctx.getIntegration() / ctx.renderSlot()
                                                |
                                                v
                           runtime-owned interactive widget in the browser
```

A plugin never sends arbitrary settings into the browser. Credentials are
private by default; only a core-owned projector may place explicitly selected
fields in `RenderPayload.integrations`.

### Flow 2 — authenticated admin write

```text
  Admin          admin-web            cms-api                 PostgreSQL / Redis
    |                |                   |                           |
    | edit + save    |                   |                           |
    |--------------->|                   |                           |
    |                | request + JWT     |                           |
    |                | + X-Site-Id       |                           |
    |                |------------------>|                           |
    |                |                   | verify token              |
    |                |                   | verify site membership    |
    |                |                   | check permission string   |
    |                |                   | validate request schema   |
    |                |                   | begin tenant transaction  |
    |                |                   | SET LOCAL app.tenant_id   |
    |                |                   |-------------------------->|
    |                |                   | write + audit log         |
    |                |                   | bump/delete cache keys    |
    |                |                   |-------------------------->|
    |                |<------------------| result                    |
    |<---------------| update UI         |                           |
```

`X-Site-Id` is input, not identity. The API accepts it only after proving the
site belongs to the token's tenant and that the user may act on that site.

### Flow 3 — plugin hook execution

Actions are asynchronous from the user's point of view; filters are synchronous
and tightly bounded. Neither kind runs in `cms-api`.

```text
  cms-api                    plugin-runtime / isolate             plugin gateway
     |                                  |                               |
     | event or filter                  |                               |
     | resolve ACTIVE installs          |                               |
     | mint 60s scoped token            |                               |
     | POST /execute { key, hook }       |                               |
     |--------------------------------->|                               |
     |                                  | verify/load signed bundle     |
     |                                  | run handler in V8 isolate     |
     |                                  |                               |
     |                                  | ctx.content.get(...)          |
     |                                  |------------------------------>|
     |                                  |    scoped token               |
     |                                  |                               | verify scope
     |                                  |                               | enter tenant RLS
     |                                  |<------------------------------|
     |                                  | safe DTO / 403                |
     |<---------------------------------|                               |
     | action: log failure and continue |                               |
     | filter: use transformed value,   |                               |
     |         or original on failure   |                               |
```

The isolate has no `process`, `require`, `fetch` or host credentials. Even if
plugin code escapes its SDK shim, the gateway remains the authority and refuses
methods or scopes the installation was not granted.

### Flow 4 — jobs, mail and other deferred work

```text
  HTTP request / scheduler
             |
             v
          cms-api ---- enqueue typed payload ----> Redis / BullMQ
                                                       |
                                                       v
                                                    worker
                                      +----------------+----------------+
                                      |                |                |
                                      v                v                v
                                    SMTP              S3            cms-api
                                  mail.send       media/sitemap   internal run-job
                                                                        |
                                                                        v
                                                                  plugin-runtime
                                                                  deferred hook

                              any failure --> retry with backoff --> failed set / DLQ
```

The queue carries typed payloads from `@zcmsorg/queue`. Request handlers do not
wait for SMTP, image processing, sitemap generation or deferred plugin jobs.

---

## Decision 1 — Tenant isolation by Row-Level Security, not by `where`

**The problem.** In a multi-tenant CMS, exactly **one** query that forgets
`where: { tenantId }` leaks one customer's data to another. Across hundreds of
queries and several developers, the probability of forgetting is 100% — the only
open question is when.

**The decision.** Push isolation down into Postgres:

- Every business table has `tenant_id` + `ENABLE ROW LEVEL SECURITY`.
- Policy: `USING (tenant_id = current_tenant_id())` and `WITH CHECK (…)` — reads
  and writes both.
- `cms-api` connects as the **`zcms_app`** role: `NOBYPASSRLS`, and it **owns no
  table**. The table owner (`zcms`) is the role that is exempt from RLS, and it
  is used only for migrations and seeds.

**Why the two roles must be separate.** A table owner is **not** subject to its
own policies (unless `FORCE` is set). If the app connected as the owner, RLS
would become meaningless without a single warning. That is the worst class of
bug: security that *looks* enabled.

> The single most important invariant in the system: `APP_DATABASE_URL` must
> **never** point at the owner role.

**How the tenant is attached to a query.** `withTenant()` opens a transaction and
runs `set_config('app.tenant_id', $1, true)`. The whole request runs inside that
transaction, carried through `AsyncLocalStorage`.

**Why a transaction, and not middleware or a client extension.** `SET LOCAL`
binds the setting to a **connection** and lasts for the **transaction**. Prisma
takes a connection from the pool per query — setting the variable outside a
transaction stamps one connection and then runs the query on another.

Prisma recommends a Client Extension for this, and that road is **broken**: an
extension that calls `$transaction` from inside an interactive transaction opens
a new connection and **silently loses** the context ([prisma#20678][1]). The bug
is invisible in tests and catastrophic in production.

**Fail closed.** `current_setting('app.tenant_id', true)` returns an empty string
when unset. `NULLIF(…, '')::uuid` turns that into NULL, every comparison fails,
and the query returns **zero rows**. A query without tenant context must see
*nothing* — never *everything*.

**Verify, do not trust.** `pnpm --filter @zcmsorg/database verify:rls` attacks the
system with five scenarios and asserts that all five are blocked.

### Platform tables vs tenant tables

| Kind | Tables | RLS |
| --- | --- | --- |
| Platform | `themes`, `theme_versions`, `plugins`, `plugin_versions`, `publishers`, `marketplace_syncs` | No — a shared marketplace catalogue the app only reads |
| Tenant | every table with `tenant_id` | Yes |

"Every table with `tenant_id`" is not a convention we try to keep — it is the
mechanism. The RLS migration loops over the catalog (`pg_attribute`) and enables
row-level security on any table that carries the column, so **adding `tenant_id` is
what turns isolation on**. A new tenant table cannot be forgotten.

Installing a theme **writes to `site_themes`** (a tenant table), never to the
catalogue. A tenant cannot modify another tenant's marketplace.

### `getSystemDb()` — the controlled back door

Some things must cross tenants, because at that moment the tenant is not yet known:

- Logging in by email.
- Resolving a hostname to a site (and, on cache invalidation, a site back to its domains).
- Reading the theme/plugin catalogue.
- The plugin gateway and the plugin token service, which are called by the sandbox
  and carry a plugin token rather than a user session.

Everything else that touches customer data goes through `withTenant()`, where RLS —
not a `where` clause — does the filtering.

**Two exceptions remain, and we are not proud of them.** `plugins.service.ts`
(`site_plugins`, `sites`) and `mfa.service.ts` (2FA secrets, `recovery_codes`) read
tenant tables on the system connection, supplying `tenantId` as a filter. That is
isolation by care rather than by the database — the exact thing this design exists to
avoid. They are listed under [What we still owe](#what-we-still-owe-plainly) because a
gap you have written down is a gap someone can fix.

---

## Decision 2 — `X-Site-Id` is attacker-controlled input

The site id arrives in an HTTP header, so it is **not** trustworthy. `AuthGuard`
accepts it only after:

1. The header is a well-formed UUID (otherwise 403 — never let Prisma throw a 500).
2. The site belongs to the **tenant in the token**.
3. The user has a membership on that site (or a tenant-wide role).

Tested: an OWNER of Z-SOFT pointing `X-Site-Id` at another tenant's site gets
**403**, even though that row genuinely exists in the database.

---

## Decision 3 — One public request = one API call

`GET /render/resolve?hostname=…&path=…` returns **everything** needed to build a
URL: site, theme + settings, menus, content or archive, capabilities.

**Why not several endpoints.** The public page is the hot path of the entire
platform. If a render fanned out into four calls (site, theme, menu, content),
every cache miss would cost four round trips, and invalidation would become a
coordination problem across four keys. One payload = one Redis key to drop.

**Only `PUBLISHED` content leaves `RenderService`.** site-runtime is *not*
trusted to filter drafts out. If a draft is never in the payload, then a bug in a
theme cannot leak it either.

### Cache tags: by `(hostname, path)`, not by `siteId`

site-runtime knows the Host header **before** it knows the site id, so it tags by
hostname. cms-api only knows the site id, so on invalidation it looks up the
`domains` table to translate back. One site can answer on several domains, and
each domain holds its own cached copy of the same page; missing one means still
serving stale content.

### Site-wide purges are a version bump, not a keyspace scan

Themes and menus live in the header and footer of **every** page, so activating a
theme or editing its settings invalidates the whole site, not one path. Purging
only `/` would leave the rest of the site rendering the old theme until its TTL
expired.

Render keys carry the site's cache generation:

```
cms:render:{siteId}:v{n}:{page}:{path}
cms:sitever:{siteId}        -> n
```

A site-wide purge is therefore a single `INCR` on `cms:sitever:{siteId}`
(`CacheService.invalidateSite`). The old keys are not touched at all: every
reader now composes keys with the new version, so the previous generation is
simply no longer addressable and falls out on its own TTL.

The alternative — `SCAN` for `cms:render:{siteId}:*` — is a cursor walk over
*every* key in the instance to find the few thousand belonging to one site. That
is work proportional to the whole platform in order to serve one tenant's theme
change, and it gets worse as other tenants grow. (`KEYS` is worse still: it
blocks the Redis event loop across the entire keyspace.)

Page-level invalidation (`invalidateSitePaths`, used when content is published)
still deletes exact keys, because the key is fully derivable from
`(site, version, path, page)` — cheap and precise.

> **INVARIANT: the version counter must never be evicted.** It is written with
> **no TTL**, so `volatile-*` eviction policies — which only consider keys that
> have one — can never reclaim it. Do **not** run this Redis under
> `allkeys-lru`: if the counter were evicted while keys from an earlier
> generation were still live, the next `INCR` would return to a generation whose
> keys are still cached, and the site would serve stale pages until they expired.

A missing counter reads as "generation 0", which is the correct reading for a
site nobody has edited yet. A Redis outage reads the same way: the worst case is
a payload built and written under a version nobody will read — a cache miss,
never stale content.

---

## Decision 4 — A theme is a package; its settings are a JSON Schema

A theme is not hard-imported into site-runtime:

```ts
import CorporateTheme from "@/themes/corporate";   // ❌ every theme install means a rebuild
```

`resolveTheme()` asks the loader, which downloads the signed package — from
`marketplace.z-cms.org`, or from whichever registry this instance pinned a key for
— verifies it against that pinned public key, unpacks it into a cache directory
and `import()`s it. Installing a theme is **data, not a deploy** — see
[distribution.md](./distribution.md).

The default theme stays compiled into the build on purpose: it is the fallback
for everything that can go wrong with a downloaded one — bad signature, missing
bundle, broken module, cms-api unreachable — so it must not itself depend on any
of that working. A theme that will not load degrades to the default and reports
`degraded: true`. A site rendering the wrong theme deserves an alert; a site
rendering a 500 to every visitor is an outage.

Settings are declared as **JSON Schema**; the admin generates the form straight
from it. Adding an option to a theme **requires no change to admin-web** — the
same "JSON-driven UI" model covers roughly 70–80% of plugins.

`resolveThemeSettings()` merges stored values with the schema defaults **at read
time**. That way a theme upgrade that adds an option does not require migrating
every site's settings.

### Blocks

Core does **not** validate a block's `props` per type. Block types are **open** —
themes and plugins register their own — so the registry lives at runtime. Core
guarantees only the envelope: `{ id, type: "namespace/name", props }`. A renderer
that meets an unknown type **skips** it rather than throwing: one broken block
must not take down the page.

---

## Decision 5 — Permissions are strings; a role is only a bundle of them

`ROLE_PERMISSIONS` lists them explicitly, with no hierarchical inference.

**Why.** This same vocabulary is what a plugin uses to **request** privileges at
install time ("this plugin needs `content:read`") and what an admin **approves**.
If ADMIN implicitly subsumed every permission by hierarchy, the approval screen
would mean nothing.

Some rules **cannot** be expressed as permissions, because they are about a
*state transition* or *ownership*, not about a resource:

- An AUTHOR may only edit content **they created** → checked in the service, next
  to the data.
- An AUTHOR may not publish → checked in `resolveStatus()`.

---

## Decision 6 — A version record is a snapshot, not a diff

Store the whole row state after every write. Restore is a copy, not a replay.
That is what you want at 3 a.m. when somebody has just destroyed the homepage.

---

## Decision 7 — Module format

| Package | Format | Why |
| --- | --- | --- |
| `cms-api` | CommonJS | NestJS needs decorator metadata; this is the best-tested path |
| `database`, `schemas` | build to CJS + `.d.ts` | NestJS `require()`s them at runtime — they cannot ship only TypeScript source |
| `theme-sdk`, `themes/*` | TS source | consumed only by Next.js, via `transpilePackages` |

Prisma 7 generates the client with `moduleFormat = "cjs"` and bare imports, so
Nest's tsc compiles it directly, with no intermediate build step.

**TypeScript is pinned at 5.9.3, not 7.x.** The native port is still too new for
a decorator-heavy codebase like NestJS 11.

---

## Decision 8 — Two translation catalogues, on purpose

`@zcmsorg/i18n` (`packages/i18n`) holds the **platform's** strings: the admin UI,
API error messages, runtime chrome. A **theme ships its own** messages and reads
them through `ctx.t` (`packages/theme-sdk/src/i18n.ts`).

They are separate because they have different lifecycles and different
translators:

- A theme is installed and removed independently of the platform. If its strings
  lived in core, translating a theme would mean shipping a release of Z-CMS, and
  removing a theme would leave dead keys behind forever.
- Whoever localises "Read more" for a magazine theme is not the person who
  localises "Row-Level Security is not enabled on this table".

**English is the base locale**, in both catalogues. Every other locale falls back
to it key by key, so a half-finished translation is a *usable* translation: the
translated keys show in the new language, the rest show in English, and nothing
renders blank. That is what makes it safe to merge a community PR covering 60% of
the app. A missing key falls back to the key itself — an obviously untranslated
string, never a blank space or a crash on a live page.
`pnpm --filter @zcmsorg/i18n check` fails if any locale has drifted from the
English base.

cms-api negotiates the request's locale from `Accept-Language` in
**middleware**, not an interceptor (`apps/cms-api/src/common/i18n.ts`). Nest runs
guards *before* interceptors, so a locale set by an interceptor would not exist
yet when `AuthGuard` throws — and "wrong credentials" is precisely a message a
human reads. The locale then rides in `AsyncLocalStorage` rather than being
threaded through every service signature: a locale passed down four layers is the
kind of parameter that gets dropped, and a dropped locale is a message in the
wrong language with no test to catch it.

---

## Decision 9 — SEO belongs to the theme

The document head is part of the design, so the theme owns it
(`packages/theme-sdk/src/types.ts`, `seo.ts`).

A theme declares `manifest.seo` — title template, icons/favicon, `Organization`
identity, robots — and may implement `Theme.seo(ctx)` to *derive* those from
**its own settings**. That is the point: a site owner who edits "Organisation
name" or "Favicon" in the theme settings form changes the document head, and no
one writes any code.

`resolveSeo()` folds three sources together, most specific first:

1. the **page** — `content.seo`, which a plugin may already have filtered,
2. the **site** — whatever `Theme.seo(ctx)` derives from this site's settings,
3. the **theme** — `manifest.seo`, the defaults it ships with.

`organization` and `icons` are merged field by field rather than replaced
wholesale, so a site that overrides only the logo does not lose the theme's
address and social profiles by doing so. site-runtime turns the result into a
Next.js `Metadata` object plus a schema.org `Organization` JSON-LD block; the SDK
itself returns plain objects and reaches for no framework.

One asymmetry is deliberate: a page may opt **out** of indexing, but it cannot
opt **in** against a theme that set `robots.index = false` site-wide. That is
exactly what makes a single setting usable as a staging-wide kill switch — no
page can override it.

---

## Decision 10 — Object storage is S3, and read access is a property of the bucket

Media and packages live in S3-compatible object storage, addressed through
`@aws-sdk/client-s3` with `forcePathStyle: true` (self-hosted S3 services address
buckets as a path, not a subdomain). Development runs **RustFS** (Apache-2.0) in
`infrastructure/docker/docker-compose.yml`; production can be AWS S3, Cloudflare
R2, or anything else that speaks the API — the code does not change.

**Uploads deliberately carry no ACL parameter.** RustFS rejects a `PutObject`
that carries one, so per-object ACLs are not portable in the first place. Public
read access is set **once, on the bucket**, by the `storage-init` sidecar at
first boot. This is the better shape anyway: the upload path is not where the
decision "is this readable?" belongs.

The storage key is generated by the server (`sites/{siteId}/{uuid}{ext}`), never
taken from the client's filename — otherwise `../../etc/passwd`, or a collision
with another tenant's object, would be the caller's choice.

---

## The admin's UI

admin-web draws its icons with **Phosphor Icons** (`@phosphor-icons/react`)
through a name registry (`apps/admin-web/src/components/shell/icon.tsx`). Call
sites pass a *string*, not a component, because some names are data — a content
type carries an `icon` field from the API, and the admin has to draw it without
knowing in advance which icons exist. An unknown name falls back to a document
glyph instead of throwing.

---

## Service ports

`3000` / `3001` / `4000` are usually already taken by another project on a dev
machine, so Z-CMS uses:

| Service | Port |
| --- | --- |
| site-runtime | 3100 |
| admin-web | 3101 |
| cms-api | 4100 |
| plugin-runtime | 4200 |
| worker | none — it consumes the queue, nothing calls it |

Hostnames in the `domains` table **must match** the site-runtime port
(`localhost:3100`) — that is the key site resolution is done by.

---

## The rest of the system, in one paragraph each

The decisions above are the load-bearing ones. These modules exist too, and each has
a doc or a service worth reading before you change it.

**Jobs.** Anything slow, retryable or scheduled leaves the request path for BullMQ:
image variants, mail, sitemaps, deferred plugin hooks, the hourly marketplace sync,
and nightly housekeeping. The API enqueues, `apps/worker` consumes, and both import
the same payload definitions from `@zcmsorg/queue`, so a payload change breaks the build
rather than a production job. Failures land in a dead-letter queue the admin can
inspect and retry. → [jobs.md](./jobs.md)

**Marketplace and the kill switch.** Themes and plugins are installed from a signed
registry, and an hourly job pulls a signed revocation list. A revoked package is moved
to `QUARANTINED` — not `INACTIVE`, so an admin cannot simply click it back on. The
verification is fail-open on a registry outage and refuses a rewound list, so neither
a downed registry nor a replayed old list can be used against you.
→ [distribution.md](./distribution.md)

**Users, invitations and 2FA.** Membership is per site, roles gate every route through
guards, access is invited by email, and TOTP two-factor with recovery codes is
available to any user. Refresh tokens rotate in families: replaying a rotated token is
read as theft and revokes the whole family, in flight or not. Security events go to an
audit log. → `apps/cms-api/src/{auth,users,audit}`

**Mail.** SMTP is configured per site, sending is a queued job with a dead-letter
report, and plugins can observe `mail.sending` / `mail.sent` / `mail.failed` — but a
plugin can never set the `From` address, only `replyTo`. → `apps/cms-api/src/mail`

**Content in many languages.** An entry carries a `locale` and a `translationGroupId`;
the group is what makes "the Vietnamese version of this page" a link rather than a
convention, and it is what lets the renderer emit `hreflang` alternates.
→ [i18n.md](./i18n.md)

**The AI assistant (Z-AI).** An optional plugin plus an API module, offering an
assistant in the admin and a chat surface a theme can render on a public site. It runs
under the same permission model as any other plugin. → `apps/cms-api/src/ai`, `plugins/zai`

---

## What we still owe (plainly)

This list is kept honest deliberately. Everything on it is a real gap, verified
against the code — not a caveat we forgot to delete.

- **`getSystemDb()` still reads a handful of tenant tables.** The design says
  tenant data is reached through `withTenant()` and RLS, never through a
  hand-written `where: { tenantId }`. Two paths break that rule today:
  `plugins.service.ts` reads `site_plugins` and `sites`, and `mfa.service.ts`
  reads 2FA secrets and `recovery_codes`, both on the RLS-exempt connection with
  the tenant supplied as a filter. They are safe as written — but they are safe
  by care, which is exactly the property this architecture exists to stop relying
  on. Both should move behind `withTenant()`.
- **A deferred plugin job cannot use the budget it is promised.** The sandbox
  gives a `job` handler 30s (`plugin-runtime/src/sandbox/runner.ts`), but cms-api
  aborts its call to the runtime at 12s for every invocation kind
  (`plugins.service.ts`), so a job that runs longer than 12s dies on the network
  backstop rather than its own deadline. Either the abort is per-kind, or the
  budget is 12s and the runner should say so.
- **Nothing quarantines a plugin for misbehaving at runtime.** A marketplace
  revocation quarantines it automatically (see [distribution.md](./distribution.md)),
  but a plugin that merely fails, hangs or gets killed on every invocation keeps
  being invoked. Repeated failures should trip a breaker.
- **The marketplace review step is only half automated.** Submissions are scanned
  statically (`@zcmsorg/scanner`, and a package that fails is refused), but there is
  no dependency-vulnerability scanning and no human review of a first-time
  publisher.
- **`ThemeSettingsSchema` is declared twice** (`theme-sdk`, and a mirror in
  `admin-web/src/lib/theme-schema.ts`) because the admin must not depend on
  theme-sdk. It should be promoted to `@zcmsorg/schemas`.
- **The bundled plugins have no coverage floor.** Every package and app enforces
  one; `plugins/seo` and `plugins/zai` set none, so their tests can rot without CI
  noticing. See [testing.md](./testing.md).
- **`next start` still binds 3000 / 3001.** Only `next dev` is remapped to
  3100 / 3101, so a production start contradicts the ports documented everywhere
  else.

Deliberate, and not on this list: **deleting media deletes the row and keeps the
object.** A broken image on a live page is worse than an orphaned object in a
bucket. The object is reclaimed later by the nightly `media.sweep` job, which only
touches objects older than 24 hours — see [jobs.md](./jobs.md).

[1]: https://github.com/prisma/prisma/issues/20678
