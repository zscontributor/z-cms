import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Marks dist/esm as ESM. This package.json has no top-level `"type": "module"` so
 * the CJS build keeps working for cms-api; a scoped package.json in dist/esm is the
 * standard way to say "everything below here is ESM". tsc emits modules, not
 * package metadata, so the build writes it. Mirrors theme-sdk's script.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.join(root, "dist/esm/package.json");

fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, JSON.stringify({ type: "module" }, null, 2) + "\n");

console.log("theme-widgets: dist/esm marked as ESM");
