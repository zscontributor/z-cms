/**
 * Writes `src/locales.ts` and `src/catalog.ts` from what is actually on disk.
 *
 *   pnpm --filter @zcmsorg/i18n sync      # regenerate
 *   pnpm --filter @zcmsorg/i18n check     # fail if the generated files are stale
 *
 * Both files used to be maintained by hand, and that does not survive success.
 * Every language added nine import lines to one file, so two contributors
 * translating two unrelated languages collided in the same hunk of the same file.
 * Appending one line to `locales.json` is a conflict git can resolve on its own.
 *
 * The split into two generated files is not cosmetic — it is the whole point:
 *
 *   locales.ts   metadata only (codes, native names, direction). No JSON imports.
 *                Safe to import from a browser bundle.
 *   catalog.ts   the messages themselves — every locale, every namespace.
 *                Server-side only. Importing it from a client component would
 *                ship every language on earth to a user who reads one.
 *
 * `@zcmsorg/i18n/client` re-exports the first and not the second, so that rule is
 * enforced by the module graph rather than by a code review that has to notice.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BASE,
  LOCALES_DIR,
  REQUIRED_NAMESPACES,
  STABLE_THRESHOLD,
  coverageOf,
} from "./coverage.js";
import { flagFor, looksLikeLanguageCode } from "../src/flags.js";
import { FLAGS_SRC, hasFlag } from "./flags-source.js";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const REGISTRY = join(ROOT, "locales.json");

/** What a contributor writes in locales.json. Status and coverage are computed. */
interface LocaleEntry {
  code: string;
  name: string;
  nativeName: string;
  dir: "ltr" | "rtl";
  /**
   * Optional, and usually omitted: `flagFor` derives a flag from the code. Write
   * it only to overrule that — `"flag": "us"` for American English, or
   * `"flag": null` for a language that should show none.
   *
   * Present-but-null and absent are different things here, which is why this is
   * read with `in` rather than by truthiness below.
   */
  flag?: string | null;
}

const checkOnly = process.argv.includes("--check");
const problems: string[] = [];

/**
 * A locale code is a BCP-47 tag, and the casing is part of the standard rather
 * than a style preference: language lowercase, script Title-case, region
 * UPPERCASE — `pt-BR`, `zh-Hant`, `sr-Latn`.
 *
 * This is checked rather than merely documented because getting it wrong is
 * silent. `pt_BR` and `PT-br` look fine in a folder listing, are never matched by
 * `Accept-Language` negotiation, and the language simply never appears for anyone
 * — with no error, anywhere, to explain why. Worse on a Mac, whose filesystem is
 * case-insensitive: a folder named `pt-br` resolves locally and vanishes on Linux
 * CI.
 *
 * The shape only. Whether `jp` is really the code for Japanese (it is not — `ja`
 * is) is a question no regex can answer; that is what the registry linked in
 * README.md is for.
 */
const BCP47 = /^[a-z]{2,3}(-[A-Z][a-z]{3})?(-([A-Z]{2}|\d{3}))?$/;

// --- read what is on disk -----------------------------------------------------

const registry = JSON.parse(readFileSync(REGISTRY, "utf8")) as LocaleEntry[];

const directories = readdirSync(LOCALES_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

// --- validate -----------------------------------------------------------------
//
// A language that exists in one place and not the other is the failure mode this
// script is meant to make impossible: a folder full of translated JSON that never
// reaches a user, or a switcher entry that resolves to nothing.

if (!directories.includes(BASE)) {
  problems.push(`src/locales/${BASE}/ does not exist — the base locale is not optional.`);
}

const registered = new Set<string>();
for (const entry of registry) {
  if (registered.has(entry.code)) problems.push(`locales.json lists "${entry.code}" twice.`);
  registered.add(entry.code);

  if (!BCP47.test(entry.code)) {
    problems.push(
      `"${entry.code}" is not a well-formed BCP-47 tag. Expected language-Script-REGION ` +
        `with that exact casing, e.g. "ja", "pt-BR", "zh-Hant". ` +
        `Look the code up: https://r12a.github.io/app-subtags/`,
    );
  }

  // A folder that differs only in case is reported once, precisely, by the loop
  // below. Saying "pt-BR does not exist" while pt-br sits right there is true,
  // unhelpful, and reads like the script is confused.
  const caseMismatch = directories.some(
    (d) => d !== entry.code && d.toLowerCase() === entry.code.toLowerCase(),
  );

  if (!directories.includes(entry.code) && !caseMismatch) {
    problems.push(
      `locales.json lists "${entry.code}", but src/locales/${entry.code}/ does not exist.`,
    );
  }
  if (entry.dir !== "ltr" && entry.dir !== "rtl") {
    problems.push(`"${entry.code}" has dir "${entry.dir}" — it must be "ltr" or "rtl".`);
  }
  if (!entry.nativeName) {
    problems.push(`"${entry.code}" has no nativeName — that is the only name a user sees.`);
  }

  // A flag code that flag-icons does not ship renders as a broken image, and only
  // for the people who read that language — which is to say, not for whoever
  // wrote the typo. `"vm"` for Vietnam (it is `vn`) fails here instead.
  //
  // Both the override and the derived code are checked. The derived one cannot
  // normally be wrong, but DEFAULT_REGION is a hand-written table, and this is
  // the only thing standing between a slip in it and a hole in the switcher.
  const flag = flagFor(entry.code, "flag" in entry ? entry.flag : undefined);

  // Caught before the existence check below, because this one *passes* it: `vi`
  // is a real flag (the US Virgin Islands), just not Vietnam's.
  if (entry.flag && looksLikeLanguageCode(entry.code, entry.flag)) {
    problems.push(
      `"${entry.code}": "flag": ${JSON.stringify(entry.flag)} is the *language* code, ` +
        `not a country code — and it is a real flag belonging to somewhere else, so ` +
        `nothing else here would have caught it. Did you mean ` +
        `${JSON.stringify(flagFor(entry.code))}? ` +
        `Omit the field entirely and the right flag is derived for you.`,
    );
  } else if (flag && !hasFlag(flag)) {
    const source =
      "flag" in entry
        ? `locales.json sets "flag": ${JSON.stringify(entry.flag)}`
        : `flagFor("${entry.code}") derived "${flag}"`;
    problems.push(
      `"${entry.code}": ${source}, but flag-icons ships no ${flag}.svg. ` +
        `Flags are ISO 3166-1 alpha-2 country codes, lowercase — the country, ` +
        `not the language. Check against ${FLAGS_SRC}.`,
    );
  }
}

for (const code of directories) {
  if (registered.has(code)) continue;

  // The folder name IS the locale code, byte for byte. A folder that matches a
  // registered code only case-insensitively is the macOS trap: it resolves on the
  // contributor's laptop and does not exist on Linux CI.
  const nearMiss = [...registered].find(
    (c) => c.toLowerCase() === code.toLowerCase(),
  );
  if (nearMiss) {
    problems.push(
      `src/locales/${code}/ and locales.json's "${nearMiss}" differ only in case. ` +
        `Rename the folder to "${nearMiss}" — on a case-sensitive filesystem these ` +
        `are two different directories, and one of them is empty.`,
    );
    continue;
  }

  problems.push(
    `src/locales/${code}/ exists, but locales.json does not list it — ` +
      `it would be translated and never offered. Add an entry.`,
  );
}

if (!registered.has(BASE)) {
  problems.push(`locales.json must list the base locale "${BASE}".`);
}

if (problems.length > 0) {
  console.error("The locale registry and the locale folders disagree:\n");
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}

// --- generate -----------------------------------------------------------------

/** Namespaces are whatever the base locale defines. Nothing else is a namespace. */
const namespaces = readdirSync(join(LOCALES_DIR, BASE))
  .filter((file) => file.endsWith(".json"))
  .map((file) => file.replace(/\.json$/, ""))
  .sort();

/**
 * Whether a language is offered, and how close it is.
 *
 * Note what this makes true: the generated `locales.ts` now depends on the
 * *contents* of the JSON, not only on which files exist. So a translation PR
 * changes it, and `check` will say so. That is the intended behaviour — a PR that
 * carries a language over the line should be the PR that turns it on.
 */
function readiness(code: string): { status: string; coverage: number } {
  const { status, required } = coverageOf(code);
  return { status, coverage: Math.round(required.percent) };
}

/** "pt-BR" + "admin" -> "ptBRAdmin". Import names have to be identifiers. */
function importName(locale: string, namespace: string): string {
  const localePart = locale.replace(/[^a-zA-Z0-9]+(.)?/g, (_, next: string | undefined) =>
    next ? next.toUpperCase() : "",
  );
  return `${localePart}${namespace[0]!.toUpperCase()}${namespace.slice(1)}`;
}

const BANNER = `// GENERATED by scripts/generate-catalog.ts — do not edit by hand.
// Add a language: create src/locales/<code>/, add one entry to locales.json, then
// run \`pnpm --filter @zcmsorg/i18n sync\`.
`;

function generateLocales(): string {
  const entries = registry
    .map((l) => {
      const { status, coverage } = readiness(l.code);
      const flag = flagFor(l.code, "flag" in l ? l.flag : undefined);
      return (
        `  { code: ${JSON.stringify(l.code)}, name: ${JSON.stringify(l.name)}, ` +
        `nativeName: ${JSON.stringify(l.nativeName)}, dir: ${JSON.stringify(l.dir)}, ` +
        `status: ${JSON.stringify(status)}, coverage: ${coverage}, ` +
        `flag: ${JSON.stringify(flag)} },`
      );
    })
    .join("\n");

  return `${BANNER}
import type { LocaleInfo } from "./types";

/**
 * Namespaces exist so that a translator can pick up one file, finish it, and open
 * a pull request — instead of facing a single thousand-line blob. They also keep
 * contributions from colliding: two people translating different areas of the
 * admin touch different files.
 */
export const NAMESPACES = [
${namespaces.map((ns) => `  ${JSON.stringify(ns)},`).join("\n")}
] as const;

export type Namespace = (typeof NAMESPACES)[number];

/**
 * The namespaces a language must cover before Z-CMS offers it to a user: the
 * chrome you cannot avoid seeing, plus the thing a CMS is for. \`coverage\` below
 * is the percentage of *these*, not of the whole catalogue — a language can be
 * ready to ship with \`plugins\` entirely untranslated, and cannot be ready with
 * \`auth\` untranslated no matter how much else it has done.
 */
export const REQUIRED_NAMESPACES: readonly string[] = ${JSON.stringify(REQUIRED_NAMESPACES)};

/** A locale at or above this much of REQUIRED_NAMESPACES is offered. */
export const STABLE_THRESHOLD = ${STABLE_THRESHOLD};

/**
 * Every locale in the build, in the order locales.json lists them.
 *
 * Includes experimental ones: a user whose cookie names an experimental locale
 * still gets it, and \`<html dir>\` still needs to resolve for them.
 */
export const LOCALES: LocaleInfo[] = [
${entries}
];

/**
 * What the language switcher offers — the stable ones.
 *
 * A half-translated language is merged and works. It is not *advertised*, because
 * a user who picks their own language from a menu and lands on a mostly-English
 * screen files a bug against the feature, not against the translation.
 */
export const SWITCHER_LOCALES: LocaleInfo[] = LOCALES.filter(
  (l) => l.status === "stable",
);

/** Every locale that resolves, experimental included. */
export const SUPPORTED_LOCALES: readonly string[] = LOCALES.map((l) => l.code);

export function isSupportedLocale(code: string): boolean {
  return SUPPORTED_LOCALES.includes(code);
}
`;
}

function generateCatalog(): string {
  const imports: string[] = [];
  const bodies: string[] = [];

  for (const locale of registry.map((l) => l.code)) {
    const present = namespaces.filter((ns) =>
      existsSync(join(LOCALES_DIR, locale, `${ns}.json`)),
    );

    for (const ns of present) {
      imports.push(
        `import ${importName(locale, ns)} from "./locales/${locale}/${ns}.json";`,
      );
    }

    const fields = present.map((ns) => `    ${ns}: ${importName(locale, ns)},`).join("\n");
    bodies.push(`  ${JSON.stringify(locale)}: {\n${fields}\n  },`);
  }

  return `${BANNER}
import type { Messages } from "./types";

${imports.join("\n")}

/**
 * Every message, every locale. Server-side only — see the note in
 * scripts/generate-catalog.ts about why this must not reach a browser bundle.
 *
 * A locale that translates only some namespaces lists only those. The missing
 * ones are not stubbed out with empty files: the translator falls back to the
 * base locale key by key, so a half-finished language is a *usable* language.
 */
export const catalog: Record<string, Messages> = {
${bodies.join("\n")}
};
`;
}

const outputs: Array<[string, string]> = [
  [join(ROOT, "src", "locales.ts"), generateLocales()],
  [join(ROOT, "src", "catalog.ts"), generateCatalog()],
];

if (checkOnly) {
  const stale = outputs.filter(
    ([path, content]) => !existsSync(path) || readFileSync(path, "utf8") !== content,
  );

  if (stale.length > 0) {
    console.error("The generated catalogue is out of date:\n");
    for (const [path] of stale) console.error(`  ${path.replace(`${ROOT}/`, "")}`);
    console.error("\nRun `pnpm --filter @zcmsorg/i18n sync` and commit the result.");
    process.exit(1);
  }

  console.log(`Catalogue is in sync (${registry.length} locales, ${namespaces.length} namespaces).`);
} else {
  for (const [path, content] of outputs) writeFileSync(path, content);
  console.log(
    `Generated src/locales.ts and src/catalog.ts ` +
      `(${registry.length} locales, ${namespaces.length} namespaces).`,
  );
}
