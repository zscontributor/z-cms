# scripts

Repo-level scripts that sit outside any single workspace package — signing and
verifying built-ins, publishing, and a few build/CI helpers. Most are wired to a
`pnpm` alias in the root `package.json`; run those rather than calling the file
directly where an alias exists, because the alias also builds what the script
depends on first.

`.mts`/`.ts` scripts run through `tsx`; `.mjs` through plain `node`; `.sh` through
`bash`. All paths below are relative to the repo root.

## Signing built-ins (first-party trust)

Built-in plugins and themes ship inside the Docker image and run with the most
privilege in the system — a built-in theme is not sandboxed at all. They are not
trusted because they sit on the volume; they are **verified** against the pinned
first-party public key before anything runs. These three scripts are that chain.

| Script | Run it with | What it does |
| --- | --- | --- |
| `keygen-first-party.mts` | `pnpm keygen:first-party` | Generates the first-party signing keypair. Private half → `.keys/` (gitignored, `0600`, belongs in a secret manager); public half → `keys/zsoft-publisher.pub.pem` (committed — pinning it is the whole mechanism). **You should not normally run this** — only to bootstrap a fork or rotate the key, and a rotation means re-signing every built-in and reissuing `FIRST_PARTY_PUBLIC_KEY` to every runtime. |
| `sign-builtins.mts` | `pnpm sign:builtins` (or `sign:plugins` / `sign:themes`) | Signs each built-in and writes the `.zcms` next to it. Directories marked `.not-builtin` are skipped (they are marketplace-distributed, not first-party). Reads the private key from `ZCMS_PUBLISHER_KEY`. Direct form: `tsx scripts/sign-builtins.mts plugin\|theme`. |
| `verify-builtins.mts` | `pnpm verify:builtins` (part of `pnpm verify`, runs in CI) | The tripwire: every built-in `.zcms` **must** verify against `keys/zsoft-publisher.pub.pem` and must actually have one; `.not-builtin` dirs are exempt and reported as skipped. Guards the invariant whose breach once took down the AI assistant — one mis-signed package in `/plugins` blocks *every* genuine built-in. |

```sh
# Sign built-ins with the real key (never committed):
ZCMS_PUBLISHER_KEY=.keys/zsoft-publisher-private.pem pnpm sign:builtins
```

## Publishing

| Script | Run it with | What it does |
| --- | --- | --- |
| `publish-npm.sh` | `./scripts/publish-npm.sh [--dry-run]` | Publishes the public author toolchain to npm in dependency order: `@zcmsorg/schemas` → `plugin-sdk` → `theme-sdk` → `cli`. Uses **`pnpm publish`** so `workspace:*` is rewritten to the real version (`npm publish` would ship a literal `workspace:*` and break installs). Requires `npm login` and the `@zcmsorg` scope; `--dry-run` packs and validates without uploading. |
| `publish-themes.mts` | `tsx scripts/publish-themes.mts <theme…>` | Assembles a theme's payload **explicitly** (bundle, stylesheet, manifest, referenced assets — not the source tree) and submits it to the marketplace API, so the scanner never sees a build script's `fs` import. Env: `MARKETPLACE_API_URL`, `MARKETPLACE_EMAIL`, `MARKETPLACE_PASSWORD`, `ZCMS_PUBLISHER_KEY`, `ZCMS_PUBLISHER_PUB`. Output staged under `.packages/`. |

## Build & CI helpers

| Script | Run it with | What it does |
| --- | --- | --- |
| `jsx-runtime-interop.mjs` | post-build, on a theme's final `dist/index.mjs` | Rewrites the external `react/jsx-runtime` **named** import into a default import + destructure, so the bundle loads under Node's ESM loader (the runtime ships CJS) **and** passes the marketplace scanner (which blocks the `createRequire` workaround). React itself stays external, so themes still share the host's single React. |
| `theme-screenshots.mts` | `tsx scripts/theme-screenshots.mts <theme-dir> [...]` | Renders desktop screenshots of one or more themes via headless Chrome. Honours `CHROME_PATH` to locate the browser. |
| `verify-test-convention.mjs` | `pnpm verify:test-convention` (part of `pnpm verify`) | Fails CI if a workspace package that should have tests has no `test` script, enforcing the repo's testing convention. |

## Security note

The private signing keys live under `.keys/` (gitignored) and must never be
committed, pasted into a chat, or printed to a CI log. Only the **public** halves
(`keys/*.pub.pem`) are committed — pinning them is what makes verification work.
The real private keys belong in a secret manager, not on a laptop.
