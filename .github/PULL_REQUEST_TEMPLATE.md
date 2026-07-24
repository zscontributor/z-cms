<!--
Title this PR the way you would title a commit:

    feat(admin): add bulk publish to the content list
    fix(api): reject a refresh token that was already rotated

Type: feat · fix · perf · refactor · docs · test · build · ci · chore
Scope: the package or app it lands in — api, admin, site-runtime, plugin-runtime,
worker, database, schemas, i18n, queue, package, scanner, plugin-sdk, theme-sdk,
cli, themes, plugins, deps. CI checks the title, so it is worth getting right.
-->

## What and why

<!-- What changes, and what problem it solves. Link the issue: "Closes #123".
     "Why" is the part a reviewer cannot reconstruct from the diff. -->

## How it was verified

<!-- Not "tests pass" — what you actually exercised. Which suite, which flow you
     drove by hand, what you saw. If it is a bug fix, name the test that fails
     without your change. -->

## Security boundary

<!-- Delete this section only if the change comes nowhere near one.

     The four boundaries: tenant isolation (Postgres RLS), the plugin sandbox
     (V8 isolate), package signing and revocation, auth and sessions.

     If you touched one, say which, say what an attacker could try, and point at
     the test that refuses it — written from the attacker's side, as in
     docs/security.md. `pnpm verify` must stay green. -->

## Checklist

- [ ] **Tests ship with the change.** A bug fix has a test that fails without it;
      a feature has tests for how it can be misused, not only how it is meant to be used.
- [ ] `pnpm typecheck && pnpm build && pnpm test` pass locally.
- [ ] `pnpm verify` passes — required if this touches the database, the sandbox,
      packages or auth.
- [ ] Docs updated in this PR if it changes behaviour the README, `docs/` or the
      OpenAPI surface describes. A public claim that has quietly stopped being true
      is worse than no claim.
- [ ] Every user-visible string goes through i18n, with `en` and `vi` both filled in
      (`pnpm --filter @zcmsorg/i18n check`).
- [ ] No new dependency — or one new dependency, with a line below saying why the
      platform needs it and what its licence is.
- [ ] One change per PR. A fix and a refactor are two PRs.

## Breaking changes

<!-- None, or: what breaks, who notices (site operators / theme authors / plugin
     authors), and what they have to do about it. A breaking change to the plugin
     or theme SDK breaks other people's published packages — say so plainly. -->

None.
