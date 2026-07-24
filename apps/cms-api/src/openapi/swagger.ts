import { Logger } from "@nestjs/common";
import type { INestApplication } from "@nestjs/common";
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from "@nestjs/swagger";
import { BEARER_SCHEME, INTERNAL_SCHEME, PLUGIN_SCHEME } from "./decorators";
import { serveDocsDisabledPage } from "./docs-disabled";
import { buildComponentSchemas } from "./registry";

/**
 * The prefix every route hangs off. Exported so `main.ts` and the `openapi:json`
 * script cannot disagree: a document generated without it describes an API at
 * `/contents` that only answers at `/api/v1/contents`, and every client generated
 * from that file 404s on its first call.
 */
export const GLOBAL_PREFIX = "api/v1";

/** Where the UI and the raw document are served, under the global prefix. */
export const DOCS_PATH = "docs";
export const DOCS_JSON_PATH = "docs-json";

const DESCRIPTION = `
The HTTP contract behind Z-CMS: content, media, menus, themes, plugins and the
marketplace.

### Authentication

Three different callers, three credentials — a route accepts exactly one of them.

| Caller | Credential | Used by |
| --- | --- | --- |
| A signed-in human | \`Authorization: Bearer <accessToken>\` from \`POST /auth/login\` | admin-web |
| Our own runtimes | \`X-Internal-Token\` | site-runtime, worker |
| Plugin sandbox code | \`Authorization: Bearer <pluginToken>\` | the isolated-vm gateway |

Access tokens are short-lived; rotate them with \`POST /auth/refresh\`, which also
rotates the refresh token. Reuse of a spent refresh token revokes the whole
family — that is theft detection, not an error to retry through.

### Choosing a site

Most routes act on one site and require \`X-Site-Id\`. The header is
attacker-controlled, so the API only honours it after confirming the caller holds
a role on that site, inside their own tenant. A site you cannot see and a site
that does not exist are the same 403.

### Errors

Every failure returns the same envelope. Validation failures (400) additionally
carry \`errors[]\`, one entry per rejected field, with the message already
translated into the caller's locale (\`Accept-Language\`).
`.trim();

/**
 * Builds the OpenAPI document from the live route table.
 *
 * Separate from serving it, because `openapi:json` needs the document without a
 * listening server, and the two must not be able to describe different APIs.
 */
export function buildDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle("Z-CMS API")
    .setDescription(DESCRIPTION)
    .setVersion(process.env.CMS_API_VERSION ?? "0.1.0")
    .setLicense("MIT", "https://github.com/zscontributor/z-cms/blob/main/LICENSE")
    .setExternalDoc(
      "Architecture and security notes",
      "https://github.com/zscontributor/z-cms/tree/main/docs",
    )
    .addServer(process.env.CMS_API_URL ?? "http://localhost:4100", "This instance")
    .addBearerAuth(
      {
        type: "http",
        scheme: "bearer",
        bearerFormat: "JWT",
        description: "Access token from POST /auth/login or /auth/refresh.",
      },
      BEARER_SCHEME,
    )
    .addApiKey(
      {
        type: "apiKey",
        in: "header",
        name: "X-Internal-Token",
        description: "Shared secret between cms-api and our own runtimes. Never sent to a browser.",
      },
      INTERNAL_SCHEME,
    )
    .addBearerAuth(
      {
        type: "http",
        scheme: "bearer",
        description: "Short-lived token minted for one plugin, carrying only the scopes it was granted.",
      },
      PLUGIN_SCHEME,
    )
    .addTag("Auth", "Sessions: login, token rotation, and who am I.")
    .addTag("Sites", "The sites in your tenant.")
    .addTag("Content types", "The shape of content: fields, routing, singletons.")
    .addTag("Content", "Entries, and their publication state.")
    .addTag("Media", "Uploads. Variants are generated off the request path.")
    .addTag("Menus", "Navigation trees, replaced whole rather than patched.")
    .addTag("Themes", "The catalog, what is installed, and what is active.")
    .addTag("Plugins", "Install, consent, activate, configure.")
    .addTag("Packages", "Marketplace intake: scanning, review, revocation.")
    .addTag("Publishers", "Who may sign a package, and whether we trust them.")
    .addTag("Jobs", "The dead-letter queue, made operable.")
    .addTag("Render", "Internal: everything site-runtime needs to draw one URL.")
    .addTag("Plugin gateway", "Internal: the sandbox's only way to affect the world.")
    .addTag("Health", "Liveness.")
    .build();

  const document = SwaggerModule.createDocument(app, config);

  // Nest builds `components.schemas` from decorated classes; this API validates
  // with Zod and returns plain interfaces, so its schemas are generated from
  // those contracts instead and merged in here. See openapi/registry.ts.
  document.components ??= {};
  // The cast is the one place Zod's output meets Nest's types: what
  // `toJSONSchema(target: "openapi-3.0")` emits *is* an OpenAPI schema object,
  // but it is typed as plain JSON and TypeScript cannot know the two agree.
  document.components.schemas = {
    ...document.components.schemas,
    ...buildComponentSchemas(),
  } as NonNullable<OpenAPIObject["components"]>["schemas"];

  pruneAgentHeaders(document);

  return document;
}

/**
 * Headers the *caller's agent* owns are not request parameters.
 *
 * `@Headers("user-agent")` on `/auth/login` is how the controller reaches the
 * value it records against the session — but Nest's explorer sees a header
 * binding and publishes it as a required parameter. Swagger UI then refuses to
 * send the request until a human types a User-Agent, which is absurd twice over:
 * the controller treats it as optional, and browsers forbid scripts from setting
 * that header at all, so whatever was typed would be discarded on its way out.
 *
 * `authorization` is here for the same reason from the other direction: it is
 * described once, properly, as a security scheme, and a second free-text box for
 * it would let a caller fight with the Authorize button and lose.
 */
const AGENT_HEADERS = new Set(["user-agent", "authorization", "cookie", "host"]);

function pruneAgentHeaders(document: OpenAPIObject): void {
  for (const item of Object.values(document.paths ?? {})) {
    for (const operation of Object.values(item)) {
      const parameters = (operation as { parameters?: { in: string; name: string }[] })
        .parameters;
      if (!Array.isArray(parameters)) continue;

      (operation as { parameters?: unknown[] }).parameters = parameters.filter(
        (parameter) =>
          !(parameter.in === "header" && AGENT_HEADERS.has(parameter.name.toLowerCase())),
      );
    }
  }
}

/**
 * Mounts Swagger UI and the raw document, in every environment including
 * production.
 *
 * Z-CMS is meant to be integrated against — themes, plugins and other people's
 * clients all speak this API — and docs that only exist on a developer's laptop
 * are docs nobody building against a real instance can read. The document also
 * discloses nothing a caller could not learn by trying: it names the endpoints
 * and the permission each one demands, but the guard, not the document, is what
 * refuses the request. Hiding the map does not lock the door.
 *
 * `SWAGGER_ENABLED=false` takes it down for an instance that is nobody's
 * integration target.
 */
export function setupSwagger(app: INestApplication): void {
  if (!swaggerEnabled()) {
    // Off is a decision, and a decision should be able to explain itself.
    serveDocsDisabledPage(app, {
      docs: `/${GLOBAL_PREFIX}/${DOCS_PATH}`,
      docsJson: `/${GLOBAL_PREFIX}/${DOCS_JSON_PATH}`,
    });
    new Logger("Swagger").log("API docs disabled (SWAGGER_ENABLED=false).");
    return;
  }

  const document = buildDocument(app);

  SwaggerModule.setup(DOCS_PATH, app, document, {
    useGlobalPrefix: true,
    jsonDocumentUrl: DOCS_JSON_PATH,
    customSiteTitle: "Z-CMS API",
    swaggerOptions: {
      // Deep-linkable, and the auth you enter survives a reload — the two things
      // that decide whether anyone actually uses the UI to try a call.
      persistAuthorization: true,
      deepLinking: true,
      displayRequestDuration: true,
      docExpansion: "list",
      tagsSorter: "alpha",
      operationsSorter: "alpha",
    },
  });

  const origin =
    process.env.CMS_API_URL ?? `http://localhost:${process.env.CMS_API_PORT ?? 4100}`;
  new Logger("Swagger").log(`API docs on ${origin}/${GLOBAL_PREFIX}/${DOCS_PATH}`);
}

/** On everywhere. Only an explicit "false" takes the docs down. */
function swaggerEnabled(): boolean {
  return process.env.SWAGGER_ENABLED !== "false";
}
