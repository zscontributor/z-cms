import esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Builds the distributable bundle: `dist/index.mjs` + `dist/theme.css`.
 *
 * The default theme is the one theme that has to exist twice, because it is two
 * things at once:
 *
 *   - It is COMPILED IN to site-runtime as the fallback, which is why its
 *     package.json still exports `src/index.tsx` and its CSS is `@import`ed by the
 *     runtime's globals.css. The fallback must not depend on the download-verify-
 *     unpack machinery, since it is what that machinery falls back TO.
 *
 *   - It is also a PACKAGE, so that the marketplace can list it, sign it, and a
 *     site can install a newer version of it than the one its runtime shipped.
 *     A packaged theme is loaded from `dist/index.mjs` and serves its own CSS from
 *     `dist/theme.css`; that is what this script produces, and what `zcms pack`
 *     puts in the .zcms.
 *
 * React is external so the bundle shares the runtime's copy rather than carrying a
 * second one. Two Reacts in one render is the classic way a theme system produces
 * "invalid hook call" in production and nowhere else.
 */
const root = path.dirname(fileURLToPath(import.meta.url));

await esbuild.build({
  entryPoints: [path.join(root, "src/index.tsx")],
  outfile: path.join(root, "dist/index.mjs"),
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  jsx: "automatic",
  external: ["react", "react-dom"],
  // react/jsx-runtime is CommonJS, so its named exports cannot be ESM-imported when
  // site-runtime import()s this bundle. Redirect it to a small ESM shim (which also
  // catches theme-sdk's precompiled JSX); react itself stays external and shared.
  alias: { "react/jsx-runtime": path.resolve(root, "../../scripts/react-jsx-runtime.mjs") },

  // Wrap long lines.
  //
  // Not cosmetic: the marketplace scanner FLAGS a package that contains a line too
  // long for a human to read, on the grounds that minified or obfuscated code is
  // what someone hiding something ships. That rule is right, and this bundle trips
  // it by accident — `theme.json` is imported for the manifest, and esbuild inlines
  // the whole of it, demo content and all, onto a single line thousands of
  // characters wide.
  //
  // The honest fix is to make the bundle genuinely reviewable rather than to argue
  // with the scanner about it.
  lineLimit: 200,

  logLevel: "warning",
});

// Copied rather than processed: the stylesheet ships as authored. Tailwind never
// sees a downloaded theme's classes, so a theme that expected to be scanned would
// arrive unstyled — this one carries all the CSS it needs.
fs.copyFileSync(path.join(root, "src/theme.css"), path.join(root, "dist/theme.css"));

console.log("theme-default: dist/index.mjs + dist/theme.css");
