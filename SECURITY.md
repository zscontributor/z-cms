# Security policy

Z-CMS keeps tenants apart and runs code it did not write. A bug in either of those
boundaries is not an inconvenience to one user — it is an exposure of every site on
an instance. So the rule is simple: **operators get a fix in hand before the details
are public.**

## Reporting a vulnerability

Two private channels, either is fine:

- **[Open a security advisory](https://github.com/zscontributor/z-cms/security/advisories/new)**
  on GitHub — preferred, because the fix, the CVE and the credit all happen in one place.
- **Email support@z-cms.org** if you would rather not use GitHub, or if you cannot
  reach it.

**Do not open a public issue, pull request or Discussion**, and please do not post a
proof of concept anywhere public until a fix has shipped.

Send whatever you have — the version or commit, what you did, what you got, and a
proof of concept if you built one. A hunch with a plausible mechanism is still worth
sending; we would rather chase a false alarm than read about a real one on a blog.

You will get an acknowledgement and a fix timeline, not a lawyer. We do not run a
paid bounty programme, but we credit every reporter who wants credit in the advisory
and the release notes.

## What we treat as a vulnerability

The four boundaries are load-bearing, and anything that crosses one is in scope:

| Boundary | A vulnerability looks like |
| --- | --- |
| **Tenant isolation** (Postgres RLS) | Any read or write that reaches another tenant's rows |
| **Plugin sandbox** (V8 isolate) | Plugin code reaching the host process, the network, the filesystem, or a credential |
| **Package signing** | Installing a package that is unsigned, modified after signing, or revoked |
| **Auth and sessions** | Privilege escalation, session fixation, token replay after rotation or revocation, 2FA bypass |

Also in scope: remote code execution, stored XSS in the admin or a rendered site,
SSRF from the API or the worker, and any leak of secrets, tokens or media belonging
to another tenant.

**Out of scope:** findings against a deployment you do not operate (do not test other
people's sites); missing hardening headers with no exploit path; vulnerabilities in a
third-party theme or plugin, which belong to its author — though if one is abusing the
sandbox to do something it did not declare, that *is* our problem and we want to know;
and automated scanner output with no demonstrated impact.

## Supported versions

Z-CMS is pre-1.0. Security fixes land on `main` and in the next release; there is no
long-term-support branch yet, so **running a recent release is part of your security
posture.** This table will grow teeth at 1.0.

| Version | Supported |
| --- | --- |
| `main` and the latest `0.x` release | ✅ |
| Older `0.x` releases | ❌ — upgrade |

## What is already defended, and proven

The threat model, the defences and their limits are in **[docs/security.md](docs/security.md)**.
Every claim there is backed by a script that tries to break it, and those scripts run
in CI on every push:

```bash
pnpm verify        # 50 attacks, all of them expected to fail:
                   #   6  tenant isolation — cross-tenant read, write, RLS disable
                   #   6  sandbox escape — process, filesystem, network, prototype
                   #   9  package signing — forged, tampered, traversal, zip bomb
                   #   8  revocation forgery — edit, re-date, reorder, rewind
                   #  12  malware scan — what the marketplace refuses to publish
                   #   9  plugin table ownership — a plugin naming a table it does not own

pnpm verify:auth   # the auth boundary end to end: rotation, replay, revocation, 2FA
                   # (needs the stack up, so it runs separately from the suites above)
```

If you find an attack these suites do not cover, that is exactly the report we want —
and the fix comes with a new case added to them.

## For operators

A compromised package can be disabled across every installation with a signed
revocation, without waiting for anyone to upgrade. If you run Z-CMS in production,
keep the revocation list reachable and subscribe to releases: that is how a kill
switch reaches you.
