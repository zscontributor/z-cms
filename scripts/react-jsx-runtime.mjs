// An ESM-safe view of React's JSX runtime, for bundled themes.
//
// esbuild's automatic JSX emits `import { jsx, jsxs, Fragment } from "react/jsx-runtime"`.
// That module ships as CommonJS (`module.exports = require("./cjs/…")`), and when
// site-runtime `import()`s an unpacked theme, Node's ESM loader cannot surface those
// as named exports — the import throws `Named export 'Fragment' not found`. (The
// compiled-in default theme escapes it because Next bundles that copy with its own
// interop; only the packaged `import()` path hits it.)
//
// Theme builds alias `react/jsx-runtime` to this file, so both the theme's own JSX and
// theme-sdk's precompiled JSX resolve here instead. We load the real runtime through
// `createRequire` — a plain CommonJS require, which the bundler does not rewrite, so it
// neither re-triggers the alias (no recursion) nor trips over ESM/CJS named-export
// interop — and re-export its members as genuine ESM named exports. React itself stays
// external, so every theme still shares site-runtime's single React instance.
import { createRequire } from "node:module";

const runtime = createRequire(import.meta.url)("react/jsx-runtime");

export const Fragment = runtime.Fragment;
export const jsx = runtime.jsx;
export const jsxs = runtime.jsxs;
