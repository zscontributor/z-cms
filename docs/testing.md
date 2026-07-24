# Testing Z-CMS

Z-CMS runs code it did not write, for tenants that must never see each other. A
test suite for a project like this is not a box to tick — it is the evidence that
the properties the README claims are still true after the last commit. This page
is the contract: how tests are written here, where they live, and what a
contributor must do before a pull request is reviewed.

## Test ownership convention

Every feature is shipped with tests in the same change. New tests live in the
folder owned by the feature:

```text
apps/cms-api/src/<module>/test/*.test.ts
apps/admin-web/src/<feature>/test/*.test.tsx
plugins/<plugin>/test/*.test.ts
packages/<package>/src/test/*.test.ts
```

Every executable workspace under `apps/`, `packages/`, or `plugins/` must expose
`scripts.test`; otherwise Turbo can skip it while CI still looks green. Plugins
must own at least one test in `test/`. Nest modules must have tests inside their
module boundary. Pre-convention modules with no tests are explicit migration
debt in `scripts/verify-test-convention.mjs`; new exemptions are not accepted.

```bash
pnpm verify:test-convention
pnpm test
```

CI runs the structural gate before build and runs all declared suites. A feature
change without a behaviour test is incomplete even when typecheck passes.

If you read one thing: **a test asserts a behaviour, and a security test asserts
that an attack fails.** Everything below is detail on that.

## The one-command truth

```bash
pnpm test            # every unit suite in the workspace, via turbo
pnpm verify          # the attack suites: RLS, sandbox escape, package signing,
                     # revocation forgery, malware scan, plugin table ownership
```

`pnpm test` runs [Vitest](https://vitest.dev) across every package and app. It is
cached by turbo, so re-running it only re-tests what changed. CI runs exactly this
command — there is no separate, blessed configuration that only the maintainers
can reproduce. What passes on your machine passes on ours.

The two commands answer two different questions. `pnpm test` asks *does each unit
behave?* `pnpm verify` asks *does the assembled system refuse a real attack?* Both
gate a merge. A contributor changing a security boundary is expected to run both.

## Where a test goes

**In a `test/` folder next to the code it tests, named `*.test.ts`.** Every
module, feature, package and plugin owns its own `test/` directory:

```
packages/scanner/src/rules.ts
packages/scanner/src/test/rules.test.ts        ← the package's tests

apps/cms-api/src/auth/auth.service.ts
apps/cms-api/src/auth/test/auth.service.test.ts ← the module's tests

apps/admin-web/src/lib/slugify.ts
apps/admin-web/src/lib/test/slugify.test.ts     ← the feature's tests

plugins/seo/index.ts
plugins/seo/test/plugin.test.ts                 ← the plugin's tests
```

The rule is one line: **a test for code in directory `X/` lives in `X/test/`.**
A reviewer opening a module sees its `test/` folder and knows at a glance whether
the change came with tests; a whole module's behaviour is described in one place
rather than scattered file-by-file. `scripts/verify-test-convention.mjs` enforces
it — every workspace must declare `scripts.test`, every plugin must own at least
one `test/*.test.ts`, and every cms-api module must carry tests inside its own
boundary. It runs first in `pnpm verify`, so a module that ships without a test
fails CI before a single suite is even built.

The harness discovers `src/**/*.test.{ts,tsx}` and `test/**/*.test.{ts,tsx}`
automatically. You never register a file.

```bash
pnpm verify:test-convention   # the structural gate: is every module tested?
```

## Writing a test the Z-CMS way

Every suite in this repo follows one shape. The canonical example is
[`packages/package/src/test/signing.test.ts`](../packages/package/src/test/signing.test.ts) —
**read it before you write your first test.** The rules it embodies:

**One `describe` per exported symbol, named exactly like the symbol.** A reader
scanning the file finds `verifyPackage` under `describe("verifyPackage")`. Nothing
to guess.

**Test names are sentences about behaviour, not restatements of code.**

```ts
// yes — says what must be true, and reads as English in the CI output
it("rejects a package signed by a key the runtime does not pin", ...)

// no — says nothing a reader could not get from the function name
it("returns false", ...)
it("works", ...)
it("test verifyPackage 2", ...)
```

If a test fails in CI, its name is the entire bug report a maintainer sees first.
Make the name carry the claim.

**Arrange, act, assert — one behaviour per test.** A test that asserts five
unrelated things fails ambiguously and teaches you nothing about which one broke.
Split it.

**Do not mock the thing you are testing, and do not mock what is cheap and real.**
Crypto, hashing, tar, zlib, Zod, the filesystem via a temp dir — use the real
implementation. A signature check that passes against a fake verifier has verified
nothing; a password test against a stubbed bcrypt proves nothing about passwords.
Mock only what is genuinely external and slow or unavailable in a unit test:
**the network (`fetch`), Postgres (Prisma), Redis, and S3.** Mock those with a
plain object, not a framework.

**Every test must be able to fail.** No snapshot tests — a snapshot documents
nothing and gets rubber-stamped on the next `--update`. If you cannot describe, in
the test name, the specific thing that would be wrong if the test went red, you
have not written a test yet.

**Comment the *why*, not the *what*.** A comment on a test says what breaks in
production if this regresses — the reason the test earns its place in the suite.
It does not narrate the code.

```ts
// A checksum the API disagrees with means the version was republished or the
// cache was tampered with. Re-fetching is the only safe response.
```

### Security tests: write from the attacker's side

A test for a security boundary does not check that the boundary exists. It plays
the attacker: it *builds the exploit*, runs it, and asserts the system refused.

```ts
it("rejects a package signed by a key the runtime does not pin", () => {
  // THE ATTACK: an attacker who owns cms-api serves hostile bytes AND an
  // envelope signed by a key they generated. The runtime pins the real key in
  // its own config, so the forgery has nothing to hide behind.
  const attacker = generateKeyPair();
  const forged = { ...hostilePayloadEnvelope, marketplaceSignature: signChecksum(checksum, attacker.privateKey) };

  expect(() => verifyPackage(forged, payload, realMarketplaceKey)).toThrow(/not released by Z-CMS/);
});
```

Every security test opens with a one-line comment naming the attack. The three
boundaries the platform lives or dies by, and where their unit tests sit:

| Boundary | Attack a test must attempt | Where |
| --- | --- | --- |
| Package signing | forged signature, spliced signature, unsigned package, tampered payload | `packages/package` |
| Malware scan | every dangerous pattern flagged; benign code *not* flagged | `packages/scanner` |
| Plugin sandbox | `constructor.constructor`, `globalThis.process`, infinite loop, OOM | `apps/plugin-runtime` |
| Tenant isolation | reading/writing another tenant's row; a client-supplied tenant id | `packages/database`, `apps/cms-api` |
| Path traversal | `../../etc/passwd`, URL-encoded, null byte, absolute path | `packages/package`, `apps/site-runtime` |
| Auth | expired/wrong-secret/`alg:none` token, replayed refresh token, user enumeration | `apps/cms-api` |

These complement the `verify-*` attack suites, they do not replace them: the unit
tests pin each module's refusal; the attack suites prove the assembled system
refuses end-to-end.

### If a test finds a real bug

Stop. Do not edit the source to make the test green — a security test that was
changed to pass is worse than no test. Leave the test asserting the *correct*
behaviour (so it is red), and say so loudly in your pull request. A failing test
that documents a real bug is a contribution; a passing test that hides one is a
liability.

## Coverage: the floor, not the target

Every package and app sets a coverage floor in its `vitest.config.ts`, and CI fails if
a change drops below it. The floors are deliberately unequal:

| Kind of code | Line floor |
| --- | --- |
| Contracts and queue (`schemas`, `queue`) | 90% |
| Security-critical (`package`, `scanner`, `plugin-sdk`, `theme-sdk`, `i18n`) | 85% |
| Core services (`database`, `worker`, `plugin-runtime`) | 75–80% |
| Apps and UI (`cms-api`, `site-runtime`, `admin-web`) | 60–70% |

Two exceptions, both written down rather than quietly enjoyed:

- **`packages/cli` has a floor of 0.** Its logic lives in `main.ts` and the `verify-*`
  entry points, which the harness always excludes from coverage; a floor over an empty
  measurement is theatre. Its behaviour is covered by tests all the same.
- **`plugins/seo` and `plugins/zai` set no floor at all** and do not call `preset()`.
  That is debt, not design — their tests can rot and CI will not notice. It is listed
  in [architecture.md](./architecture.md#what-we-still-owe-plainly).

Coverage counts files with *no* test against you (`all: true`), so deleting a test
can only lower the number, never raise it. But the floor is a floor: 85% of the
lines of the signing code being executed is the *minimum* bar for calling it
tested, not the goal. The goal is that every refusal path — every `throw`, every
`return false` that stops an attack — has a test that reaches it. Coverage is how
we catch the ones you forgot, not a score to farm.

Raising a package's floor above the default is welcome. Lowering it needs a reason
in the pull request.

## The harness (you should never need to touch it)

One file configures everything: [`vitest.shared.ts`](../vitest.shared.ts) at the
repo root. Each package's `vitest.config.ts` is three lines that call `preset()`:

```ts
import { preset } from "../../vitest.shared";

export default preset({
  coverage: { lines: 85, functions: 85, branches: 80, statements: 85 },
});
```

That is the entire per-package configuration. You do not choose a reporter, a
coverage provider, a timeout, or an environment — the preset does, once, for the
whole platform, so that no two suites disagree and no reviewer has to check
whether you chose well. React packages pass `environment: "jsdom"` and a setup
file; that is the only common deviation, and it is documented in the preset.

If the harness itself needs to change, it changes in `vitest.shared.ts` and every
package inherits it. Adding a global reporter or a new default belongs there, in
one place, in a pull request that says why.

## New package checklist

Adding a workspace package? It is tested the moment you:

1. add `"test": "vitest run"`, `"test:watch": "vitest"`, and
   `"test:coverage": "vitest run --coverage"` to its `package.json`;
2. add `vitest` and `@vitest/coverage-v8` (both `4.1.10`) to its `devDependencies`;
3. create `vitest.config.ts` calling `preset({ coverage: { … } })` with a floor
   appropriate to how dangerous the code is (see the table above);
4. write at least one `test/*.test.ts` that asserts a real behaviour.

`pnpm test` picks it up with no further wiring — turbo runs `test` in every
package that defines it, and `pnpm verify:test-convention` confirms the package
declares a suite before CI spends time building it.
