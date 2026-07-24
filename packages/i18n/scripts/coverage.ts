/**
 * When is a language ready to be *offered* to a user?
 *
 * Merging and offering are two different gates, and conflating them is how a
 * project ends up refusing good translations. A language at 20% is still worth
 * merging — the fallback makes it harmless, and the contributor gets to stop and
 * come back. But putting it in the switcher is a promise, and a user who picks
 * their own language and lands on a mostly-English screen concludes the feature
 * is broken, not that the translation is young.
 *
 * So: merge anything. Offer what covers the strings you cannot avoid seeing.
 *
 * ## Why not "50% of all keys"
 *
 * Because the keys are not evenly distributed, and a flat percentage gates in
 * exactly the wrong direction:
 *
 *   content   154 keys   32.5%
 *   plugins   128 keys   27.0%   <- these two alone are 59.5% of the catalogue
 *   errors     56        11.8%
 *   admin      43         9.1%
 *   common     28         5.9%
 *   auth       22         4.6%
 *   media      22         4.6%
 *   appearance 19         4.0%
 *   site        2         0.4%
 *
 * Translate `content` and `plugins` and nothing else: 59.5%, which passes a 50%
 * gate — with the login screen, the navigation and every button still in English.
 * Translate the entire visible chrome and skip those two: 40.5%, which fails —
 * having translated everything a user actually looks at.
 *
 * ## The gate
 *
 * A named set of namespaces, not a count: the admin's chrome (`common`, `auth`,
 * `admin`) plus the thing a CMS is *for* (`content`). That is 247 of 474 keys —
 * about 52%, which is roughly where a flat threshold would have landed, except
 * that it cannot be satisfied by translating the wrong half.
 *
 * ## Why 95% and not 100%
 *
 * Because 100% would let an unrelated pull request delete a language. Add five
 * English keys to `content`, and every locale on earth drops below 100% and
 * vanishes from the switcher in the next deploy — punishing translators for a
 * change they did not make, in a build nobody thought was about i18n.
 *
 * 95% of 247 keys is 12 keys of slack: enough to absorb the base locale growing,
 * not enough to skip a namespace (dropping `auth` entirely costs 22 keys, and
 * lands at 91%).
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const LOCALES_DIR = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "..",
  "src",
  "locales",
);

export const BASE = "en";

/** The strings a user cannot avoid, plus the work a CMS exists to do. */
export const REQUIRED_NAMESPACES = ["common", "auth", "admin", "content"];

/** Of the required set. See the note above on why this is not 1. */
export const STABLE_THRESHOLD = 0.95;

export type LocaleStatus = "stable" | "experimental";

type Json = Record<string, unknown>;

export function namespacesOf(locale: string): string[] {
  return readdirSync(join(LOCALES_DIR, locale))
    .filter((file) => file.endsWith(".json"))
    .map((file) => file.replace(/\.json$/, ""))
    .sort();
}

export function readNamespace(locale: string, namespace: string): Json {
  const path = join(LOCALES_DIR, locale, `${namespace}.json`);
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8")) as Json;
}

/** { a: { b: "x" } } -> { "a.b": "x" } */
export function flatten(obj: Json, prefix = ""): Map<string, unknown> {
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

export interface Coverage {
  /** Of the whole catalogue. Reported, never gated on. */
  overall: { translated: number; total: number; percent: number };
  /** Of REQUIRED_NAMESPACES. This is what the gate reads. */
  required: { translated: number; total: number; percent: number };
  status: LocaleStatus;
}

function count(locale: string, namespaces: string[]) {
  let translated = 0;
  let total = 0;

  for (const ns of namespaces) {
    const base = flatten(readNamespace(BASE, ns));
    const target = flatten(readNamespace(locale, ns));

    for (const [key, baseValue] of base) {
      if (typeof baseValue !== "string") continue;
      total++;
      if (typeof target.get(key) === "string") translated++;
    }
  }

  return { translated, total, percent: total === 0 ? 100 : (100 * translated) / total };
}

export function coverageOf(locale: string): Coverage {
  if (locale === BASE) {
    const all = count(BASE, namespacesOf(BASE));
    return { overall: all, required: all, status: "stable" };
  }

  const overall = count(locale, namespacesOf(BASE));
  const required = count(
    locale,
    namespacesOf(BASE).filter((ns) => REQUIRED_NAMESPACES.includes(ns)),
  );

  return {
    overall,
    required,
    status: required.percent >= STABLE_THRESHOLD * 100 ? "stable" : "experimental",
  };
}
