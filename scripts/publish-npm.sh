#!/usr/bin/env bash
#
# Publishes the public Z-CMS author packages to npm, in dependency order.
#
#   @zcmsorg/schemas      -> no @zcmsorg deps            (publish first)
#   @zcmsorg/plugin-sdk   -> depends on @zcmsorg/schemas
#   @zcmsorg/theme-sdk    -> depends on @zcmsorg/schemas
#   @zcmsorg/cli          -> bundles @zcmsorg/package (private); no runtime deps
#
# Use pnpm, NOT npm: pnpm rewrites the `workspace:*` protocol to the real version
# (0.1.0) at pack time. `npm publish` would ship a literal "workspace:*" and every
# install of plugin-sdk/theme-sdk would fail.
#
# Prerequisites (one-time, must be done by a human — this script does neither):
#   1. The `@zcmsorg` org must exist on npmjs.com and you must be a member with
#      publish rights.  https://www.npmjs.com/org/create
#   2. `npm login` (or `pnpm login`) in this terminal, with 2FA available.
#
# Run from the repo root. Pass --dry-run to pack-and-validate without uploading.

set -euo pipefail

DRY_RUN=""
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN="--dry-run"
  echo ">> DRY RUN — nothing will be uploaded."
fi

cd "$(dirname "$0")/.."

echo ">> npm user: $(npm whoami)"

# Build the four packages fresh so dist/ matches source.
pnpm --filter @zcmsorg/schemas \
     --filter @zcmsorg/plugin-sdk \
     --filter @zcmsorg/theme-sdk \
     --filter @zcmsorg/cli \
     build

# Ordered publish. --access public is also set in each package's publishConfig,
# but passing it here makes the intent unmissable for a first-time scoped publish.
for pkg in @zcmsorg/schemas @zcmsorg/plugin-sdk @zcmsorg/theme-sdk @zcmsorg/cli; do
  echo ""
  echo ">> Publishing ${pkg} ..."
  pnpm --filter "${pkg}" publish --access public --no-git-checks ${DRY_RUN}
done

echo ""
echo ">> Done. Verify:"
echo "     npm view @zcmsorg/cli version"
echo "     npm view @zcmsorg/plugin-sdk version"
