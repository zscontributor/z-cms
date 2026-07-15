# Z-CMS

**English** | [Tiếng Việt](readme/README.vi.md) | [日本語](readme/README.ja.md)

[![CI](https://github.com/zscontributor/z-cms/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/zscontributor/z-cms/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A multi-tenant CMS with a theme engine and a plugin marketplace. Familiar to use;
underneath, a modern SaaS platform rather than a single-process monolith that runs
third-party code with its own privileges.

**One codebase, many sites.** A single Z-CMS deployment runs any number of
independent sites — brands, branches or customers — each with its own domain,
content, theme and settings. You never fork or clone the source per website: create
a new site from the admin and it runs on the same system. Developers keep one
codebase and one pipeline, and ship every fix and feature to every site at once;
businesses launch another branch or brand in minutes on shared infrastructure,
instead of standing up and separately maintaining a whole install for each site.
That is the difference between operating one platform and babysitting a folder of
near-identical copies.

| Public site | Core API | Database | Cache | Storage | Extensions |
| :--- | :--- | :--- | :--- | :--- | :--- |
| Next.js | NestJS | PostgreSQL<br>row-level security | Redis | S3 | signed packages<br>V8 isolates |

**[z-cms.org](https://z-cms.org)** · docs: **[docs.z-cms.org](https://docs.z-cms.org)** · themes and plugins: **[marketplace.z-cms.org](https://marketplace.z-cms.org)**

Three properties are load-bearing, and each one is verified by a script you can run
yourself rather than asserted in a README:

- **Tenant isolation is enforced by Postgres, not by application code.** A query
  that forgets its tenant filter returns zero rows, not someone else's data.
- **Plugin code never runs in the API process.** It runs in a V8 isolate, in a
  container that holds no database, storage or session credentials.
- **Only signed, unmodified packages install.** Themes and plugins are verified
  against a pinned public key before anything is imported.

```bash
pnpm verify   # 50 attacks: RLS (6) · sandbox escape (6) · package signing (9)
              # revocation forgery (8) · malware scan (12) · plugin table ownership (9)
```

---

## Quick start

Requires **Node 22+**, **pnpm 10+** and **Docker**. Contributors also need
**[gitleaks](https://github.com/gitleaks/gitleaks#installing)** (`brew install gitleaks`)
for the secret-scanning git hooks — see [Git hooks and secret scanning](#git-hooks-and-secret-scanning).

```bash
cp .env.example .env
pnpm install            # also installs the git hooks (lefthook)
pnpm bootstrap          # docker up + migrate + seed
```

Then start the processes you need:

```bash
pnpm --filter @zcmsorg/cms-api dev         # http://localhost:4100/api/v1  (API docs at /api/v1/docs)
pnpm --filter @zcmsorg/site-runtime dev    # http://localhost:3100   public site
pnpm --filter @zcmsorg/admin-web dev       # http://localhost:3101   admin
pnpm --filter @zcmsorg/plugin-runtime dev  # http://localhost:4200   plugin sandbox
```

Sign in at `http://localhost:3101` with **`admin@z-cms.org` / `admin123`**.
In production, mount admin-web under each site's origin as `/admin`
(for example `https://z-cms.org/admin`), not on a separate `admin.*` hostname.

Background jobs (image variants, mail, sitemaps, the marketplace revocation feed) need
the worker as well:

```bash
pnpm --filter @zcmsorg/worker dev           # no port — it consumes the queue
```

> **In development the ports are 3100 / 3101 / 4100**, not 3000 / 3001 / 4000 — those
> are usually taken on a developer's machine. (`next start` in production still binds
> 3000 / 3001; only `next dev` is remapped.) The hostname in the `domains` table must
> match the site-runtime port (`localhost:3100`), because that is the key a site is
> resolved by.

---

## Tech stack

| Layer | Choice | Why |
| --- | --- | --- |
| API | **NestJS 11** (Node 22, TypeScript 5.9) | DI and guards make "who is this, what may they touch" structural rather than per-handler |
| Public site | **Next.js 16** (App Router, RSC) | one catch-all route; a page is data, not a build |
| Admin | **Next.js 16** + **Tailwind 4** + **Phosphor Icons** | server actions, no client-side API client to keep in sync |
| Database | **PostgreSQL 17** + **Prisma 7** | Row-Level Security is the isolation boundary |
| Cache | **Redis 8** (ioredis) | one render payload per key; invalidation by version |
| Object storage | **RustFS** (S3 API, via `@aws-sdk/client-s3`) | S3-compatible and Apache-2.0 — the same code runs against any S3 provider |
| Plugin sandbox | **isolated-vm** | a real V8 isolate; `node:vm` is not a security boundary |
| Contracts | **Zod 4** | one schema shared by the API and both front ends |
| Monorepo | **Turborepo** + **pnpm** workspaces | |

## Layout

```text
apps/
├── cms-api          NestJS. Auth + 2FA, RBAC, users, content, media, menus, themes,
│                    plugin gateway, marketplace, mail, jobs, audit, render API
├── site-runtime     Next.js. Renders public sites with the active theme
├── admin-web        Next.js. Content, media, appearance, plugins, marketplace,
│                    users, jobs, settings, and the Z-AI assistant
├── plugin-runtime   Runs plugin code in a V8 isolate. Holds no credentials
└── worker           BullMQ consumer: image variants, mail, sitemaps, deferred
                     plugin hooks, the revocation feed, nightly housekeeping

packages/
├── database         Prisma schema, migrations, RLS, tenant-scoped client
├── schemas          Zod contracts shared by the API and both front ends
├── theme-sdk        The contract for writing a theme
├── plugin-sdk       The contract for writing a plugin
├── i18n             Core message catalogue. English is the base locale
├── queue            Job names, payloads and the producer. One definition, both sides
├── package          Package format: pack, sign, verify, unpack, revoke
├── scanner          Static analysis of a submitted package, before anyone runs it
└── cli              zcms — keygen, pack, verify

themes/              default (the reference theme), aurora, z-cms-portal
plugins/             seo (the reference plugin), zai
```

## What is in the box

| | |
| --- | --- |
| **Content** | Content types with schema-driven fields, a block editor, draft/publish, and translation groups — one entry in many locales, linked, with `hreflang` emitted for you |
| **Media** | Folders, drag-and-drop upload, bulk move and delete, and derived image variants generated off the request path |
| **Themes** | Installed as signed packages. Templates, blocks, menu locations, settings as JSON Schema (the admin generates the form), per-theme translations, and SEO |
| **Plugins** | Signed too, and sandboxed. Declared permissions, scoped tokens, plugin-owned tables, deferred jobs |
| **Marketplace** | Browse and install themes and plugins; an hourly sync pulls a signed revocation list and quarantines anything that was pulled |
| **Users** | Roles and per-site membership, email invitations, TOTP two-factor auth with recovery codes, and an audit log of security events |
| **Operations** | Background jobs with a dead-letter queue you can inspect and retry from the admin, per-site SMTP, and an OpenAPI document generated from the live routes |
| **Languages** | English, Vietnamese and Japanese, in the admin and in the themes — a translation that drifts fails CI |

---

## Architecture

Full reasoning — decisions and *why* — is in [docs/architecture.md](docs/architecture.md).
The short version:

### Tenant isolation lives in the database

Z-CMS does not rely on `where: { tenantId }` to keep customers apart. That is the
second layer. The first is PostgreSQL:

- every tenant table carries `tenant_id` and has **Row-Level Security** enabled;
- `cms-api` connects as `zcms_app` — a role that **owns no tables** and is marked
  `NOBYPASSRLS`, so every query it issues is filtered by policy;
- `withTenant()` opens a transaction and sets `app.tenant_id` inside it.

A query that forgets the tenant filter entirely still leaks nothing.

> The single most important invariant in the system: **`APP_DATABASE_URL` must never
> point at the owner role.** A table owner is not subject to its own policies, so
> pointing it there would silently delete tenant isolation while leaving it looking
> enabled.

### One public request = one API call

`GET /render/resolve?hostname=…&path=…` returns everything needed to draw a URL:
site, theme + settings, menus, content or archive, plugin capabilities. Only
`PUBLISHED` content ever leaves `RenderService` — site-runtime is not trusted to
filter drafts, so a bug in a theme cannot leak one.

**Cache invalidation is by version, not by scanning.** Render keys embed a per-site
counter (`cms:render:{siteId}:v{n}:…`). Activating a theme bumps the counter with a
single `INCR`, and the entire previous generation stops being addressable and expires
on its own TTL. Walking the keyspace with `SCAN` to find one tenant's keys costs work
proportional to the whole platform.

### Themes are packages, and SEO belongs to them

A theme imports only `@zcmsorg/theme-sdk` — never cms-api, never the database. It
declares its templates, menu locations, settings (as JSON Schema, so the admin
generates the settings form with no admin-side change), its translations, and its
**SEO**: title template, favicon and icons, `Organization` identity, robots policy.

`Theme.seo(ctx)` maps the theme's *own settings* onto the document head, so a site
owner who edits "Organisation name" or "Favicon" in the admin changes the rendered
`<meta>` tags and the schema.org JSON-LD without anyone touching code.

### Plugins never run in the API process

```text
plugin.json declares permissions  →  admin approves (possibly a subset)
                                  →  scoped token, 60-second lifetime
                                  →  the gateway re-checks scope on the CMS side
```

Plugin code runs in a V8 isolate inside a process that has no `DATABASE_URL`, no
`S3_*` and no admin session. Permission checks happen on the *other side* of the
trust boundary, so a plugin patching its own checks achieves nothing.

**A plugin may not touch the core schema.** Its normal storage is `ctx.storage`, a
key/value space namespaced from its token. A plugin that genuinely needs relational
tables declares them in its manifest, and every one must carry the prefix derived
from its plugin id — a plugin that names a table outside its prefix is refused
installation before a line of its code runs.

The first sandbox used `node:vm` and **was broken**: `this.constructor.constructor("return process")()`
escaped it, read `/etc/passwd` and ran a shell. No code review caught that; attacking
it did. The story and the fix are in [docs/plugins.md](docs/plugins.md).

### The marketplace

Themes and plugins are installed from **[marketplace.z-cms.org](https://marketplace.z-cms.org)**
as **signed packages** — installing one is data, not a deploy. A running
site-runtime changes its entire appearance without a restart or a rebuild.

The marketplace is not a separate service: it is the `packages` module of a cms-api
instance, deployed publicly and holding the Z-SOFT signing key. A runtime verifies
every package against the key **pinned in its own environment**
(`MARKETPLACE_PUBLIC_KEY`), which is what makes self-hosting a private marketplace a
configuration change rather than a fork: pin your own key and you trust your own
registry. **The trust boundary is a key, not a hostname** — a hostname can be
spoofed.

That also means a compromised cms-api still cannot make a runtime execute code: it
would have to forge a signature for a key it does not hold. See
[docs/distribution.md](docs/distribution.md).

---

## Developer guide

### Commands

| Command | What it does |
| --- | --- |
| `pnpm bootstrap` | Docker up, migrate, seed. Everything a fresh clone needs. |
| `pnpm dev` | All apps in watch mode (Turborepo). |
| `pnpm build` | Build every package and app. |
| `pnpm typecheck` | Type-check the whole workspace. |
| `pnpm lint` | Lint every workspace. |
| `pnpm test` | **Every package's unit suite (Vitest), with coverage floors enforced.** See [docs/testing.md](docs/testing.md). |
| `pnpm verify` | **The attack suites**, six of them: RLS, sandbox escape, package signing, revocation forgery, malware scan, plugin table ownership — plus the test-convention gate. Run this in CI. |
| `pnpm verify:auth` | Drives the auth boundary end to end: rotation, replay, revocation, 2FA. Needs the stack up. |
| `pnpm scan:secrets` | Scans the git history for leaked credentials with gitleaks. Also runs in the hooks and CI. |
| `pnpm openapi` | Writes `apps/cms-api/openapi.json` from the live route table. Fails on a broken `$ref`. |
| `pnpm db:migrate` / `db:seed` / `db:reset` / `db:generate` | Schema, demo data, Prisma client. |
| `pnpm seed:plugins` | Seeds the local package registry with the bundled themes and plugins. |
| `pnpm --filter @zcmsorg/i18n sync` | Regenerates the catalogue after a language is added. |
| `pnpm --filter @zcmsorg/i18n check` | Fails if a translation drifted from the English base, or the catalogue is stale. |
| `pnpm infra:up` / `infra:down` / `infra:logs` | The Docker stack alone. |

### Git hooks and secret scanning

Hooks are managed by [lefthook](https://github.com/evilmartians/lefthook) and installed
automatically the first time you `pnpm install`. **pre-commit** scans your staged
changes for secrets; **pre-push** scans the commits you are about to push, then runs
`pnpm typecheck` and `pnpm test`. CI runs the same secret scan over the full history
and cannot be skipped, so a leaked credential fails the build even if a hook was bypassed.

The scan uses **gitleaks**, which you install once — the hook fails loudly if it is
missing rather than skipping the scan:

```bash
brew install gitleaks              # macOS
# Linux / other: https://github.com/gitleaks/gitleaks#installing
```

Intentional throwaway values in `.env.example` are allow-listed in `.gitleaks.toml`; a
real credential still fails. Never commit a real secret — see
[CONTRIBUTING.md](CONTRIBUTING.md#git-hooks-installed-for-you-and-secret-scanning) for
the full workflow.

### Docker

`infrastructure/docker/docker-compose.yml` brings up the whole backing stack:

| Service | Port | Notes |
| --- | --- | --- |
| PostgreSQL 17 | 5432 | Creates the `zcms` owner and the `zcms_app` RLS role on first boot. |
| Redis 8 | 6379 | Render cache. **Do not run it under `allkeys-lru`** — see below. |
| RustFS | 9000, 9001 (console) | S3-compatible object storage. |
| `storage-init` | — | Creates the media bucket and grants it public read, once. |
| Mailpit | 1025, 8025 (UI) | Catches outbound mail in development. |
| `plugin-runtime` | 4200 | Profile `full`. Read-only FS, `cap_drop: ALL`, non-root, no credentials. |

```bash
pnpm infra:up
docker compose -f infrastructure/docker/docker-compose.yml --profile full up -d   # incl. sandboxed plugin runtime
```

Two operational invariants worth knowing before you deploy:

1. **`APP_DATABASE_URL` → `zcms_app`**, never the owner role. Otherwise RLS silently
   stops applying.
2. **The Redis cache-version counter must never be evicted.** It is written with no
   TTL, so `volatile-*` eviction policies cannot touch it. Under `allkeys-lru` it
   could be reclaimed, and a bumped version would return to a generation whose keys
   are still cached — serving stale pages.

### The API documents itself

Start `cms-api` and the whole HTTP contract is at
**[localhost:4100/api/v1/docs](http://localhost:4100/api/v1/docs)** — every endpoint,
the permission it demands, and the shape of what it takes and returns. Log in from
the page itself and you can call any of it without leaving the browser. The raw
OpenAPI 3.0 document is at `/api/v1/docs-json`, and `pnpm openapi` writes the same
thing to a file for a client generator.

It is generated, not written. Request bodies *are* the Zod schemas the API
validates with, and every response schema is pinned to its DTO by a compile-time
assertion — document a field the API does not return, or forget one it does, and
`tsc` fails. That is the whole point: a hand-maintained spec is wrong the first
time someone adds a field, and nobody notices until a client breaks.

Served in production too. `SWAGGER_ENABLED=false` takes it down on a private
instance nobody integrates against; the URL then answers with a page saying so,
rather than a bare 404 that reads like a typo. Details in
[docs/api.md](docs/api.md).

### Environment

One `.env` at the repo root drives every package, so the API and the migrations can
never disagree about which database they mean. Start from
[`.env.example`](.env.example), which documents each variable.

### Internationalisation

**English is the base locale**; every other language falls back to it key by key, so
a partial translation is usable and safe to merge.

Two catalogues, deliberately separate:

- **Core** — `packages/i18n/src/locales/`. The admin, the API's error messages
  (negotiated from `Accept-Language`), the runtime's own pages.
- **Themes** — `themes/<name>/src/locales/`. A theme ships and translates its own
  strings, because a theme is installed and released independently of the platform.

Adding a language touches no TypeScript: copy `locales/en/` → `locales/<code>/`,
translate the values, append one line to `packages/i18n/locales.json`, and run
`pnpm --filter @zcmsorg/i18n sync`. `check` refuses a language that is half added —
translated on disk but invisible at runtime.

The catalogue is **generated** from those two inputs, and it ships behind two
entrypoints: `@zcmsorg/i18n` (server, holds the messages) and `@zcmsorg/i18n/client`
(browser, holds none). A client component therefore *cannot* import forty
languages and send them to a user who reads one — the import does not resolve.

Step by step: **[packages/i18n/README.md](packages/i18n/README.md)**. The wider
story, including how to translate a theme: **[docs/i18n.md](docs/i18n.md)**.

### Publishing core packages

`@zcmsorg/schemas`, `@zcmsorg/theme-sdk`, `@zcmsorg/plugin-sdk` and `@zcmsorg/i18n` are the
packages the community builds against. They are published **built** — the npm tarball
contains `dist/` (JavaScript plus `.d.ts`) and the licence, never TypeScript source.

---

## Documentation

- **[docs/api.md](docs/api.md)** — the HTTP contract: Swagger UI, the OpenAPI document, and why it cannot drift
- **[docs/architecture.md](docs/architecture.md)** — the decisions, and the reasons behind them
- **[docs/plugins.md](docs/plugins.md)** — the sandbox, the permission model, and the story of the first one being broken
- **[docs/security.md](docs/security.md)** — threat model and the defences, each with the test that proves it
- **[docs/distribution.md](docs/distribution.md)** — package format, signing, and marketplace verification
- **[docs/i18n.md](docs/i18n.md)** — how to translate Z-CMS: the two catalogues, themes, and what is not translated
- **[docs/jobs.md](docs/jobs.md)** — the queue, the seven jobs, deduplication, and the dead-letter queue
- **[docs/testing.md](docs/testing.md)** — where tests live, the coverage floors, and how the attack suites are written
- **[packages/i18n/README.md](packages/i18n/README.md)** — adding a language, step by step

---

## Third-party software

Z-CMS is MIT-licensed and stands on a lot of other people's work. Everything it
depends on is used unmodified, through its public interface, and keeps its own
licence. Nothing here is vendored into this repository.

### Runtime

| Project | Licence |
| --- | --- |
| [Next.js](https://nextjs.org) · [React](https://react.dev) | MIT |
| [NestJS](https://nestjs.com) · [Express](https://expressjs.com) · [Multer](https://github.com/expressjs/multer) | MIT |
| [Prisma](https://prisma.io) | Apache-2.0 |
| [PostgreSQL](https://www.postgresql.org) | PostgreSQL Licence |
| [Redis](https://redis.io) | RSALv2 / SSPLv1 / AGPLv3 (tri-licensed) — used unmodified, as a network service |
| [ioredis](https://github.com/redis/ioredis) · [node-postgres](https://node-postgres.com) | MIT |
| [RustFS](https://rustfs.com) | Apache-2.0 |
| [AWS SDK for JavaScript](https://github.com/aws/aws-sdk-js-v3) | Apache-2.0 |
| [isolated-vm](https://github.com/laverdet/isolated-vm) | ISC |
| [BullMQ](https://bullmq.io) (job queue) | MIT |
| [Tiptap](https://tiptap.dev) (block editor) · [ProseMirror](https://prosemirror.net) | MIT |
| [sharp](https://sharp.pixelplumbing.com) (image pipeline) | Apache-2.0 — see the note below |
| [Nodemailer](https://nodemailer.com) | MIT-0 |
| [Helmet](https://helmetjs.github.io) · [qrcode](https://github.com/soldair/node-qrcode) (TOTP enrolment) | MIT |
| [Zod](https://zod.dev) · [Tailwind CSS](https://tailwindcss.com) · [Phosphor Icons](https://phosphoricons.com) | MIT |
| [RxJS](https://rxjs.dev) · [reflect-metadata](https://github.com/rbuckton/reflect-metadata) | Apache-2.0 |
| [bcryptjs](https://github.com/dcodeIO/bcrypt.js) | BSD-3-Clause |
| [dotenv](https://github.com/motdotla/dotenv) | BSD-2-Clause |
| [tar-stream](https://github.com/mafintosh/tar-stream) | MIT |

### Development and infrastructure

| Project | Licence |
| --- | --- |
| [TypeScript](https://www.typescriptlang.org) | Apache-2.0 |
| [Turborepo](https://turbo.build) · [pnpm](https://pnpm.io) · [tsx](https://github.com/privatenumber/tsx) · [Prettier](https://prettier.io) | MIT |
| [Vitest](https://vitest.dev) · [Testing Library](https://testing-library.com) · [jsdom](https://github.com/jsdom/jsdom) | MIT |
| [esbuild](https://esbuild.github.io) | MIT |
| [AWS CLI](https://aws.amazon.com/cli/) (bucket bootstrap container) | Apache-2.0 |
| [Mailpit](https://mailpit.axllent.org) (development mail catcher) | MIT |

**A note on Redis.** Redis 8 is tri-licensed (RSALv2 / SSPLv1 / AGPLv3). Z-CMS talks
to it over the network as an unmodified service and does not link or redistribute it,
so its terms do not extend to Z-CMS or to your project. If you would rather run a
permissively licensed server, [Valkey](https://valkey.io) (BSD-3-Clause) is a drop-in
replacement and needs no code change.

**A note on sharp.** sharp itself is Apache-2.0, but the prebuilt `libvips` binary it
installs from npm (`@img/sharp-libvips-*`) is LGPL-3.0-or-later — the only copyleft
component anywhere in the dependency tree. sharp's native addon links against it
*dynamically*, as a shared library that pnpm fetches at install time; nothing is
statically linked and nothing is vendored into this repository. LGPL's copyleft
therefore stops at libvips and does not reach Z-CMS or anything you build on it. It is
worth knowing about only if you intend to redistribute a *statically linked* build,
which this project does not produce.

---

## Contributing

Contributions are welcome — translations especially, and they are the easiest place
to start: two files, no TypeScript, and a partial translation is worth merging
([packages/i18n/README.md](packages/i18n/README.md)).

Before opening a pull request:

```bash
pnpm typecheck
pnpm build
pnpm verify                          # if you touched the database, the sandbox, or the package format
pnpm --filter @zcmsorg/i18n check      # if you touched any message
```

Two rules about the code itself:

- **Comments explain why, not what.** The code already says what it does.
- **Security claims come with the test that proves them.** `pnpm verify` exists
  because the first sandbox looked correct and was not.

The full workflow — tests, commit convention, review — is in
[CONTRIBUTING.md](CONTRIBUTING.md). How we behave towards each other is in the
[Code of Conduct](CODE_OF_CONDUCT.md). How to report a vulnerability is in
[SECURITY.md](SECURITY.md), and it is the one thing that never goes in a public issue.

## Contact

| | |
| --- | --- |
| Project | [z-cms.org](https://z-cms.org) |
| Documentation | [docs.z-cms.org](https://docs.z-cms.org) |
| Marketplace | [marketplace.z-cms.org](https://marketplace.z-cms.org) |
| Support and general enquiries | **support@z-cms.org** |
| Security vulnerabilities | **support@z-cms.org** — please report privately first |

**Do not open a public issue for a security vulnerability.** Z-CMS runs untrusted
third-party code and isolates tenants from one another; a bug in either boundary is
worth a quiet email and a fix before it is worth a headline. See
[docs/security.md](docs/security.md) for the threat model and what is already
defended.

## Licence

[MIT](LICENSE) © 2026 Z-SOFT Co., Ltd.
