import fs from "node:fs";
import path from "node:path";
import {
  MAX_AUTHOR_LENGTH,
  MAX_DESCRIPTION_LENGTH,
  MAX_NAME_LENGTH,
  validateId,
  validateText,
  validateVersion,
  type PackageKind,
} from "@zcmsorg/package";
import { templateFor, type Files, type TemplateVars } from "./templates";

// Re-exported because main.ts and the tests have always imported them from here,
// and because where the rules LIVE is now the point: they are in @zcmsorg/package,
// which the marketplace also runs. A rule the CLI alone enforces is a rule that
// runs only on the machine of the one person who might want to break it.
export { validateId, validateVersion };

/**
 * `zcms init` — the scaffold.
 *
 * The point is not to save an author from typing. It is that two of this
 * platform's contracts (a plugin is one CommonJS file; a theme entry is ESM and
 * shares the host's React) are enforced at *runtime, on someone's live site*, and
 * an author who guesses wrong finds out from a support ticket. Scaffolding a
 * package that already satisfies them turns those contracts from folklore into a
 * default.
 *
 * Everything here is pure except `writeScaffold`, so the templates and their
 * validation can be tested without touching a disk.
 */

export interface InitOptions {
  kind: PackageKind;
  id: string;
  name: string;
  description: string;
  version: string;
  authorName: string;
  authorUrl: string;
}

/**
 * Returns an error message, or null if the name is usable.
 *
 * The name is not an identifier and is not constrained to ASCII: "Bộ lọc bình
 * luận" is a good name for a plugin, and a tool that refuses it is refusing the
 * language its author speaks. What is refused is text that is not text — a
 * newline, a zero-width character, a bidi override — and text too long for the
 * card it will be rendered in. That rule lives in @zcmsorg/package, because the
 * marketplace has to apply exactly the same one to a manifest that never came
 * near this CLI.
 */
export function validateName(name: string): string | null {
  return validateText("name", name, MAX_NAME_LENGTH, true);
}

/** The last segment of the id: "com.acme.plugin.hello" -> "hello". */
export function slugOf(id: string): string {
  const segments = id.split(".");
  return segments[segments.length - 1] ?? id;
}

/**
 * The npm name for the author's OWN repository — not something we publish.
 *
 * It is prefixed by kind because a plugin and a theme with the same slug are a
 * normal thing for one author to have, and two directories called `hello` are not.
 */
export function packageNameFor(kind: PackageKind, id: string): string {
  return `zcms-${kind}-${slugOf(id)}`;
}

/** A sensible id to offer when the author has not supplied one. */
export function suggestId(kind: PackageKind, name: string): string {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || kind;

  return `com.example.${kind}.${slug}`;
}

/** A human name to offer for an id the author typed first. */
export function suggestName(id: string): string {
  const slug = slugOf(id);
  return slug
    .split("-")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export function toTemplateVars(options: InitOptions): TemplateVars {
  return {
    kind: options.kind,
    id: options.id,
    name: options.name,
    packageName: packageNameFor(options.kind, options.id),
    description: options.description,
    version: options.version,
    authorName: options.authorName,
    authorUrl: options.authorUrl,
  };
}

/** The files a new package starts life with. Pure — writes nothing. */
export function scaffold(options: InitOptions): Files {
  const idError = validateId(options.id);
  if (idError) throw new Error(idError);

  const versionError = validateVersion(options.version);
  if (versionError) throw new Error(versionError);

  // Was `if (!options.name.trim())` — the only check a name ever got, anywhere in
  // the platform. Length and printability are checked now, with the same rule the
  // marketplace applies on upload, so an author cannot pass `zcms init` and then
  // be rejected by `POST /packages` for the same field.
  const nameError = validateName(options.name);
  if (nameError) throw new Error(nameError);

  const authorError = validateText("author", options.authorName, MAX_AUTHOR_LENGTH, true);
  if (authorError) throw new Error(authorError);

  const descriptionError = validateText(
    "description",
    options.description,
    MAX_DESCRIPTION_LENGTH,
    false,
  );
  if (descriptionError) throw new Error(descriptionError);

  return templateFor(toTemplateVars(options));
}

/**
 * True when `dir` has nothing in it we would be destroying.
 *
 * A missing directory is empty. So is one holding only the debris a fresh `git
 * init` or a Finder visit leaves behind — refusing those would be pedantry, and
 * an author who ran `mkdir my-theme && cd my-theme && git init` should not be
 * told to start over.
 */
const IGNORABLE = new Set([".git", ".DS_Store", ".gitkeep", "Thumbs.db"]);

export function isEmptyEnough(dir: string): boolean {
  if (!fs.existsSync(dir)) return true;
  if (!fs.statSync(dir).isDirectory()) return false;

  return fs.readdirSync(dir).every((entry) => IGNORABLE.has(entry));
}

/**
 * Writes the scaffold, and REFUSES to write into a directory that holds anything.
 *
 * The alternative — overwrite, or merge — is how a scaffold eats the work of
 * someone who ran it in the wrong terminal. There is no `--force`: `rm -rf` is
 * already spelled `rm -rf`, and it is the author's to type.
 */
export function writeScaffold(dir: string, files: Files): string[] {
  if (!isEmptyEnough(dir)) {
    throw new Error(
      `"${dir}" is not empty. Point init at a new directory, or empty this one — ` +
        `init will not overwrite files it did not write.`,
    );
  }

  const written: string[] = [];

  for (const [relative, contents] of Object.entries(files)) {
    const full = path.join(dir, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, contents);
    written.push(relative);
  }

  return written.sort();
}
