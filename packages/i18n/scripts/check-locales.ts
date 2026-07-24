/**
 * Guards the catalogue.
 *
 * Translations rot in a specific, predictable way: someone adds a key to English
 * and no other language gets it; someone translates a key and drops the `{count}`
 * placeholder inside it; someone leaves a key behind after the feature that used
 * it was deleted. None of these break a build, and all of them reach production.
 *
 * So they break CI instead. English is the base — the set of keys it defines is
 * the contract every other locale is measured against.
 *
 *   pnpm --filter @zcmsorg/i18n check
 *
 * A missing key is a WARNING, not an error: falling back to English is a designed
 * behaviour, and a community translation that covers most of the app is worth
 * merging. An *extra* key, a wrong type, or a broken placeholder is an ERROR —
 * those are mistakes, not incompleteness.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  BASE,
  LOCALES_DIR,
  REQUIRED_NAMESPACES,
  STABLE_THRESHOLD,
  coverageOf,
} from "./coverage.js";

type Json = Record<string, unknown>;

function readNamespace(locale: string, file: string): Json {
  const path = join(LOCALES_DIR, locale, file);
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8")) as Json;
}

/** { "a": { "b": "x" } } -> { "a.b": "x" } */
function flatten(obj: Json, prefix = ""): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      for (const [k, v] of flatten(value as Json, path)) out.set(k, v);
    } else {
      out.set(path, value);
    }
  }
  return out;
}

function placeholders(value: string): Set<string> {
  return new Set([...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!));
}

const namespaces = readdirSync(join(LOCALES_DIR, BASE)).filter((f) => f.endsWith(".json"));
const locales = readdirSync(LOCALES_DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory() && e.name !== BASE)
  .map((e) => e.name);

let errors = 0;
let warnings = 0;

console.log(`Base locale: ${BASE} (${namespaces.length} namespaces)`);

for (const locale of locales) {
  const problems: string[] = [];
  let translated = 0;
  let total = 0;

  for (const ns of namespaces) {
    const base = flatten(readNamespace(BASE, ns));
    const target = flatten(readNamespace(locale, ns));

    for (const [key, baseValue] of base) {
      total++;

      if (typeof baseValue !== "string") {
        problems.push(`ERROR  ${ns}: "${key}" is not a string in the ${BASE} base`);
        continue;
      }

      if (!target.has(key)) {
        // Falls back to English. Worth reporting, not worth failing.
        continue;
      }

      translated++;
      const value = target.get(key);

      if (typeof value !== "string") {
        problems.push(`ERROR  ${ns}: "${key}" must be a string, got ${typeof value}`);
        continue;
      }

      const expected = placeholders(baseValue);
      const actual = placeholders(value);

      for (const name of expected) {
        if (!actual.has(name)) {
          problems.push(`ERROR  ${ns}: "${key}" is missing the {${name}} placeholder`);
        }
      }
      for (const name of actual) {
        if (!expected.has(name)) {
          problems.push(`ERROR  ${ns}: "${key}" has an unknown placeholder {${name}}`);
        }
      }
    }

    for (const key of target.keys()) {
      if (!base.has(key)) {
        problems.push(`ERROR  ${ns}: "${key}" does not exist in ${BASE} — stale key?`);
      }
    }
  }

  const missing = total - translated;
  const percent = total === 0 ? 100 : Math.round((translated / total) * 100);

  const { status, required } = coverageOf(locale);
  const badge = status === "stable" ? "OFFERED" : "EXPERIMENTAL";

  console.log(`\n${locale}: ${percent}% (${translated}/${total} keys) — ${badge}`);

  if (missing > 0) {
    warnings++;
    console.log(`  ${missing} key(s) fall back to ${BASE}.`);
  }

  // The number that actually decides whether anyone is shown this language.
  const req = Math.round(required.percent);
  console.log(
    `  ${req}% of the required namespaces (${REQUIRED_NAMESPACES.join(", ")}) — ` +
      `${required.translated}/${required.total} keys.`,
  );

  if (status === "experimental") {
    const needed =
      Math.ceil(STABLE_THRESHOLD * required.total) - required.translated;
    console.log(
      `  Not yet in the language switcher. ${needed} more required key(s) ` +
        `(${Math.round(STABLE_THRESHOLD * 100)}%) and it is offered to users.`,
    );
  }

  for (const problem of problems) {
    if (problem.startsWith("ERROR")) errors++;
    console.log(`  ${problem}`);
  }
}

if (errors > 0) {
  console.error(`\n${errors} error(s). The catalogue is inconsistent with the ${BASE} base.`);
  process.exit(1);
}

console.log(`\nCatalogue is consistent.${warnings ? " Some locales are incomplete." : ""}`);
