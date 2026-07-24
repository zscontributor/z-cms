# The API document

`cms-api` describes itself. Start it and open:

```
http://localhost:4100/api/v1/docs        # Swagger UI
http://localhost:4100/api/v1/docs-json   # the raw OpenAPI 3.0 document
```

`pnpm openapi` writes the same document to `apps/cms-api/openapi.json` without
starting a server — that is the file to feed a client generator, or to diff in a
review when you want to see what a change did to the contract.

## Why it cannot drift

A hand-written spec is a second description of the wire format, and a second
description is wrong the first time someone adds a field. This one is generated
from the things the API already uses at runtime:

- **Requests** are the Zod schemas the validation pipe rejects on. The body
  documented for `POST /contents` *is* `CreateContentSchema` — there is no second
  copy to forget to update.
- **Responses** are Zod mirrors of the DTO interfaces, each pinned to its
  interface by a compile-time equality assertion at the bottom of
  [`openapi/registry.ts`](../apps/cms-api/src/openapi/registry.ts). Add a field to
  `MediaDto` and forget the schema, and `tsc` fails. That is not a theory — it is
  what caught `folderId` when the media library grew folders.
- **Routes, statuses and permissions** come from the decorators on the
  controllers, so a route that exists is a route that is documented.

CI runs `pnpm openapi`, which rebuilds the document from the live route table and
fails on an unresolved `$ref`. A broken document is a broken generated client.

Requests and responses are generated from **two** registries, with Zod's `io:
"input"` and `io: "output"`. The same schema is two different shapes on the wire:
`status` is optional in a `POST /contents` body because it defaults to `DRAFT`,
and always present in the response. One registry would have to be wrong about one
of them.

## Three callers, three credentials

A route accepts exactly one of these. The document says which, per operation.

| Caller | Credential | Who sends it |
| --- | --- | --- |
| A signed-in human | `Authorization: Bearer <accessToken>` | admin-web |
| Our own runtimes | `X-Internal-Token` | site-runtime, worker |
| Sandboxed plugin code | `Authorization: Bearer <pluginToken>` | the plugin gateway |

Most routes also need `X-Site-Id`. It is attacker-controlled, so the guard only
honours it after confirming the caller holds a role on that site inside their own
tenant — see [`auth.guard.ts`](../apps/cms-api/src/auth/auth.guard.ts) and
[security.md](./security.md).

## Trying a call in the UI

1. `POST /auth/login` with the seed admin (`SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`).
   If that account has two-factor auth enabled, login returns a challenge rather than
   tokens — complete `POST /auth/mfa/verify` to get them.
2. Copy `accessToken` into **Authorize → accessToken**.
3. `GET /sites`, and copy an `id` into the `X-Site-Id` box on any site-scoped route.

The UI keeps the authorisation across reloads, so step 2 is once per browser, not
once per call.

## In production, too

The docs are served in every environment, production included. Z-CMS is meant to
be integrated against — themes, plugins and other people's clients all speak this
API — and documentation that only exists on a developer's laptop is documentation
nobody building against a real instance can read.

It is not a disclosure: the document names the endpoints and the permission each
one demands, but the guard is what refuses the request, and a caller could learn
the same map by trying. Hiding it would not lock the door, only make it harder to
knock on.

### Turning it off

A self-hosted instance running one private site has nobody writing a client
against it, so the docs buy it nothing. `SWAGGER_ENABLED=false` removes
`/api/v1/docs` and `/api/v1/docs-json` entirely — the API keeps serving, only the
page describing it goes:

```bash
SWAGGER_ENABLED=false      # /api/v1/docs -> 404, /api/v1/health -> 200
```

It is a switch on *serving* the document, not on producing it: `pnpm openapi`
still writes `openapi.json` from the route table, because that is a build step,
not a route.

Swagger UI is the one thing this API serves that must execute in a browser, so it
gets its own Content-Security-Policy — pinned to this origin — while every other
route keeps `default-src 'none'`. See [`main.ts`](../apps/cms-api/src/main.ts).
