import fs from "node:fs";

/**
 * Rewrite a bundled theme's `react/jsx-runtime` import so it survives BOTH the runtime
 * and the marketplace scanner. Run this on the final `dist/index.mjs` after esbuild.
 *
 * esbuild's automatic JSX emits `import { jsx, jsxs, Fragment } from "react/jsx-runtime"`
 * and keeps it external, so every theme shares site-runtime's single React (two Reacts in
 * one render is the classic "invalid hook call"). On the packaged path that import breaks
 * two ways, and the two are why this transform exists rather than a tidier structural
 * import:
 *
 *   1. `react/jsx-runtime` ships as CommonJS (`module.exports = require(...)`), so Node's
 *      ESM loader cannot surface `jsx` / `Fragment` as named exports when site-runtime
 *      `import()`s the unpacked bundle — it throws `Named export 'Fragment' not found`.
 *   2. The obvious workaround — pulling the runtime in via `createRequire` from
 *      `node:module` — is exactly the pattern the MARKETPLACE SCANNER BLOCKS: a theme has
 *      no business reaching for `require()` to get around the module rules, so a package
 *      that does is rejected at submission. (We learned this the hard way.)
 *
 * The default import sidesteps both: it IS the whole `module.exports`, so `jsx`/`Fragment`
 * are present at run time, and it is a plain import the scanner is happy with. So rewrite
 * the named import into a default import plus a destructure. It operates on the FINAL
 * bundle, so it also fixes theme-sdk's precompiled JSX inlined alongside the theme's own.
 * Sharing React is unchanged — `react` itself stays external.
 */
export function toDefaultJsxRuntimeImport(entryFile) {
  const before = fs.readFileSync(entryFile, "utf8");
  let i = 0;
  const after = before.replace(
    /import\s*\{([^}]*)\}\s*from\s*["']react\/jsx-runtime["'];?/g,
    (_match, specifiers) => {
      const id = `__jsxRuntime${i++}`;
      const decls = specifiers
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => {
          const [name, local] = s.split(/\s+as\s+/);
          return local ? `${name}: ${local}` : name;
        })
        .join(", ");
      return `import ${id} from "react/jsx-runtime"; const { ${decls} } = ${id};`;
    },
  );
  if (after !== before) fs.writeFileSync(entryFile, after);
}
