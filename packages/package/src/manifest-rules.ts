import { validateVersion } from "./semver";
import { PackageError } from "./types";

/**
 * What a manifest may SAY, as opposed to what the package may contain
 * (payload-rules.ts) or what its code may do (the scanner's source rules).
 *
 * Every field here is a string an author typed, and every one of them ends up
 * somewhere that is not a string field in a form:
 *
 *   id     — a primary key, a directory name in every runtime's package cache,
 *            and a URL path segment on the marketplace.
 *   name   — a heading in the admin, a card in the catalogue, a row in a table.
 *   author,
 *   description — the same, in smaller type.
 *
 * None of them were checked before this file existed. `accept()` read the
 * manifest a stranger wrote, took `String(manifest.name)`, and wrote it into a
 * Postgres `TEXT` column with no length limit at all — so a "name" could be a
 * megabyte long, could be forty newlines, could be a right-to-left override that
 * reverses the rest of the row it is rendered in. None of that is exotic; it is
 * what you get when the only validation is "is it truthy".
 *
 * Two rules, and the split matters:
 *
 *   - `id` is an IDENTIFIER. It is constrained to a shape, because it becomes a
 *     path and a key, and a value that has to be sanitised on the way in is a
 *     value that will not be what the author thinks it is on the way out.
 *   - `name`, `author` and `description` are HUMAN TEXT. They are bounded in
 *     length and stripped of characters that break rendering, but they are NOT
 *     restricted to ASCII. "Bộ lọc bình luận" is a perfectly good name for a
 *     plugin, and a marketplace that refuses it is a marketplace that refuses
 *     the language its authors speak. The thing that breaks a page is a control
 *     character or a bidi override, not a Vietnamese one.
 */

/**
 * Reverse-DNS, lowercase: `com.acme.plugin.hello`.
 *
 * The canonical copy. The CLI used to own this pattern and the server had none,
 * which meant the only check on an id ran on the author's own machine — i.e. on
 * the one machine an attacker controls.
 */
export const ID_PATTERN = /^[a-z][a-z0-9]*(\.[a-z0-9][a-z0-9-]*)+$/;

/** Three segments, starting from a domain: enough to be unique to someone. */
export const MIN_ID_SEGMENTS = 3;

/**
 * 128 for an id.
 *
 * It is a directory name, and the shortest common filesystem limit for one is 255
 * bytes. Half of that leaves room for the version suffix and separators the cache
 * puts around it, and it is still four times longer than any honest reverse-DNS id.
 */
export const MAX_ID_LENGTH = 128;

/**
 * 60 for a name.
 *
 * This is a display limit, not a storage one — it is set by the narrowest place
 * the name is rendered, which is a card in the marketplace grid. A name that does
 * not fit there does not get truncated tastefully; it wraps, and it pushes the
 * card out of line with every other card on the row. 60 is long enough for
 * "Advanced Comment Moderation & Spam Filter" with room to spare.
 */
export const MAX_NAME_LENGTH = 60;

/** An author is a person or a company, not a paragraph. */
export const MAX_AUTHOR_LENGTH = 80;

/** One or two sentences — it is the subtitle on a card, not the README. */
export const MAX_DESCRIPTION_LENGTH = 280;

/**
 * Release notes for a single version — a short list of what changed, not a manual.
 * Generous enough for a real changelog entry, bounded so it stays a summary an admin
 * reads in the update dialog rather than a document. Applies per locale.
 */
export const MAX_CHANGELOG_LENGTH = 2000;

/**
 * The base locale a localized changelog must always carry, and the one every other
 * locale falls back to when it is missing. The same base the theme message
 * catalogue uses, so an author never has to think about two different defaults.
 */
export const CHANGELOG_BASE_LOCALE = "en";

/**
 * A ceiling on how many locales one version's changelog may carry. The whole
 * manifest rides in a JSONB column; a bound keeps a single field from growing
 * without limit, and no real release is translated into twenty languages by hand.
 */
export const MAX_CHANGELOG_LOCALES = 20;

/**
 * Locale codes as an author writes them: `en`, `vi`, `ja`, and regional forms
 * like `pt-BR` or `zh-Hans`. Deliberately loose on the subtags — the point is to
 * reject a key that is plainly not a locale (a sentence, a version number), not
 * to police the BCP-47 registry.
 */
export const LOCALE_KEY_PATTERN = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

/**
 * Characters that are not text, whatever they claim to be.
 *
 * Three groups, and none of them can appear in a name a human meant to type:
 *
 *   - C0/C1 controls, including newline and tab. A "name" containing a newline
 *     breaks every log line, every table row, and every CSV export it lands in.
 *   - Zero-width SPACE (U+200B), the word joiner, and the BOM. They are invisible,
 *     which makes two different names look identical, and that is the entire point
 *     of putting one in a name.
 *   - Bidi embeddings, overrides and isolates. U+202E flips the direction of
 *     everything after it, so a name renders as the reverse of what it is — and so
 *     does the row it sits in. This is the "Trojan Source" trick.
 *
 * And note what is NOT refused, because getting this wrong is how the rule ends
 * up reverted: U+200C and U+200D — the zero-width non-joiner and joiner — are
 * ALLOWED. They are invisible too, but they are not decoration: Persian, Hindi and
 * Arabic need them to spell ordinary words, and every multi-person emoji is built
 * out of U+200D. Blocking them would refuse "👨‍👩‍👧 Family Blocks" and a great deal
 * of the world's writing to prevent a homograph in a field that is not an
 * identifier. The identifier is `id`, and `id` is [a-z0-9.-] — which is precisely
 * why `name` can afford to be generous.
 */
// eslint-disable-next-line no-control-regex
const UNSAFE_TEXT =
  /[\u0000-\u001F\u007F-\u009F\u200B\u2028\u2029\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/;

/** Names the character so the error is actionable rather than mystifying. */
function describeUnsafe(value: string): string {
  const match = UNSAFE_TEXT.exec(value);
  if (!match) return "an unprintable character";

  const code = match[0].codePointAt(0)!;
  const hex = `U+${code.toString(16).toUpperCase().padStart(4, "0")}`;

  if (code === 0x0a || code === 0x0d) return `a line break (${hex})`;
  if (code === 0x09) return `a tab (${hex})`;
  if (code >= 0x202a && code <= 0x202e) return `a bidirectional override (${hex})`;
  if (code >= 0x2066 && code <= 0x2069) return `a bidirectional isolate (${hex})`;
  if (code === 0x200b || code === 0xfeff || (code >= 0x2060 && code <= 0x2064)) {
    return `an invisible zero-width character (${hex})`;
  }
  return `a control character (${hex})`;
}

/**
 * Checks one human-text field. Returns an error message, or null.
 *
 * Length is measured in code points, not UTF-16 units. `"👨‍👩‍👧".length` is 8 in
 * JavaScript, and telling an author their four-character name is too long is a
 * good way to make them think the tool is broken.
 */
export function validateText(
  field: string,
  value: unknown,
  max: number,
  required: boolean,
  multiline = false,
): string | null {
  if (value === undefined || value === null || value === "") {
    return required ? `${field} is required.` : null;
  }

  if (typeof value !== "string") {
    return `${field} must be a string, not ${Array.isArray(value) ? "an array" : typeof value}.`;
  }

  const trimmed = value.trim();
  if (required && !trimmed) return `${field} is required.`;

  // A multi-line field (a changelog) is meant to have line breaks and tabs, so the
  // whitespace controls a human types on purpose are removed before the scan; every
  // other control, bidi override and zero-width trick is still refused, exactly as
  // for a single-line field.
  const scanned = multiline ? trimmed.replace(/[\t\n\r]/g, "") : trimmed;
  if (UNSAFE_TEXT.test(scanned)) {
    return (
      `${field} contains ${describeUnsafe(scanned)}. It is rendered in the admin and in the ` +
      `catalogue, and a character that cannot be seen is a character that is there to be abused.`
    );
  }

  const length = [...trimmed].length;
  if (length > max) {
    return `${field} is ${length} characters — the limit is ${max}.`;
  }

  return null;
}

/**
 * Checks a version's changelog, in either of the two forms an author may write it.
 *
 * A changelog is OPTIONAL — a package may ship none. But an author who writes one
 * writes it one of two ways, and both are accepted:
 *
 *   - a plain string, which is the English notes ("Fixed the header on mobile.");
 *   - an object keyed by locale, `{ "en": "…", "vi": "…" }`, when the notes are
 *     translated.
 *
 * The object form has one hard rule: it must carry non-empty `en`. English is the
 * base every other locale falls back to (`resolveChangelog`), so a localized
 * changelog that omits it has nothing to show a reader whose language it does not
 * include — which is most readers. Every locale's notes are held to the same text
 * rules as a plain-string changelog: bounded length, line breaks allowed, bidi and
 * zero-width tricks refused.
 *
 * Returns every problem at once, like `validateManifestIdentity`.
 */
export function validateChangelog(value: unknown): string[] {
  // Absent entirely is fine — not every release needs release notes.
  if (value === undefined || value === null) return [];

  // The simplest and legacy form: a plain string is the English notes.
  if (typeof value === "string") {
    const error = validateText("changelog", value, MAX_CHANGELOG_LENGTH, false, true);
    return error ? [error] : [];
  }

  if (typeof value !== "object" || Array.isArray(value)) {
    return [
      "changelog must be either release notes as a string, or an object keyed by " +
        'locale, e.g. { "en": "…", "vi": "…" }.',
    ];
  }

  const errors: string[] = [];
  const entries = Object.entries(value as Record<string, unknown>);

  if (entries.length > MAX_CHANGELOG_LOCALES) {
    errors.push(
      `changelog has ${entries.length} locales — the limit is ${MAX_CHANGELOG_LOCALES}.`,
    );
  }

  // English is required whenever a localized changelog is given: it is the default
  // every reader sees when their own locale is not among the translations.
  if (!(CHANGELOG_BASE_LOCALE in (value as Record<string, unknown>))) {
    errors.push(
      `changelog must include "${CHANGELOG_BASE_LOCALE}" notes — English is the ` +
        "default every other locale falls back to.",
    );
  }

  for (const [locale, notes] of entries) {
    if (!LOCALE_KEY_PATTERN.test(locale)) {
      errors.push(
        `changelog has "${locale}" as a locale, which is not a valid locale code ` +
          '(expected e.g. "en", "vi", "pt-BR").',
      );
      continue;
    }
    // required = true: a locale the author bothered to list must have real notes.
    const error = validateText(`changelog.${locale}`, notes, MAX_CHANGELOG_LENGTH, true, true);
    if (error) errors.push(error);
  }

  return errors;
}

/**
 * The changelog as the rest of the platform consumes it: a locale → notes map, or
 * null when there are none. A plain-string changelog (the legacy and simplest
 * form) is read as the English notes. Blank entries are dropped and a map that
 * ends up empty becomes null, so every caller has one shape and one "no notes"
 * case to handle.
 */
export function normalizeChangelog(raw: unknown): Record<string, string> | null {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    return trimmed ? { [CHANGELOG_BASE_LOCALE]: trimmed } : null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;

  const map: Record<string, string> = {};
  for (const [locale, notes] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof notes === "string" && notes.trim()) map[locale] = notes.trim();
  }
  return Object.keys(map).length ? map : null;
}

/** "vi-VN" -> "vi": a changelog with region-less notes still serves a regional reader. */
function baseLocale(locale: string): string {
  return locale.split("-")[0] ?? locale;
}

/**
 * The notes to show a reader in `locale`: their exact locale, then its region-less
 * base ("vi-VN" → "vi"), then English, then whatever the changelog does carry.
 * Returns null only when there is nothing to show. The mirror of the theme
 * translator's locale → base → fallback order, so the changelog resolves the same
 * way the rest of a theme's strings do.
 */
export function resolveChangelog(
  changelog: Record<string, string> | null | undefined,
  locale: string,
): string | null {
  if (!changelog) return null;
  return (
    changelog[locale] ??
    changelog[baseLocale(locale)] ??
    changelog[CHANGELOG_BASE_LOCALE] ??
    Object.values(changelog)[0] ??
    null
  );
}

/** Returns an error message, or null if the id is usable. */
export function validateId(id: unknown): string | null {
  if (typeof id !== "string" || !id) return "id is required.";

  if (id.length > MAX_ID_LENGTH) {
    return `id is ${id.length} characters — the limit is ${MAX_ID_LENGTH}.`;
  }

  if (!ID_PATTERN.test(id)) {
    return (
      `"${id}" is not a valid package id. Ids are reverse-DNS and lowercase — ` +
      `for example "com.acme.plugin.hello" or "com.acme.theme.aurora".`
    );
  }

  if (id.split(".").length < MIN_ID_SEGMENTS) {
    return (
      `"${id}" is too short to be unique. Use at least ${MIN_ID_SEGMENTS} segments, starting ` +
      `with a domain you control — for example "com.acme.plugin.hello".`
    );
  }

  return null;
}

/**
 * Every problem with a manifest's identity fields, in one pass.
 *
 * Returns a list rather than throwing on the first, for the same reason the
 * payload rules do: an author fixing a manifest should learn everything wrong
 * with it in one go, not one field per attempt.
 */
export function validateManifestIdentity(raw: Record<string, unknown>): string[] {
  const errors: string[] = [];

  const push = (error: string | null) => {
    if (error) errors.push(error);
  };

  push(validateId(raw.id));
  push(validateText("name", raw.name, MAX_NAME_LENGTH, true));
  push(validateText("description", raw.description, MAX_DESCRIPTION_LENGTH, false));
  // Optional, multi-line, and localizable: a plain string (English) or an object
  // keyed by locale. When localized, English is required as the fallback.
  for (const error of validateChangelog(raw.changelog)) push(error);

  // Format only. Whether a version is ALLOWED to follow the ones already published
  // — that it is greater than the current highest — is a question about the state
  // of the marketplace, not about the manifest in isolation, so it lives there
  // (`assertVersionAcceptable`) and not here. This is the check that a version is
  // a version at all, which is exactly what a pure manifest rule can answer.
  push(validateVersion(raw.version));

  // `author` is an object — { name, url? } — not a string. The thing rendered
  // beneath a package's title in the catalogue is `author.name`, so that is the
  // string with a limit on it. A malformed `author` is left to the type to
  // complain about; this function's job is the fields a human reads.
  const author = raw.author;
  if (author && typeof author === "object" && !Array.isArray(author)) {
    push(
      validateText(
        "author.name",
        (author as { name?: unknown }).name,
        MAX_AUTHOR_LENGTH,
        true,
      ),
    );
  } else if (author !== undefined) {
    errors.push("author must be an object with a name, e.g. { \"name\": \"Acme\" }.");
  }

  return errors;
}

/** The pack-time gate. The marketplace does the same check with `validateManifestIdentity`. */
export function assertManifestIdentity(
  raw: Record<string, unknown>,
  manifestFile: string,
): void {
  const errors = validateManifestIdentity(raw);
  if (errors.length === 0) return;

  throw new PackageError(
    errors.length === 1
      ? `${manifestFile}: ${errors[0]}`
      : `${manifestFile} has ${errors.length} problems:\n\n` +
          errors.map((e) => `— ${e}`).join("\n"),
  );
}
