import esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { toDefaultJsxRuntimeImport } from "../../scripts/jsx-runtime-interop.mjs";

/**
 * Builds the distributable bundle: `dist/index.mjs` + `dist/theme.css`.
 *
 * Unlike `themes/default`, this theme exists only as a PACKAGE: it is fetched,
 * verified and unpacked by the runtime, loaded from `dist/index.mjs`, and serves
 * its stylesheet from `dist/theme.css`. Nothing about it is compiled into
 * site-runtime, so there is no second copy to keep in sync.
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
  // Wrap long lines. The marketplace scanner flags any package containing a line
  // too long for a human to read — minified or obfuscated code is what someone
  // hiding something ships. This bundle trips that rule by accident: theme.json is
  // imported for the manifest, and esbuild inlines all of it, demo content and all,
  // onto one line thousands of characters wide. Make the bundle reviewable rather
  // than argue with the scanner about it.
  lineLimit: 200,

  logLevel: "warning",
});

// Rewrite react/jsx-runtime to a default import — CJS-safe at run time and
// scanner-safe (no createRequire/node:module). See the helper.
toDefaultJsxRuntimeImport(path.join(root, "dist/index.mjs"));

// Copied rather than processed: the stylesheet ships as authored. Tailwind never
// sees a downloaded theme's classes, so a theme that expected to be scanned would
// arrive unstyled — this one carries all the CSS it needs.
fs.copyFileSync(path.join(root, "src/theme.css"), path.join(root, "dist/theme.css"));

console.log("theme-magazine: dist/index.mjs + dist/theme.css");
