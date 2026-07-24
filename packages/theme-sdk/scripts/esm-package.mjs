import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Marks dist/esm as ESM.
 *
 * The SDK's own package.json has no `"type": "module"` — it cannot, because the CJS
 * build has to keep working for cms-api, which `require()`s it. Without that field,
 * Node reads every `.js` under this package as CommonJS, including the ESM build,
 * and an `import` statement in a file Node has decided is CJS is a syntax error.
 *
 * A package.json in the subdirectory is the standard way to say "everything below
 * here is ESM" and is scoped to exactly that directory. tsc will not write it (it
 * emits modules, not package metadata), so the build does.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.join(root, "dist/esm/package.json");

fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, JSON.stringify({ type: "module" }, null, 2) + "\n");

console.log("theme-sdk: dist/esm marked as ESM");
