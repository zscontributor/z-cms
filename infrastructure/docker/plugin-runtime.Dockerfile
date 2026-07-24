# plugin-runtime — executes untrusted marketplace plugins.
#
# isolated-vm is a native addon, so the build stage needs a toolchain. The
# runtime stage does not, and must not have one: a compiler in the container that
# runs third-party code is a gift to an attacker.

FROM node:24-bookworm-slim AS build

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN corepack enable

# `pnpm prune --prod` wipes and rebuilds node_modules, and pnpm refuses to remove a
# modules directory unattended unless it knows it is not talking to a human. Without
# this it aborts with ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY — in a Dockerfile,
# where there is never a TTY to ask.
ENV CI=true

WORKDIR /repo

COPY pnpm-workspace.yaml package.json ./
COPY tsconfig.base.json ./
# Every workspace package plugin-runtime depends on, transitively. pnpm resolves
# `workspace:*` against what is on disk, so a dependency this image forgets to copy
# is not a missing file at runtime — it is an install that fails outright.
COPY packages/schemas ./packages/schemas
COPY packages/plugin-sdk ./packages/plugin-sdk
COPY packages/package ./packages/package
COPY apps/plugin-runtime ./apps/plugin-runtime

RUN pnpm install --frozen-lockfile=false \
 && pnpm --filter @zcmsorg/schemas build \
 && pnpm --filter @zcmsorg/package build \
 && pnpm --filter @zcmsorg/plugin-sdk build \
 && pnpm --filter @zcmsorg/plugin-runtime build \
 && pnpm prune --prod

# ---------------------------------------------------------------------------
# builtin-plugins — the signed built-in plugin packages, and nothing else.
#
# Deliberately NOT part of the build stage above: `plugins/*` are workspace
# packages, so copying them in would drag their dependencies into the install for
# no reason. Nothing here is built — the `.zcms` was signed on a developer's
# machine by `pnpm sign:plugins` and is shipped as-is.
#
# Only `<name>/plugin.json` (which key is built in) and `<name>/*.zcms` (the signed
# bytes) are staged. Each plugin's source and `dist/` are left behind on purpose:
# the runtime executes the code it unpacks from the VERIFIED package, never a file
# from this directory, and an unsigned second copy of the same code inside the one
# container that runs untrusted plugins is an attack surface nothing reads.
#
# A compose deployment bind-mounts `plugins/` off the host; an orchestrator has no
# host checkout to mount, so without this the directory is empty and every built-in
# plugin is "not installed".
# ---------------------------------------------------------------------------
FROM node:24-bookworm-slim AS builtin-plugins
WORKDIR /stage
COPY plugins ./plugins
RUN set -eu; \
    mkdir -p /builtin/plugins; \
    found=0; \
    for dir in /stage/plugins/*/; do \
      name=$(basename "$dir"); \
      [ -f "$dir/plugin.json" ] || continue; \
      ls "$dir"*.zcms >/dev/null 2>&1 || continue; \
      mkdir -p "/builtin/plugins/$name"; \
      cp "$dir/plugin.json" "/builtin/plugins/$name/"; \
      cp "$dir"*.zcms "/builtin/plugins/$name/"; \
      found=$((found + 1)); \
    done; \
    [ "$found" -gt 0 ] || { echo "no signed built-in plugins found — run: pnpm sign:plugins" >&2; exit 1; }; \
    echo "staged $found built-in plugin(s)"

FROM node:24-bookworm-slim AS runtime

# No compiler, no package manager, no shell utilities beyond the base image.
WORKDIR /app

COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/apps/plugin-runtime/dist ./dist
COPY --from=build /repo/apps/plugin-runtime/node_modules ./node_modules
COPY --from=build /repo/packages ./packages

# The signed built-ins, at PLUGIN_DIR's default (`<dist>/../../../plugins`), which
# is also where compose bind-mounts the host copy — one path, whichever way the
# packages arrive. Owned by root, never written by the app: the runtime verifies
# these against FIRST_PARTY_PUBLIC_KEY, and a process that can rewrite what it
# verifies verifies nothing.
COPY --from=builtin-plugins /builtin/plugins /plugins

# Never root. Combined with read_only + cap_drop in compose, an attacker who
# breaks the isolate lands as an unprivileged user in a filesystem they cannot
# write to, holding no credentials.
USER node

ENV NODE_ENV=production
EXPOSE 4200

CMD ["node", "dist/main.js"]
