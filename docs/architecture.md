# Z-CMS architecture

This document describes the architecture that is wired into the source today,
across both repositories:

- `z-cms` — the multi-tenant CMS, public renderer, admin, extension runtimes and
  the **consumer** side of the marketplace;
- `z-cms-marketplace` — the separately deployed operator registry, developer
  portal, review workflow and signing authority.

It records both the important decisions and the concrete paths that implement
them. When a package exists but is not connected to a production request path,
that distinction is called out explicitly.

## Founding principle and boundaries

> Familiar CMS experience, SaaS-grade architecture.

An administrator can create sites, edit content, activate themes and install
plugins without deploying a new application. Underneath, Z-CMS deliberately
separates tenant data, public rendering, privileged core logic, untrusted plugin
code and the marketplace signing authority.

The load-bearing boundaries are:

1. **Tenant isolation is enforced by PostgreSQL RLS.** Application filters remain
   useful, but they are not the final isolation boundary.
2. **Plugin code never runs in `cms-api`.** It runs in `plugin-runtime` inside
   `isolated-vm`, without platform credentials.
3. **A theme receives a pre-shaped `RenderPayload`/`ThemeContext`.** It has no
   database credentials and does not assemble a page by calling internal content
   endpoints.
4. **Executable packages are verified before they are loaded.** Marketplace,
   built-in and sideloaded packages use different pinned trust roots.
5. **The marketplace private signing key is not part of a normal Z-CMS
   deployment.** It belongs to the separate `z-cms-marketplace` operator service.

Themes need one additional qualification: a downloaded theme is currently
imported by `site-runtime`, so it is third-party code inside that process. The
production container is deliberately given no database, Redis, S3 secret or JWT
secret, but a theme is **not** isolated in the same way as a plugin. The
`@zcmsorg/theme-runner` worker-thread implementation exists and is tested, but is
not currently called by `site-runtime`; it must not yet be treated as a deployed
security boundary.

---

## System context

```text
                                       Z-CMS INSTANCE

  Browser
    |
    +-- public URL --------------------> site-runtime (Next.js)
    |                                      |
    |                                      +-- GET /render/resolve --------+
    |                                      +-- integration/commerce proxy  |
    |                                      +-- theme bundle/assets --------|
    |                                                                       v
    +-- /admin ------------------------> admin-web (Next.js) -----------> cms-api
                                                                            |
                            +----------------------+-------------------------+------+
                            |                      |                                |
                            v                      v                                v
                       PostgreSQL              Redis                         S3-compatible
                       tenant data +           render cache +                media, packages,
                       RLS + catalogue         BullMQ + tokens               sitemap, staging
                                                   |
                                                   v
                                                worker
                                   media, mail, sitemap, theme build,
                                   deferred plugin, cleanup, revocation sync

  cms-api -- execute signed plugin + scoped token --> plugin-runtime
       ^                                                   |
       |             capability-limited SDK RPC            |
       +---------------------------------------------------+

  cms-api -- public registry HTTP --> z-cms-marketplace API
                                        |
                         +--------------+---------------+
                         |              |               |
                         v              v               v
                    PostgreSQL       Redis/BullMQ    bundle volume
                    operator data    mail queue      signed .zcms + media
```

The production reverse proxy is expected to serve `admin-web` under `/admin` on
the same origin as each public site and route everything else on that origin to
`site-runtime`. Browser-facing API helpers inside both Next.js applications are
explicit gateways, not arbitrary reverse proxies.

### Deployable components

| Component           | Repository          | Responsibility                                                                                                              | Important boundary                                            |
| ------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `admin-web`         | `z-cms`             | Administrative Next.js UI, server actions, schema-driven forms, theme editor                                                | No database access; calls `cms-api`                           |
| `site-runtime`      | `z-cms`             | Host/path routing, public SSR, metadata, theme loading, runtime-owned widgets, commerce/integration gateways                | Holds only a narrow render token and public verification keys |
| `cms-api`           | `z-cms`             | Auth, permissions, tenant context, content/media/menus, commerce, themes/plugins, render projection, package consumer       | Does not execute plugin code                                  |
| `plugin-runtime`    | `z-cms`             | Verify and run plugin bundles in `isolated-vm`                                                                              | No DB, Redis, S3 or SMTP credentials                          |
| `worker`            | `z-cms`             | BullMQ consumers and schedules                                                                                              | May hold DB/S3 credentials; never executes plugin code itself |
| Marketplace `admin` | `z-cms-marketplace` | Public pages, developer portal and staff console                                                                            | Calls the marketplace API server-side                         |
| Marketplace `api`   | `z-cms-marketplace` | OAuth/staff auth, publisher and package intake, scan/review/sign/revoke, public registry, notifications and mail processors | Holds `MARKETPLACE_PRIVATE_KEY`                               |

### Durable and supporting infrastructure

| Store                       | Source of truth for                                                                                  | Not a source of truth for                                                 |
| --------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Z-CMS PostgreSQL            | Tenants, sites, users, content, media metadata, themes/plugins, orders, audit                        | Cached render payloads or package bytes                                   |
| Z-CMS Redis                 | Render/host cache, cache generations, rate limits/revocation state, BullMQ                           | Tenant content                                                            |
| Z-CMS S3-compatible storage | Media objects, installed package bytes, generated sitemaps, staged theme payloads                    | Authorization                                                             |
| Marketplace PostgreSQL      | Staff/developer identities, publishers and keys, review states, notifications, audit/security events | Bundle bytes                                                              |
| Marketplace Redis           | Mail and maintenance BullMQ state                                                                    | Notification facts; the database-backed reconciler can recreate mail jobs |
| Marketplace bundle volume   | Counter-signed `.zcms` files and extracted catalogue media                                           | Review/authorization decisions                                            |

---

## Repository map

### `z-cms`

```text
apps/
  admin-web/       Next.js administrative UI
  site-runtime/    Next.js public renderer and browser-facing gateways
  cms-api/         NestJS API and all core business policy
  plugin-runtime/  isolated-vm plugin host
  worker/          BullMQ worker and schedules

packages/
  database/        Prisma schema, two clients, tenant context and RLS verification
  schemas/         Shared Zod/domain/HTTP contracts
  i18n/            Core locale catalogue and negotiation metadata
  queue/           Closed job vocabulary, typed payloads and producer
  package/         .zcms archive, manifest, signature, loader and revocation logic
  scanner/         Static package scanner
  plugin-sdk/      Capability API presented to plugin code
  theme-sdk/       Theme contract and ThemeContext types/helpers
  theme-widgets/   Runtime widgets used by visually generated themes
  theme-codegen/   LayoutDocument -> source/CSS -> ESM bundle
  theme-runner/    Worker-thread theme renderer; implemented, not wired into site-runtime
  cli/             Scaffold, key generation, pack and verify commands

themes/            first-party theme source and signed built-in artefacts
plugins/           first-party plugin source and signed built-in artefacts
infrastructure/    development and production container topology
docs/              operating and architectural contracts
```

`themes/*` and `plugins/*` are workspace packages, but the runnable artefact is
the signed `.zcms` package rather than loose source. The default theme is also
compiled into `site-runtime` as the last-resort fallback.

### `z-cms-marketplace`

```text
apps/
  admin/           Next.js public site, developer portal and staff console
  api/
    auth/          staff JWT/TOTP plus developer OAuth and purpose-bound tokens
    developers/    publishers, keys, submissions, API tokens and notifications
    packages/      intake, scan, counter-sign, review, revoke and maintenance
    registry/      public catalogue, bundles, media and revocation feed
    realtime/      short-lived tickets and Socket.IO notification rooms
    queue/         mail delivery and reconciliation
    settings/      operator SMTP and queue operations

packages/
  database/        Marketplace-only Prisma schema
  package/         vendored package/signature implementation from z-cms
  scanner/         vendored static scanner from z-cms

infrastructure/    PostgreSQL, Redis, API/admin images and persistent bundle volume
```

The two vendored packages define a cross-repository protocol. Run
`pnpm vendored:check` in `z-cms-marketplace` when changing package or scanner
logic; signature, archive and scanning behavior must not drift between producer
and consumer. The check currently reports drift; see
[Known gaps and status-sensitive facts](#known-gaps-and-status-sensitive-facts).

---

## Runtime flows

### 1. Public render

```text
Browser          site-runtime               cms-api                 Redis / PostgreSQL
   |                  |                         |                           |
   | GET /vi/path     |                         |                           |
   | Host: site.test  |                         |                           |
   |----------------->|                         |                           |
   |                  | GET /render/resolve     |                           |
   |                  | host + path + page + q  |                           |
   |                  |------------------------>|                           |
   |                  |                         | resolve host/cache version|
   |                  |                         |-------------------------->|
   |                  |                         | cache miss: one tenant    |
   |                  |                         | transaction, published    |
   |                  |                         | content only              |
   |                  |                         |-------------------------->|
   |                  |<------------------------| RenderPayload             |
   |                  | site/theme/menus/content/collections/alternates/    |
   |                  | integrations/commerce                               |
   |                  |                         |                           |
   |                  | verify + load theme, build ThemeContext             |
   |<-----------------| render HTML, metadata and runtime-owned slots       |
```

`RenderService` first resolves the hostname cross-tenant, then opens exactly one
`withTenant()` scope for the site. Only `PUBLISHED` content is projected. Locale
prefixes are separated from the content path, menus are localized, theme/page
collection requests are bounded and deduplicated, and plugin contributions are
reduced to capabilities plus allow-listed public integration data.

React `cache()` in `site-runtime` deduplicates the render fetch shared by
`generateMetadata` and the page component. The CMS response is also cached in
Redis, so a hit does not enter the tenant transaction.

Theme resolution uses the active version's `origin`:

- `BUILTIN` — verify the first-party package with `FIRST_PARTY_PUBLIC_KEY`;
- `MARKETPLACE` — fetch through the internal package endpoint and verify with
  `MARKETPLACE_PUBLIC_KEY`;
- `SIDELOAD` — verify with `OPERATOR_PUBLIC_KEY`.

Bundles are unpacked atomically under `THEME_CACHE_DIR` and imported dynamically.
Concurrent loads of the same version share one in-flight installation. A missing,
invalid or broken active theme degrades to the compiled default theme.

The current render still invokes the loaded theme in `site-runtime`. The
`theme-runner` worker-thread path is not imported from the app and therefore does
not yet provide timeout, memory or per-theme thread isolation in production.

### 2. Administrative request and session rotation

```text
Admin browser       admin-web                 cms-api                 PostgreSQL
     |                   |                       |                         |
     | navigation/action |                       |                         |
     |------------------>| read httpOnly cookies |                         |
     |                   | bearer + X-Site-Id    |                         |
     |                   |---------------------->| authenticate JWT        |
     |                   |                       | prove tenant/site role  |
     |                   |                       | check permissions       |
     |                   |                       | open withTenant()       |
     |                   |                       |------------------------>|
     |                   |                       | write + audit + cache   |
     |                   |<----------------------| result                  |
```

`admin-web/src/lib/api.ts` is the single server-side CMS client. It injects
`Authorization`, `X-Site-Id` and `Accept-Language`, converts non-2xx responses to
typed errors and retries once after a refresh.

The Next.js middleware does not verify JWT signatures. It only checks whether an
access token is near expiry and, when needed, rotates the access/refresh pair in
a context that is allowed to write cookies. `cms-api` remains the authority.
Refresh tokens rotate in families; reuse of an already rotated token revokes the
family.

`X-Site-Id` is untrusted input. `AuthGuard` accepts it only after validating the
UUID, matching the token's tenant, proving site or tenant-wide membership and
checking the route's explicit permission strings. Public and internal routes are
separate modes of the same guard. Internal routes accept a scoped shared token,
not an administrator session.

### 3. Tenant context and database clients

Z-CMS intentionally has two Prisma clients:

- the application client, reached through `db()` inside `withTenant()`, connects
  with `APP_DATABASE_URL` as `zcms_app`;
- the system client, reached through `getSystemDb()`, connects with the owner URL
  for operations that cannot begin with a tenant context.

`withTenant()` opens an interactive transaction, calls
`set_config('app.tenant_id', ..., true)` and carries that transaction through
`AsyncLocalStorage`. `SET LOCAL` must be inside the same transaction as the
queries because pooled connections are otherwise free to change between calls.

Every table with `tenant_id` is covered by the standard RLS policy. An unset
tenant setting evaluates to `NULL`, so tenant rows fail closed. The application
role is `NOBYPASSRLS` and owns no tables.

Platform catalogue tables such as publishers, themes, theme versions, plugins,
plugin versions and marketplace sync state intentionally have no tenant RLS.
Tenant installation state lives separately in `site_themes`, `site_plugins` and
`org_plugins`.

The system client is legitimate for hostname-to-tenant discovery, login lookup,
the shared package catalogue, marketplace/revocation maintenance and worker jobs.
It is also used by asynchronous plugin resolution with explicit tenant/site
filters because the originating HTTP transaction has already ended. Those call
sites deserve extra scrutiny: RLS is not protecting a query made through the
system client.

> **Invariant:** `APP_DATABASE_URL` must never point to the table-owner role.

Use `pnpm --filter @zcmsorg/database verify:rls` after any schema or tenant-context
change.

### 4. Plugin install and execution

Plugins declare permissions, capabilities, optional settings, allowed network
hosts, storage/table declarations and an execution scope in their signed
manifest.

There are two installation tiers:

- `SITE` plugins use `site_plugins` and are installed/configured per site;
- `ORG` plugins use `org_plugins` and are activated once per tenant. Their hooks
  and capabilities apply to every site, while plugin key/value data remains
  site-contextual.

The tier is taken from the signed catalogue record. An administrator cannot turn
a site plugin into an organization plugin through the request body.

```text
cms-api              plugin-runtime / isolate              cms-api gateway
   |                           |                                  |
   | resolve ACTIVE site + org installs                           |
   | mint short-lived scoped token                                |
   | POST /execute ---------------------------------------------->|
   |                           | verify package/signature          |
   |                           | run hook in isolated-vm           |
   |                           |                                  |
   |                           | ctx.content/storage/mail/network  |
   |                           |--------------------------------->|
   |                           |        scoped token               |
   |                           |                                  | verify method,
   |                           |                                  | permission,
   |                           |                                  | plugin/site/tenant,
   |                           |                                  | then withTenant()
   |                           |<---------------------------------|
   |<--------------------------| safe value / failure              |
```

The isolate receives no `process`, `require`, host `fetch` or platform
credentials. Its SDK is capability-based RPC. Network access is performed by
`cms-api` only after checking the manifest allow-list and refusing private/local
targets. Secrets are spent on a plugin's behalf; they are not returned to it.

Actions are dispatched after the originating change and failures are recorded
without rolling that change back. Synchronous filters are bounded and fall back
to the original value on failure. A deferred plugin job is not executed by the
credentialed worker: the worker calls an internal CMS endpoint, which invokes the
same sandbox and gateway later.

Themes do not receive raw plugin settings. `PluginsService` uses core-owned
projectors to place only safe fields in `RenderPayload.integrations`.
`site-runtime` owns browser JavaScript such as the AI assistant and storefront;
the theme only chooses a slot and feature-detects capabilities.

### 5. Theme authoring, build and publishing

The visual Theme Editor stores a validated `LayoutDocument` in `theme_drafts`.
It is data: tokens, templates, widget trees, bindings and per-version changelog.
The API rejects unknown widgets and documents that exceed the render collection
budget.

```text
Theme Editor       cms-api / PostgreSQL        Redis/BullMQ worker       S3 / sideload
     |                       |                         |                       |
     | save LayoutDocument   |                         |                       |
     |---------------------->| DRAFT                  |                       |
     | Build                 |                         |                       |
     |---------------------->| BUILDING + enqueue ---->|                       |
     |                       |                         | codegen + esbuild     |
     |                       |                         | stage payload -------->|
     |                       |                         | operator-sign package |
     |                       |                         | send to cms-api gate  |
     |                       |<------------------------| BUILT / FAILED        |
```

The job contains IDs, not a copy of the document; the worker reads the current
row. `theme-codegen` emits a constant React wrapper plus `layout.json`, bundles
`theme-widgets` into the package and keeps React external. The payload is staged
in S3 before package assembly so later author signing covers exactly those bytes.

Local build/install is privileged by `theme:sideload` and goes through the same
scan, signature and impersonation checks as a manually sideloaded package. A
stuck `BUILDING` older than 15 minutes may be reclaimed; queue failure moves the
draft to `FAILED` rather than leaving it wedged.

For distribution, the author's private key stays in the browser. The browser
signs the staged checksum, `cms-api` verifies that signature and re-hashes the
staged payload, then either returns the sealed `.zcms` or submits it to the
marketplace using the connected developer API token. Submission requires the
separate `theme:publish` permission.

### 6. Marketplace intake and distribution

The marketplace has three caller populations:

| Population | Authentication                                           | Access                                                                     |
| ---------- | -------------------------------------------------------- | -------------------------------------------------------------------------- |
| Public     | none                                                     | Approved catalogue, approved bundle/media download, signed revocation feed |
| Developer  | Google/GitHub OAuth session or narrow API token          | Own publishers, keys, submissions and notifications                        |
| Staff      | Password JWT, role guard and TOTP challenge when enabled | Review, publisher moderation, revoke, settings                             |

Developer session, OAuth handoff and realtime tickets use purpose-derived signing
keys. A token for one purpose fails cryptographic verification in another path.
Machine API tokens are accepted only on routes explicitly marked for a required
scope; currently package submission is the narrow machine entry point.

Package intake follows this order:

1. Bound package size and concurrent scanner work; meter developer submissions.
2. Open the archive without executing it and recompute the payload checksum.
3. Resolve the submitted public key to a registered active publisher key.
4. For a developer, prove that the developer owns that publisher.
5. Verify the publisher signature using the key stored in marketplace PostgreSQL.
6. Enforce monotonic semantic versions and immutable `(kind, key, version)` bytes.
7. Run the static scanner and validate/extract declared media.
8. Counter-sign the checksum with `MARKETPLACE_PRIVATE_KEY`.
9. Store the counter-signed `.zcms`, persist review state and notify the submitter.

Scanner `reject` findings refuse the package. `flag` enters `QUARANTINED`; a clean
community submission enters `PENDING`. A trusted publisher may be auto-approved;
all other accepted submissions require a staff approve/reject decision. Only
`APPROVED`, unrevoked versions appear in public registry responses.

The API serves the public contract:

```text
GET /api/v1/registry/packages
GET /api/v1/registry/bundle/:kind/:key/:version
GET /api/v1/registry/media/:kind/:key/:version/:index
GET /api/v1/registry/revocations
```

The consumer side in `z-cms` never accepts a caller-supplied download URL. It
builds the URL from `MARKETPLACE_URL`, downloads the named package, verifies the
marketplace counter-signature with its pinned public key, re-scans locally and
stores the bytes in S3. Downloading a plugin into the shared catalogue is separate
from installing it on a site/tenant and granting permissions.

An update of an already active package advances only active installations owned
by the acting tenant. Inactive installs stay pinned. Installing a shared catalogue
version must not silently upgrade another tenant.

### 7. Revocation

The operator revoke action marks a marketplace version rejected/revoked so it
leaves the catalogue and enters the signed revocation snapshot. Consumer workers
pull that feed hourly at minute `:07`, verify the signature, recompute its digest
and refuse a rewind older than the most recent accepted `issuedAt`.

Enforcement in Z-CMS is local:

- an active revoked theme is moved to the built-in default;
- affected site and runtime caches are purged;
- an active revoked plugin becomes `QUARANTINED`, so an administrator cannot
  simply reactivate it.

Sync is fail-open: a marketplace outage does not take customer sites down.
`/marketplace/status` exposes staleness because a long time since the last valid
feed is a security condition, not merely a diagnostic.

### 8. Background jobs

`@zcmsorg/queue` defines one closed vocabulary shared by producer and consumer:

| Job                | Execution                                                                    |
| ------------------ | ---------------------------------------------------------------------------- |
| `media.variants`   | Worker reads the source object, generates derivatives with Sharp, updates DB |
| `plugin.deferred`  | Worker calls CMS internal endpoint; plugin runs in `plugin-runtime`          |
| `site.sitemap`     | Worker builds the published URL set and stores `sitemap.xml` in S3           |
| `theme.build`      | Worker generates, bundles, stages and locally signs a drawn theme            |
| `mail.send`        | Worker calls CMS internal mail delivery; CMS owns/decrypts per-site SMTP     |
| `sessions.prune`   | Nightly removal of unusable refresh-token rows                               |
| `media.sweep`      | Nightly removal of old unreferenced objects                                  |
| `marketplace.sync` | Hourly signed revocation sync                                                |

The queue name is `zcms-jobs` with Redis prefix `zcms-app`, preventing accidental
cross-consumption with the marketplace's `mkt-mail`/`zcms-mkt` queues. Failures
use retries/backoff and remain operable through the failed-jobs admin screen.
Mail failures are also reported back to the CMS dead-letter record.

The marketplace runs its BullMQ mail and package-maintenance processors inside
the marketplace API deployment. Notification state is written to PostgreSQL
first; a reconciler re-enqueues unsent notifications if Redis loses queue state.

### 9. Commerce

Commerce is currently a first-party CMS module, not an arbitrary payment plugin.
It provides:

- per-site settings (`enabled`, currency, COD, flat shipping and free-shipping
  threshold);
- public quote, checkout and tokenized order-read endpoints;
- tenant-scoped admin order listing, detail and status changes;
- the `commerce.checkout` public integration projected into render payloads.

The theme renders product affordances and a `commerce` slot. `site-runtime` mounts
the runtime-owned cart/checkout UI and exposes an allow-listed same-origin
`/commerce/*` gateway. It forwards only quote, checkout and one
`orders/<opaque-token>` read with the narrow internal render token.

The browser cart is convenience state, not pricing authority. `cms-api`
re-reads published product content, recomputes unit prices, totals and shipping,
and snapshots those values into `orders`/`order_items`. Current checkout supports
cash on delivery; fulfilment and refund statuses adjust payment state in the
admin workflow.

### 10. SEO, robots and sitemap

SEO resolution remains theme-owned:

1. page/content SEO is most specific;
2. `Theme.seo(ctx)` derives site values from theme settings;
3. `manifest.seo` supplies theme defaults.

`site-runtime` turns the plain result into Next.js metadata and organization
JSON-LD. A page may opt out of indexing but cannot opt into indexing against a
site/theme-wide `robots.index = false`.

`/robots.txt` is generated dynamically from the resolved site's SEO policy and
points at `/sitemap.xml`. Publishing and explicit admin rebuild actions enqueue
`site.sitemap`; the worker stores the generated object, and the public route
serves it through the site's origin.

---

## Cross-cutting decisions

### Render caching and invalidation

`cms-api` render keys include the site's persistent generation:

```text
cms:render:{siteId}:v{generation}:{page}:{path-and-search}
cms:sitever:{siteId} -> generation
```

A site-wide change such as theme activation, theme settings, menus, brand,
commerce configuration or organization plugin state increments the generation.
Old keys become unreachable and expire naturally; no Redis keyspace scan is
needed. The generation key has no TTL and production Redis must not use an
`allkeys-*` eviction policy that could recycle an older generation number.

Precise content changes may delete derivable path keys. Host lookups have their
own ten-minute cache and writers that change domains/brand must explicitly forget
the affected host keys.

`site-runtime` adds Next cache tags by normalized hostname and path. Internal
revalidation routes accept only the internal token and invalidate the matching
page/site tags. Package purge additionally drops the loader's memory/filesystem
cache; note that Node cannot unload an already imported ESM module from the
current process.

### Package origins and signatures

| Origin        | Who signs/vouches                                      | Runtime verification     |
| ------------- | ------------------------------------------------------ | ------------------------ |
| `BUILTIN`     | First-party release pipeline                           | `FIRST_PARTY_PUBLIC_KEY` |
| `MARKETPLACE` | Publisher signature plus marketplace counter-signature | `MARKETPLACE_PUBLIC_KEY` |
| `SIDELOAD`    | Local operator                                         | `OPERATOR_PUBLIC_KEY`    |

The `.zcms` envelope carries the manifest, SHA-256 checksum, publisher key and
signature, plus an optional marketplace counter-signature. The payload is a
bounded archive containing built output and media, not source, `node_modules` or
install scripts. Archive readers refuse absolute paths, traversal, links, special
files and expansion bombs. Unpacking is atomic.

The manifest stored in a catalogue row comes from the verified package. A loose
manifest beside a built-in source tree is not allowed to widen permissions or
network hosts independently of the signed code.

### Permissions

Permissions are explicit strings shared in `@zcmsorg/schemas`; roles are bundles
of those strings. There is no implicit “higher role gets every future
permission.” This vocabulary is also what plugin manifests request and the
installation consent screen grants.

Rules about ownership and state transitions remain in services. For example,
content author ownership, publish transitions, order transitions and the
difference between `SITE` and `ORG` plugin scope cannot be expressed by a generic
route permission alone.

### Content versions and blocks

Content versions are full snapshots, not diffs, so restore is a copy rather than
a replay.

Core validates a block envelope and the registered schemas it knows. Public
rendering remains tolerant: a theme/runtime that encounters an unknown or failing
block skips it or uses an error boundary instead of taking down the whole page.
Theme Editor documents are stricter on write because they are generated against
the current widget registry.

### Internationalization

Core and themes have separate catalogues:

- `@zcmsorg/i18n` owns admin/API/runtime strings;
- each theme ships its own messages and reads them through `ctx.t`.

English is the base locale; Vietnamese and Japanese are currently present.
Missing translated keys fall back to English, then to the key. CMS locale
negotiation happens in middleware before guards and is carried through
`AsyncLocalStorage`, so authentication errors are localized too.

Marketplace UI localization is independent and currently implemented directly
inside `z-cms-marketplace/apps/admin`, with locale-prefixed public, staff and
developer routes.

### Object storage

Z-CMS uses the S3 API with path-style addressing. Development uses RustFS and a
`storage-init` sidecar that creates a public-read bucket. Uploads do not carry
per-object ACLs. Server-generated keys namespace site media and package/staging
objects.

The marketplace intentionally uses a filesystem-backed persistent volume for
bundles and extracted media, not the Z-CMS S3 store. Its API container is
read-only except for that mounted volume and `/tmp`.

---

## Deployment and ports

### Local development

| Process/service                   | Port        |
| --------------------------------- | ----------- |
| Z-CMS `site-runtime` (`next dev`) | 3100        |
| Z-CMS `admin-web` (`next dev`)    | 3101        |
| Z-CMS `cms-api`                   | 4100        |
| Z-CMS `plugin-runtime`            | 4200        |
| Z-CMS PostgreSQL / Redis          | 5432 / 6379 |
| RustFS API / console              | 9000 / 9001 |
| Mailpit SMTP / UI                 | 1025 / 8025 |
| Marketplace admin                 | 3301        |
| Marketplace API                   | 4300        |
| Marketplace PostgreSQL / Redis    | 5442 / 6389 |

The development hostname stored in `domains` includes the public runtime port,
for example `localhost:3100`.

`site-runtime` and `admin-web` production `next start` scripts bind 3000 and 3001
respectively. Production Compose sets those ports explicitly and normally exposes
them through a reverse proxy. Marketplace admin/API use 3301/4300 in both local
and production configurations.

### Network and credential placement

- `cms-api` reaches PostgreSQL, Redis, S3, the marketplace and the sandbox network.
- `plugin-runtime` is placed on an internal sandbox network with `cms-api` as its
  only intended peer and receives no platform credentials.
- `site-runtime` runs non-root, read-only, with dropped capabilities and a tmpfs
  theme/cache directory. It receives public keys, public URLs and a distinct
  read-only render token, not the worker-wide internal token.
- `worker` holds the credentials needed for first-party background work and calls
  scoped CMS internal endpoints for policy-owned operations.
- marketplace API holds its own PostgreSQL/Redis credentials, OAuth/SMTP secrets
  and marketplace private signing key; these do not belong in `z-cms`.

---

## Known gaps and status-sensitive facts

These are present limitations observed in the current source:

- **Theme worker isolation is not active.** `@zcmsorg/theme-runner` implements
  one worker thread per `key@version`, timeouts, memory limits and termination,
  but `site-runtime` still imports and renders themes directly. Until it is wired
  in, it is neither an availability nor confidentiality boundary.
- **A worker thread would still not be a security sandbox.** Even after wiring,
  it would bound loops/crashes and remove environment variables, but would still
  share the process filesystem and network. Theme trust still depends on
  signatures, minimal credentials and the hardened container.
- **Some system-client tenant reads remain.** Async plugin discovery and MFA/plugin
  paths use explicit tenant filters through `getSystemDb()`. They are safe only
  while those filters remain correct, unlike normal RLS-protected `db()` calls.
- **Deferred plugin deadlines disagree.** The sandbox offers a longer `job`
  budget than the CMS HTTP abort used for runtime calls, so the outer request may
  terminate a job before its advertised sandbox budget.
- **Repeated plugin runtime failures do not trip an automatic circuit breaker.**
  Marketplace revocation quarantines a package, but ordinary repeated
  timeout/error behavior does not.
- **Package scanning is static only.** There is no dependency vulnerability/SBOM
  scan. The marketplace's human review covers non-trusted submissions, but cannot
  infer newly disclosed dependency risk from bundled code metadata.
- **The vendored package protocol currently drifts between repositories.**
  `pnpm vendored:check` in `z-cms-marketplace` reports marketplace-local changes
  in `scanner/src/{ast,rules}.ts` and newer `archive`, `build`, `loader`,
  `manifest-rules` and `types` files in `z-cms/packages/package`. Until the
  intended versions are reconciled and synced, producer, registry and consumer
  validation can disagree.
- **Marketplace revocations are a full, unpaginated snapshot.** This is adequate
  at the current scale but not for an unbounded feed.
- **The theme settings schema is duplicated** between the theme-side contract and
  the admin form mirror instead of living once in `@zcmsorg/schemas`.
- **Production and development Next.js ports differ** for the two Z-CMS frontends;
  operations must follow the Compose/reverse-proxy values, not assume the dev
  ports.

Related detailed documents:

- [Plugin architecture](./plugins.md)
- [Packaging and distribution](./distribution.md)
- [Background jobs](./jobs.md)
- [Security model](./security.md)
- [Internationalization](./i18n.md)
- [API contract](./api.md)
- [Testing](./testing.md)
- sibling repository: `z-cms-marketplace/docs/developer-portal.md`
