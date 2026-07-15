# The Z-CMS security model

## Reporting a vulnerability

Email **support@z-cms.org**. Please do not open a public issue first.

Z-CMS keeps tenants apart and runs code it did not write. A bug in either of those
boundaries is not an inconvenience to one user — it is an exposure of every site on
an instance, and every operator needs a fix in hand before the details are public.
Send what you have, including a proof of concept if you have one; you will get an
acknowledgement and a fix timeline rather than a lawyer.

## Defences that exist today

| Threat | Defence | Verified |
| --- | --- | --- |
| A query that forgets the tenant filter | Postgres RLS + the `zcms_app` role (`NOBYPASSRLS`, owns no table) | `verify:rls` #1 |
| Reading another tenant's row by id | RLS `USING` policy | `verify:rls` #2 |
| Writing a row stamped with someone else's `tenant_id` | RLS `WITH CHECK` policy | `verify:rls` #3 |
| A query with no tenant context | `NULLIF(…,'')::uuid` → NULL → 0 rows (fail closed) | `verify:rls` #4 |
| The app turning RLS off for itself | The app role owns no table → `must be owner of table` | `verify:rls` #5 |
| Borrowing another tenant's `X-Site-Id` | `AuthGuard` checks the site against the tenant in the token, plus membership | 403 (tested) |
| A junk `X-Site-Id` causing a 500 | UUID regex before the value ever reaches Prisma | 403 (tested) |
| Enumerating sites via `/render/resolve` | `X-Internal-Token` required, compared in **constant time** | 401 (tested) |
| Probing which emails exist by login timing | bcrypt always runs, even when the user does not exist | — |
| A leaked access token used to mint new credentials | Refresh tokens are signed with a **different key** | — |
| A draft leaking onto the public site | `RenderService` only ever returns `PUBLISHED` | — |
| Malicious file upload | MIME **allowlist** (SVG excluded — it can carry script running on the site's origin) | — |
| Path traversal / object overwrite | The storage key is server-generated (`sites/{siteId}/{uuid}{ext}`), never the client's filename | — |
| A plugin reading files / spawning a shell / calling the network | V8 isolate (`isolated-vm`) — no `process`, `require`, `fetch` | `verify:sandbox` 1,2,3,6 |
| A plugin looping forever / bombing memory | Timeouts (5s action, 800ms filter), 64MB limit | `verify:sandbox` 4,5 |
| A plugin acting outside its grant | 60-second scoped token; the gateway checks on the CMS side | 403 (tested) |
| An admin accidentally granting a permission the plugin never asked for | The API refuses any grant outside the manifest | 400 (tested) |
| A plugin declaring a core table as its own | `validatePluginTables()` rejects the install before any of its code runs | `verify:tables` (9 attacks) |
| A broken plugin taking the website down | Actions are fire-and-forget; a failed filter is skipped and the original value used | site still 200 (tested) |
| A plugin escaping the sandbox (worst case assumed) | Container: read-only FS, `cap_drop: ALL`, non-root, **no credentials** — and **no route off the host**: plugin-runtime sits on an `internal: true` Docker network with no gateway, alone with cms-api. An escaped plugin cannot reach the internet or the cloud metadata endpoint, because there is nothing to reach it *through* | `docker-compose.prod.yml` (verified: 0 default routes) |
| A hostile **theme** (runs in-process in site-runtime, no isolate) reading a secret | site-runtime holds no DB/JWT/encryption/S3 secret — only a render-scoped token — and is hardened like plugin-runtime: read-only FS, `cap_drop: ALL`, non-root | stack files |
| A theme using its stolen token to send mail as any tenant | The render token opens only read-only render endpoints; `/mail/deliver` requires the separate privileged token | by design |
| A theme reaching the render cache to read/poison other tenants | Redis requires a password site-runtime is not given | stack files |
| A compromised cms-api using the runtime to run arbitrary code | The runtime receives a **key**, never code; it only loads packages it has verified | by design |
| A tampered or forged theme/plugin package | Marketplace Ed25519 signature over the payload's SHA-256, verified against a **pinned** public key | `verify:packages` |
| A hostile package writing outside its install directory | `unpackTo` refuses `..`, absolute paths, symlinks and hardlinks | `verify:packages` |
| A decompression bomb filling the disk | `unpackTo` caps a package at 50MB unpacked and 2000 entries | `verify:packages` |
| Republishing a version with different bytes | A published version is immutable: a checksum mismatch on the same version is a 400 | — |
| Obvious malware in an uploaded package | Static scan **before** the marketplace signs: `reject`→400 (nothing stored), `flag`→QUARANTINED (a human clears it first) | `verify:scan` |
| A quarantined package being loaded anyway | The bundle endpoint serves only `APPROVED` versions | — |
| A **stolen refresh token** | Refresh tokens rotate. Replaying a consumed one is treated as theft and **revokes the whole family** — thief and victim are both signed out, and only the victim can sign back in | `verify:auth` #1 |
| A refresh token that cannot be revoked | Tokens are stored (SHA-256, never raw); logout revokes the family | `verify:auth` #2 |
| Brute-forcing a password | Redis rate limit: **5 attempts / 15 min per email**, 30 per IP — two independent budgets, because one host spraying many accounts and one account sprayed from many hosts are different attacks | `verify:auth` #4 |
| A database leak handing out live sessions | Only the token **hash** is stored, like a password | `verify:auth` (inspected) |
| XSS from authored content (block richtext) | Nonce-based CSP on both front ends: `script-src 'self' 'nonce-…' 'strict-dynamic'`, no `'unsafe-inline'` — an injected `<script>` or `onclick=` has no nonce and is refused | 0 violations (browser-checked) |
| Clickjacking / MIME sniffing | `frame-ancestors 'none'`, `X-Frame-Options: DENY`, `nosniff`, HSTS, `Referrer-Policy`, `Permissions-Policy` on the API and both apps | `verify:auth` #5 |
| Code already live on customer sites turning out to be malicious | Kill switch: REJECTED + sites moved to safety + **runtime caches purged**; the site stays up on the default theme | tested (site stayed 200) |
| A stranger publishing to the marketplace | Anyone may sign up and submit — and nothing they submit is servable until a human has read it. A clean scan is not an approval; it lands in the review queue either way. Only a `trusted` first-party publisher skips the queue, and that flag is seeded, not self-service | `verify:developer` (tested) |
| A leaked publisher signing key being used to publish as its owner | Holding the key is not enough: the submitter's developer session must own the publisher that key belongs to | 403 (`verify:developer`) |
| A developer session reaching the reviewer's console | Staff and developer tokens are signed with **different derived keys** — a developer token does not fail an authorisation check on a staff route, it fails to verify at all | 401 (`verify:developer`) |
| "Who deleted the homepage?" having no answer | `audit_logs` now records content create/update/publish/unpublish/delete, media upload/delete, theme activate + settings, plugin install/activate/deactivate/settings, package publishes | 6 action types (tested) |

The scanner is heuristic and honest about it: it is not what *contains* a hostile
plugin — the isolated-vm sandbox is. It rejects the obvious (spawns a shell, reads
the filesystem, evals a string, reaches a built-in through `createRequire` or a
computed `import()`), makes obfuscation itself a flag, and shrinks what a human
reviewer must read.

It still matters more for themes, which run in the site-runtime Node process rather
than in an isolate — but it is no longer the *only* thing standing between a
malicious theme and the platform. A theme that defeats the scanner now lands in a
process that holds no credential worth stealing and a container it cannot escape to
anything (read-only FS, all capabilities dropped, no outbound reach beyond cms-api).
The scanner shrinks the odds; the container and the empty environment bound the
damage when it fails. The regexes are still defeated by enough indirection — that
is why the boundary can no longer be the regex alone.

## Sessions: rotation, and what happens when a token is stolen

A refresh token is meant to be used **exactly once**. Every refresh consumes the
token it was given and issues a new one in the same `familyId`.

That single-use rule is what makes theft *detectable*. If a consumed token is
presented again, one of two things is true: the legitimate client is replaying an
old token, or an attacker is using a copy. **We cannot tell which** — so the
entire family is revoked. The thief and the victim are both signed out; the
victim signs back in and gets a fresh family, and the thief's copy is dead.

That is deliberately blunt. The alternative — trying to guess which of the two is
the real user — is guessing, and guessing wrong means letting the thief keep the
account.

```
login          → family F, token A
refresh(A)     → A consumed, token B issued   (same family F)
refresh(A)     → A was already consumed  →  REVOKE ALL OF F
refresh(B)     → 401. B is dead too.
```

Only the SHA-256 of a token is stored, for the same reason passwords are hashed:
a database leak must not hand out working sessions.

**What this does not cover:** access tokens are still stateless JWTs, so revoking
a session does not invalidate an access token already in flight — that takes up
to one access TTL (15 minutes). Shortening `JWT_ACCESS_TTL` is the dial.

## Content Security Policy

Both front ends run a **nonce-based CSP** — `script-src 'self' 'nonce-…'
'strict-dynamic'`, with no `'unsafe-inline'`. An `<script>` an author pastes into
block richtext carries no nonce, so the browser refuses to run it. That is the
backstop for a stored XSS on a surface whose whole job is rendering authored HTML.

A nonce is normally incompatible with page caching — bake it into cached HTML and
every visitor gets the same one, which is worse than none. It works here because
both apps render **per request**: site-runtime reads the `Host` header (making the
route dynamic) and only the *API fetch* is cached, so each request produces fresh
HTML with a fresh nonce while still reusing the expensive lookup.

Next stamps its own inline scripts with the nonce automatically. A script the app
writes itself — admin-web's dark-mode bootstrap — must be stamped by hand from the
`x-nonce` request header, or the CSP refuses it. That was a real 1-violation bug,
caught in a browser and not by any typecheck.

## Invariants worth dying on

```
APP_DATABASE_URL  ->  zcms_app   (RLS is enforced)
DATABASE_URL      ->  zcms       (owner, bypasses RLS — migrations and seeds only)
```

Pointing `APP_DATABASE_URL` at the owner role **wipes out tenant isolation
without raising a single error**. This is the thing to review hardest whenever
infrastructure configuration changes.

The second:

```
plugin-runtime  ->  NEVER has DATABASE_URL / S3_* / REDIS_URL
site-runtime    ->  NEVER has DATABASE_URL / JWT_SECRET / *_ENCRYPTION_KEY / S3_*
                    keys / REDIS_URL — only CMS_API_URL, its render token,
                    S3_PUBLIC_URL and the pinned MARKETPLACE_PUBLIC_KEY
```

**Both** of these processes run code someone else wrote. plugin-runtime runs a
plugin inside a V8 isolate; site-runtime `import()`s a marketplace **theme** bundle
straight into its own Node process, with no isolate at all. That makes
site-runtime *less* contained than plugin-runtime, not more — so it is the one that
must hold nothing worth stealing. Injecting the repo `.env` wholesale into it
(`env_file`) put the RLS-bypassing DB owner credential, the JWT signing key and the
encryption keys one `process.env` read away from any theme; the runtimes are now
handed an explicit allowlist instead, and both are hardened at the container level
(non-root, read-only FS, `cap_drop: ALL`, `no-new-privileges`). The token
site-runtime does hold is the *render-scoped* `SITE_RUNTIME_INTERNAL_TOKEN`, which
cms-api accepts only on read-only render endpoints — never `/mail/deliver`.

If either process holds a credential it does not strictly need, every layer above
it is decoration.

The third:

```
runtime  ->  runs only packages the marketplace signed,
             verified against a key pinned in its own config
```

Not a key from the API, and not the key that travelled inside the package. See
[distribution.md](./distribution.md).

And one operational invariant that is easy to lose in a config change:

```
Redis  ->  cms:sitever:{siteId} has NO TTL and must never be evicted
```

The render cache is versioned by that counter. Evict it while keys from an older
generation are still live, and the next bump returns to a generation whose keys
are still cached — the site then serves stale pages until they expire. Do not run
this Redis under `allkeys-lru`.

Check the first two on any environment:

```bash
pnpm verify        # RLS · sandbox escape · package signing · malware scan · plugin tables
pnpm verify:auth   # sessions · rotation · theft detection · rate limit · headers
                   # (drives a live API — it cannot be faked with a unit test)
```

Both run in CI on every push (`.github/workflows/ci.yml`), against a real Postgres
and a real Redis. A security suite nobody runs is a suite that has already
silently regressed.

**This belongs in CI**, run against that environment's real database. The RLS
suite includes an automatic check that *every table with a `tenant_id` has RLS
enabled* — a new table with a forgotten policy is caught in CI instead of quietly
serving every tenant's data.

## Before production

- [ ] Rotate `JWT_SECRET`, `CMS_INTERNAL_TOKEN` and the marketplace signing keys
      (the values in `.env.example` are for development only). The marketplace
      **private** key must not exist on any machine that runs plugin or theme code.
- [x] Refresh tokens: rotation, revocation, and **reuse detection** (a replayed
      token revokes its whole family). Access tokens stay stateless and short —
      revocation is therefore not instant for them, it takes up to one access-token
      TTL (15 min). Shortening that TTL is the dial if that window matters.
- [x] Rate limit `/auth/login` and `/auth/refresh` (Redis). The limiter **fails
      open** if Redis is down — brute-force mitigation must not become a
      self-inflicted outage. Behind a proxy, `TRUST_PROXY` must name the real hop
      count, or a client can forge `X-Forwarded-For` and dodge the IP budget.
- [x] Audit logging for real: content create/update/publish/unpublish/delete,
      media upload/delete, theme activate + settings, plugin
      install/activate/deactivate/settings, package publishes. The write happens
      *inside* the request transaction, so a rolled-back operation leaves no row —
      the log records what happened, not what was attempted. **Failed authorisation
      is still not audited**; that belongs here too and is not done.
- [x] Security headers + a **nonce-based CSP** on site-runtime and admin-web
      (verified in a real browser: zero violations). No `'unsafe-inline'` for
      scripts.
- [x] Dependency scanning (`osv-scanner` against `pnpm-lock.yaml`) in CI. Advisory, not
      blocking: a transitive CVE with no available patch must not stop a security
      fix from shipping. Two moderate advisories in build tooling (postcss, and
      @hono/node-server via prisma) are pinned past them with `pnpm.overrides`.
- [x] Alerting. Four events now push to `SECURITY_ALERT_WEBHOOK` (any JSON
      endpoint — a CMS has no business shipping a Slack client) and log at error
      level regardless: `auth.session_theft_detected`, `auth.revoked_token_used`,
      `package.quarantined`, `job.dead_lettered`.
- [x] Publisher accounts and key rotation. `POST /publishers` registers the
      identity; public keys live in `publisher_keys` and must be `ACTIVE` before
      they can sign submissions. An **unverified publisher or key cannot publish**
      — registration is cheap and proves nothing, and without the verification
      step "signed by X" only means the uploader controls a key, not that X is
      anybody. Retiring a key blocks future submissions without killing already
      counter-signed packages; marking one `COMPROMISED` tells reviewers to inspect
      or revoke versions signed by it. Posting a PRIVATE key by mistake is refused
      with a warning to rotate it.
- [x] A kill switch. `POST /packages/revoke/:kind/:key/:version` pulls a version
      that is already live: it marks it REJECTED, moves every affected site off it
      (a theme falls back to the built-in default, a plugin is QUARANTINED), and
      **purges the runtimes' caches** so the code stops executing now rather than
      at the next deploy. It alerts. Verified: a site running a revoked theme
      stayed HTTP 200 throughout and fell back to the default.
- [x] **plugin-runtime has no route to the internet.** In production it sits alone
      with cms-api on `zcms-sandbox`, a Docker network declared `internal: true` —
      which means Docker gives it no gateway and there is no default route in the
      container at all. Verified empirically: a container on that network has zero
      default routes, cannot reach `1.1.1.1`, and cannot reach `169.254.169.254`.
      Everything above this line is a policy — the isolate denies a plugin any way to
      open a socket, and the gateway checks every outbound request against the hosts
      the manifest declared. Both live in software, and an isolated-vm escape sidesteps
      them by definition. **A network with no default route is not software the escape
      can argue with.** This is what turns the host allowlist from a policy into a
      boundary, and it is what stops an escaped plugin from reading the cloud metadata
      endpoint and walking off with the instance's IAM credentials. A plugin's
      legitimate `ctx.http.fetch` is unaffected: cms-api makes that request, on the far
      side of the gateway, and cms-api is the only service on both networks.
      (Still open: the same treatment for the worker, which needs Postgres, Redis and
      S3 and so cannot simply be moved onto an internal network.)
- [x] Built-in **themes** are signed and verified too, and this matters more than it
      does for plugins rather than less. A plugin runs in an isolated-vm isolate in a
      process holding no credentials. **A theme is not sandboxed at all** — it is
      `import()`ed into site-runtime and rendered with site-runtime's own Node, its own
      `process.env`, its own filesystem. For the four themes we ship, the first-party
      signature is the only boundary that exists. The compiled-in default theme remains
      as the *fallback* — it comes from the build rather than from the volume, which is
      precisely what makes it the one thing that cannot fail the same way a bad
      signature does.
- [x] Built-in plugins are signed and verified, not merely trusted. zAI and SEO ship
      as signed `.zcms` artefacts and plugin-runtime verifies them against a pinned
      `FIRST_PARTY_PUBLIC_KEY` before executing a byte — `dist/index.js` on the volume
      is no longer read at all. This closes the gap where the code with the MOST
      privilege in the system (zAI holds `network:fetch` and spends the site's API
      keys) was the only code with no signature between it and the isolate, on the
      reasoning that "the volume belongs to the operator" — which a bad image layer, a
      mounted host path or a compromised CI step all falsify. The catalogue row's
      manifest is read from the verified payload too, so nobody can widen
      `network.hosts` by editing a loose `plugin.json`. Verified by 7 cases in
      `apps/plugin-runtime/src/test/registry-builtin.test.ts`, each one an attack on
      the volume.
- [x] A plugin reaches the outside world only through hosts its manifest declared
      and an admin approved (`network:fetch` + `network.hosts`). cms-api opens the
      socket, not the sandbox: the hostname is matched against the installed
      version's manifest, the resolved address is re-checked **at connect time** (so
      a DNS record that flips to `127.0.0.1` after the check still cannot be reached),
      redirects are followed one hop at a time with both checks repeated, and the
      request is bounded by 10s / 1MB / an hourly per-site quota that fails closed.
      Verified by 40 cases in `apps/cms-api/src/plugins/test/plugin-egress.test.ts`,
      each one an attack rather than an example.
- [x] A plugin cannot read a credential it is allowed to spend. A setting declared
      `format: "password"` is stripped from `ctx.settings` before the isolate starts;
      the plugin writes `{{secret:name}}` into a request and cms-api substitutes it
      after the host has been approved. Error messages are redacted on the way back,
      because a plugin that writes `https://{{secret:apiKey}}/` would otherwise read
      its own key out of the refusal. A compromised plugin can spend the key at the
      host an admin approved; it cannot exfiltrate it, because it never holds it.
- [x] Static malware scanning at package upload (`@zcmsorg/scanner`, run before the
      marketplace signs). **Still missing** before opening to the community:
      dependency-vulnerability scanning, and a human reviewer for a first-time
      publisher and for every QUARANTINED package. A `flag` verdict lands in
      QUARANTINED with no one yet assigned to clear it.
