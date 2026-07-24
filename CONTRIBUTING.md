# Contributing to Z-CMS

Z-CMS is a CMS for the community, built in the open. Themes, plugins, translations,
bug fixes, docs — all of it is welcome. This page is the short version of what a
change needs to be merged; the deep dives live under [`docs/`](docs/).

## Before you start

- **Node 22+, pnpm 10+, Docker.** `cp .env.example .env && pnpm install && pnpm bootstrap`.
- Read the [architecture overview](docs/architecture.md) and, if you are touching
  a security boundary (packages, plugins, tenancy, auth), the
  [security model](docs/security.md).
- For anything non-trivial, open an issue first so we can agree on the shape
  before you write it.
- Be someone people want to build with — the [Code of Conduct](CODE_OF_CONDUCT.md)
  applies everywhere this project happens.

## Where to put what

| You have | Where it goes |
| --- | --- |
| A bug you can reproduce | [Bug report](../../issues/new?template=bug_report.yml) |
| An idea, or a change you want to make | [Proposal](../../issues/new?template=feature_request.yml) — before you write the code |
| A broken, misleading or over-permissioned marketplace package | [Package report](../../issues/new?template=marketplace_package.yml) |
| A question, or "would you accept a PR that…" | [Discussions](../../discussions) |
| **A security vulnerability** | **Privately** — [SECURITY.md](SECURITY.md). Never a public issue. |

Issues are for a defect or an agreed piece of work. Everything else is a discussion,
and a discussion gets a faster answer in the room built for it.

## The rule that is not negotiable: tests

Every code change ships with tests. This is a public CMS that runs untrusted
themes and plugins and keeps tenants apart — an untested change to it is not a
contribution we can accept, however good the idea. Concretely:

- a **bug fix** comes with a test that fails before the fix and passes after it;
- a **feature** comes with tests for its behaviour, including the ways it can be
  misused;
- a change to a **security boundary** comes with a test written *from the
  attacker's side* — build the exploit, assert it is refused.

How tests are written here, where they live, and the coverage floors are all in
**[docs/testing.md](docs/testing.md)**. Read it once; it is short. The canonical
example to copy is
[`packages/package/src/test/signing.test.ts`](packages/package/src/test/signing.test.ts).

Found a real bug while testing? Leave the test red and say so in the PR — do not
edit the code under test to make a security test pass.

## What CI checks (run these before you push)

```bash
pnpm build        # everything compiles
pnpm typecheck    # no type errors
pnpm test         # every unit suite, with coverage floors enforced
pnpm verify       # the attack suites: RLS, sandbox escape, package signing
pnpm scan:secrets # gitleaks over the git history — no leaked credentials
```

If those pass locally, CI will pass — it runs the same commands. A pull request
that drops coverage below a package's floor, skips a `verify` suite, or contains a
secret fails automatically.

## Git hooks (installed for you) and secret scanning

Hooks are managed by [lefthook](https://github.com/evilmartians/lefthook) and wired
automatically the first time you `pnpm install`. They are the fast, local half of
the convention; CI is the authoritative half and cannot be bypassed.

- **pre-commit** scans your staged changes for secrets, so a credential never even
  enters a commit.
- **pre-push** scans the commits you are about to push for secrets, then runs
  `pnpm typecheck` and `pnpm test`. The heavier DB-backed `pnpm verify` suites and
  the dependency audit run in CI, where Postgres and Redis exist.

The secret scan uses **gitleaks**, which you must install once — the hook fails
loudly if it is missing rather than skipping the scan:

```bash
brew install gitleaks              # macOS
# Linux: https://github.com/gitleaks/gitleaks#installing
```

Intentional throwaway values in `.env.example` are allow-listed in
[`.gitleaks.toml`](.gitleaks.toml); a real credential still fails. **Never** commit
a real secret and rely on rotation — treat any leaked credential as burned and
rotate it. In a genuine emergency you can bypass a hook with `git push --no-verify`,
but CI will still fail, so fix the cause instead.

## Commits, branches and PR titles

Branch from `main`, named after the work: `feat/bulk-publish`, `fix/refresh-token-replay`.

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org),
and so does the **pull request title** — squash-merge turns it into the commit that
lives in `git log` forever, so CI checks it:

```
type(scope): summary in lower case, imperative mood

feat(admin): add bulk publish to the content list
fix(api): reject a refresh token that was already rotated
feat(theme-sdk)!: replace defineTheme's block map with a registry
```

- **type** — `feat` `fix` `perf` `refactor` `docs` `test` `build` `ci` `chore` `revert`
- **scope** — the package or app it lands in: `api` `admin` `site-runtime`
  `plugin-runtime` `worker` `database` `schemas` `i18n` `queue` `package` `scanner`
  `plugin-sdk` `theme-sdk` `cli` `themes` `plugins` `marketplace` `docs` `infra` `deps`
- **`!`** marks a breaking change — say what breaks and who has to do something about
  it in the body. Breaking the plugin or theme SDK breaks other people's published
  packages.

The body is where the value is. Explain **why**, the way the code comments do: what
was wrong, what an attacker could do, why this is the fix. The diff already says what
changed. Read `git log` in this repo for the standard.

## Pull request expectations

- **One change per PR.** A bug fix and a refactor in the same branch are two PRs.
- **Describe what and why**, not just what. If you changed a boundary, say which
  attack the change is about.
- **Match the surrounding style.** The codebase comments the *why*; so should you.
  No new dependency without a line in the PR explaining why the platform needs it.
- **Keep the public claims true.** If you change behaviour the README or
  `docs/security.md` describes, update the doc in the same PR.

## Reporting a security vulnerability

Do **not** open a public issue. Open a
[security advisory](https://github.com/zscontributor/z-cms/security/advisories/new) or email
**support@z-cms.org** with what you have, including a proof of concept if you can.
[SECURITY.md](SECURITY.md) says what is in scope and what to expect;
[docs/security.md](docs/security.md) has the threat model. A boundary bug in this
platform exposes every site on an instance, so operators need a fix in hand before
the details are public.

## License

By contributing you agree that your contribution is licensed under the
[MIT License](LICENSE), the same as the rest of Z-CMS.
