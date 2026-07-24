import fs from "node:fs";
import path from "node:path";
import esbuild from "esbuild";
import { LayoutDocumentSchema, getWidgetSpec, type LayoutDocument, type LayoutNode } from "@zcmsorg/schemas";
import { emitIndexTsx, emitLayoutJson, emitPackageJson, emitThemeJson } from "./emit";
import { buildManifest, type ThemeIdentity } from "./manifest";

/**
 * Drawing in, buildable theme directory out — then a bundle.
 *
 * The output is exactly the shape `zcms pack` expects and `buildPackage` requires:
 * a `theme.json`, a built `dist/index.mjs`, and a `dist/theme.css`. Nothing else
 * travels, and that is not incidental — the packer's DENIED list drops `src/`,
 * `build.mjs` and every `*.config.*` from the payload, so anything the theme needs
 * at run time has to be INSIDE the bundle by the time this function returns.
 */

/**
 * Where the theme's own imports resolve from.
 *
 * The generated theme is written to a TEMP directory — it has to be, it is built
 * once and thrown away — and a temp directory has no node_modules. esbuild resolves
 * a bare import by walking up from the importing file, so `@zcmsorg/theme-sdk` in
 * /var/folders/…/src/index.tsx resolves against /var/folders, then /var, then /,
 * and fails.
 *
 * So resolution is pointed back HERE, at the package that actually depends on the
 * SDK and the widget library. `nodePaths` rather than `alias` on purpose: an alias
 * to a file path would bypass the packages' `exports` map, and picking the wrong
 * half of the SDK's dual build is precisely the failure it was split to avoid —
 * handed the CJS build, esbuild emits a `__require` shim for react/jsx-runtime that
 * throws the moment the theme is loaded.
 */
const PACKAGE_ROOT = path.resolve(__dirname, "..");
const RESOLVE_PATHS = [path.join(PACKAGE_ROOT, "node_modules")];

export interface GenerateInput {
  identity: ThemeIdentity;
  /** The drawing. Re-validated here: this is the last gate before code is emitted. */
  document: unknown;
  /** Where to write the theme. Created if missing; must be empty or non-existent. */
  dir: string;
}

export class CodegenError extends Error {}

/**
 * Writes the theme's source tree.
 *
 * The document is parsed rather than trusted, even though cms-api validated it on
 * the way into the database. The row could have been written by an older build, or
 * by a hand-run UPDATE, and this is the function that turns it into something the
 * platform SIGNS. A signature over a document nobody checked is a signature that
 * means nothing.
 */
export function generateThemeDir(input: GenerateInput): { manifest: ReturnType<typeof buildManifest> } {
  const parsed = LayoutDocumentSchema.safeParse(input.document);
  if (!parsed.success) {
    throw new CodegenError(`The design is not a valid layout document: ${parsed.error.message}`);
  }
  const doc: LayoutDocument = parsed.data;

  assertKnownWidgets(doc);

  const manifest = buildManifest(input.identity, doc);

  fs.mkdirSync(path.join(input.dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(input.dir, "theme.json"), emitThemeJson(manifest));
  fs.writeFileSync(path.join(input.dir, "package.json"), emitPackageJson(manifest));
  fs.writeFileSync(path.join(input.dir, "src", "index.tsx"), emitIndexTsx());
  fs.writeFileSync(path.join(input.dir, "src", "layout.json"), emitLayoutJson(doc));

  return { manifest };
}

/**
 * A widget the library cannot draw must not reach a signed package.
 *
 * The renderer SKIPS an unknown widget at run time so that an old runtime survives
 * a new document. That tolerance is right there and wrong here: a package being
 * built now, by this build, containing a widget this build has never heard of would
 * ship a theme with a permanent hole in it and no error anywhere.
 */
function assertKnownWidgets(doc: LayoutDocument): void {
  const unknown = new Set<string>();
  for (const tree of Object.values(doc.templates)) {
    if (!Array.isArray(tree)) continue;
    const stack: LayoutNode[] = [...tree];
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (node.kind === "widget" && node.widgetType && !getWidgetSpec(node.widgetType)) {
        unknown.add(node.widgetType);
      }
      for (const child of node.children ?? []) stack.push(child);
    }
  }
  if (unknown.size > 0) {
    throw new CodegenError(
      `The design uses widgets this version cannot build: ${[...unknown].sort().join(", ")}.`,
    );
  }
}

/**
 * Bundles the theme into `dist/index.mjs` and copies the widget stylesheet.
 *
 * The esbuild options mirror `themes/default/build.mjs` — deliberately, field for
 * field, because a drawn theme is loaded by the same theme-loader as a written one
 * and any difference here is a difference in how the runtime will treat it:
 *
 *   external react   two Reacts in one render is "invalid hook call" in prod only.
 *   format esm       the loader import()s the bundle.
 *   lineLimit 200    the marketplace scanner FLAGS long lines as obfuscation, and
 *                    inlining theme.json + layout.json puts the whole drawing on
 *                    one line. The honest fix is a reviewable bundle, not an
 *                    argument with the scanner.
 */
export async function buildThemeDir(dir: string): Promise<void> {
  await esbuild.build({
    entryPoints: [path.join(dir, "src/index.tsx")],
    outfile: path.join(dir, "dist/index.mjs"),
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    jsx: "automatic",
    external: ["react", "react/jsx-runtime", "react-dom"],
    lineLimit: 200,
    logLevel: "silent",
    // See RESOLVE_PATHS: the theme is built in a temp dir with no node_modules.
    nodePaths: RESOLVE_PATHS,
    // The ESM half of the SDK/widget dual builds. Without this, esbuild resolves
    // the CJS entry and the bundle throws "Dynamic require of react/jsx-runtime is
    // not supported" at load — which no test that only checks the file exists would
    // ever catch.
    conditions: ["import"],
  });

  // The stylesheet ships as authored, exactly as the default theme's does: Tailwind
  // never scans a downloaded theme, so a theme that expected to be scanned arrives
  // unstyled. @zcmsorg/theme-widgets is bundled INTO index.mjs (the packer drops
  // src/, so it could not be shipped any other way), and its CSS comes along here.
  const css = require.resolve("@zcmsorg/theme-widgets/widgets.css", { paths: RESOLVE_PATHS });
  fs.mkdirSync(path.join(dir, "dist"), { recursive: true });
  fs.copyFileSync(css, path.join(dir, "dist/theme.css"));
}

/** Generate + build in one call — what the worker actually wants. */
export async function generateAndBuild(input: GenerateInput) {
  const result = generateThemeDir(input);
  await buildThemeDir(input.dir);
  return result;
}
