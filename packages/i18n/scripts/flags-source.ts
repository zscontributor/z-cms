/**
 * Where the flag SVGs come from, for the two scripts that need them.
 *
 * `flag-icons` (MIT, lipis/flag-icons) is a build-time dependency and nothing
 * more: no stylesheet is imported, no module is bundled, no code of theirs runs.
 * We copy the SVGs we serve out of it — see sync-flags.ts — so the only thing
 * that ships is the images themselves.
 *
 * Resolving the package rather than hardcoding `node_modules/flag-icons` is the
 * point of doing it here: pnpm's store means that path does not exist where a
 * naive join would look for it.
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

/**
 * 4x3 rather than 1x1: a flag's real proportions are the ones people recognise,
 * and a squared Nepal is not a flag of anything. The aspect ratio is fixed in CSS
 * at each call site anyway — what matters is that the *source* is not cropped.
 */
export const FLAGS_SRC = join(
  dirname(require.resolve("flag-icons/package.json")),
  "flags",
  "4x3",
);

/** Does flag-icons actually ship this code? The check a typo needs to fail. */
export function hasFlag(code: string): boolean {
  return existsSync(join(FLAGS_SRC, `${code}.svg`));
}
