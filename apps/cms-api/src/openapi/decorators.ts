import { applyDecorators, type Type } from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiHeader,
  ApiResponse,
  ApiSecurity,
  type ApiResponseOptions,
} from "@nestjs/swagger";
import type { Permission } from "@zcmsorg/schemas";
import { schemaRef, type RequestSchemaId, type ResponseSchemaId } from "./registry";

/**
 * Route decorators that speak in the API's own vocabulary.
 *
 * A controller should say "this is site-scoped and needs content:publish", not
 * repeat six `@ApiResponse` blocks. The security schemes, the `X-Site-Id`
 * requirement and the error bodies are properties of *how this API works*, so
 * they are declared once here and applied by name — which also means the 401 on
 * every authenticated route stays identical to the 401 on every other one.
 */

export const BEARER_SCHEME = "accessToken";
export const INTERNAL_SCHEME = "internalToken";
export const PLUGIN_SCHEME = "pluginToken";

const errorRef = { $ref: schemaRef("Error") };

const error = (status: number, description: string): ApiResponseOptions => ({
  status,
  description,
  schema: errorRef,
});

/** 400 is possible anywhere a body or a query is parsed. */
const BAD_REQUEST = error(400, "Validation failed. `errors[]` names each rejected field.");
const UNAUTHORIZED = error(401, "Missing, expired, or revoked access token.");
const NOT_FOUND = error(404, "No such resource in this tenant.");

/**
 * A session-authenticated route: Bearer access token, and the standard refusals.
 *
 * `permissions` is documentation, not enforcement — the guard reads the same list
 * from `@RequirePermissions()`. It is spelled out here because "403" without
 * naming the permission is a support ticket waiting to happen.
 */
export function ApiAuthed(...permissions: Permission[]) {
  const forbidden = permissions.length
    ? `Role lacks ${permissions.map((p) => `\`${p}\``).join(" and ")}.`
    : "Role does not permit this action.";

  return applyDecorators(
    ApiBearerAuth(BEARER_SCHEME),
    ApiResponse(UNAUTHORIZED),
    ApiResponse(error(403, forbidden)),
  );
}

/**
 * Requires `X-Site-Id`. The guard only accepts a site the caller holds a role on,
 * so this header is proven, never trusted — see AuthGuard.
 */
export function ApiSiteScoped() {
  return applyDecorators(
    ApiHeader({
      name: "X-Site-Id",
      required: true,
      description: "The site to act on. Must be a site the caller has a role on.",
      schema: { type: "string", format: "uuid" },
    }),
    ApiResponse(error(403, "`X-Site-Id` missing, malformed, or not a site you may act on.")),
  );
}

/** Called by our own runtimes (site-runtime, worker), not by users. */
export function ApiInternal() {
  return applyDecorators(
    ApiSecurity(INTERNAL_SCHEME),
    ApiResponse(error(401, "Missing or wrong `X-Internal-Token`.")),
  );
}

/** Called by the plugin sandbox with a short-lived, scoped plugin token. */
export function ApiPluginToken() {
  return applyDecorators(
    ApiBearerAuth(PLUGIN_SCHEME),
    ApiResponse(error(401, "Missing, expired, or invalid plugin token.")),
    ApiResponse(error(403, "The plugin was not granted the scope this method needs.")),
  );
}

export function ApiZodBody(id: RequestSchemaId) {
  return applyDecorators(
    ApiBody({ schema: { $ref: schemaRef(id) } }),
    ApiResponse(BAD_REQUEST),
  );
}

interface ZodResponseOptions {
  status?: number;
  description?: string;
  isArray?: boolean;
}

export function ApiZodResponse(id: ResponseSchemaId, options: ZodResponseOptions = {}) {
  const { status = 200, description, isArray = false } = options;
  const item = { $ref: schemaRef(id) };

  return ApiResponse({
    status,
    description,
    schema: isArray ? { type: "array", items: item } : item,
  });
}

/**
 * `POST /auth/login` has two 200s, and a client that assumes one is broken.
 *
 * A `oneOf` rather than a fat schema with everything optional: the difference
 * between "here are your tokens" and "prove you have the second factor" is not a
 * missing field, it is a different answer, and a generated client should be made
 * to branch on it. `mfaRequired` is the discriminator, and it is the only reason
 * a caller can tell the two apart without guessing.
 */
export function ApiLoginResponse() {
  return ApiResponse({
    status: 200,
    description:
      "Either a token pair (no second factor on this account) or an MFA " +
      "challenge. Branch on `mfaRequired`.",
    schema: {
      oneOf: [{ $ref: schemaRef("AuthResult") }, { $ref: schemaRef("MfaChallenge") }],
      discriminator: { propertyName: "mfaRequired" },
    },
  });
}

/** The `Paginated<T>` envelope, which is a generic and so has no component of its own. */
export function ApiPaginatedResponse(id: ResponseSchemaId, description?: string) {
  return ApiResponse({
    status: 200,
    description,
    schema: {
      type: "object",
      required: ["items", "page", "perPage", "total", "totalPages"],
      properties: {
        items: { type: "array", items: { $ref: schemaRef(id) } },
        page: { type: "integer", example: 1 },
        perPage: { type: "integer", example: 20 },
        total: { type: "integer", example: 137 },
        totalPages: { type: "integer", example: 7 },
      },
    },
  });
}

export const ApiNotFound = (description = NOT_FOUND.description) =>
  ApiResponse({ ...NOT_FOUND, description });

/** 204: the resource is gone and there is nothing to say about it. */
export const ApiNoContent = (description: string) =>
  ApiResponse({ status: 204, description });

/** Rate-limited routes answer 429 with a Retry-After. */
export const ApiRateLimited = (description: string) =>
  ApiResponse({
    status: 429,
    description,
    headers: {
      "Retry-After": {
        description: "Seconds until the next attempt is accepted.",
        schema: { type: "integer" },
      },
    },
    schema: errorRef,
  });

/**
 * A multipart upload. Nest cannot infer the part name from the interceptor.
 *
 * `fields` documents the other parts the route reads alongside the file — they
 * are ordinary form fields, not a JSON body, so no Zod component describes them.
 */
export function ApiFileUpload(
  description: string,
  fields: Record<string, { type: string; description?: string }> = {},
) {
  return applyDecorators(
    ApiConsumes("multipart/form-data"),
    ApiBody({
      description,
      required: true,
      schema: {
        type: "object",
        required: ["file"],
        properties: { file: { type: "string", format: "binary" }, ...fields },
      },
    }),
    ApiResponse(BAD_REQUEST),
  );
}

/** Kept for the rare route whose response really is a decorated class. */
export type ApiModel = Type<unknown>;
