import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { AppModule } from "../app.module";
import { buildDocument, GLOBAL_PREFIX } from "./swagger";

/**
 * Writes openapi.json without serving anything.
 *
 * The document is generated from the running route table, so this has to build
 * the Nest application — but it never listens, and it never opens a connection:
 * providers are constructed, `onModuleInit` is not. That is what lets it run in
 * CI, where there is no database.
 *
 * The artefact is for the things a live `/docs` page cannot do: generating a
 * typed client, diffing the contract in review, publishing to a portal.
 */
async function main(): Promise<void> {
  const app = await NestFactory.create(AppModule, { logger: false, preview: true });

  // The same prefix main.ts mounts the routes under. Without it the document
  // describes an API at /contents that only ever answers at /api/v1/contents.
  app.setGlobalPrefix(GLOBAL_PREFIX);

  const document = buildDocument(app);
  await app.close();

  const target = resolve(process.argv[2] ?? "openapi.json");
  writeFileSync(target, `${JSON.stringify(document, null, 2)}\n`);

  const paths = Object.keys(document.paths ?? {}).length;
  const operations = Object.values(document.paths ?? {}).reduce(
    (n, item) => n + Object.keys(item as object).length,
    0,
  );
  const schemas = Object.keys(document.components?.schemas ?? {}).length;

  // A dangling $ref renders as an empty box in Swagger UI and breaks every code
  // generator, and neither failure says which reference was wrong — so say it here.
  const dangling = danglingRefs(document);
  if (dangling.length > 0) {
    console.error(`Unresolved $refs:\n  ${dangling.join("\n  ")}`);
    process.exit(1);
  }

  console.log(`${target}: ${operations} operations over ${paths} paths, ${schemas} schemas.`);
}

/** Every `$ref` in the document that names a component the document does not define. */
function danglingRefs(document: unknown): string[] {
  const defined = new Set(
    Object.keys(
      (document as { components?: { schemas?: object } }).components?.schemas ?? {},
    ).map((id) => `#/components/schemas/${id}`),
  );
  const missing = new Set<string>();

  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== "object") return;

    for (const [key, value] of Object.entries(node)) {
      if (key === "$ref" && typeof value === "string" && !defined.has(value)) {
        missing.add(value);
      } else {
        walk(value);
      }
    }
  };

  walk(document);
  return [...missing];
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
