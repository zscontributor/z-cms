/**
 * Copies the flag SVGs into every app that serves them.
 *
 *   pnpm --filter @zcmsorg/i18n flags:sync
 *
 * Runs as part of this package's build, so an app is never built against a
 * `public/z-flags/` that does not exist yet.
 *
 * The whole set is copied, not just the locales Z-CMS ships. That looks wasteful
 * and is not: a *site's* languages are rows in a database, chosen by whoever runs
 * the site, and the admin's translations panel and the public switcher both
 * render flags for them. Which flags those are is not knowable at build time —
 * only at the moment someone types a locale into a site's settings. So all 270
 * are on disk and any of them resolves.
 *
 * The cost of that is 2.7MB of files a web server never reads unless asked. The
 * cost of the alternative — flag-icons' stylesheet, or an import — is every one
 * of those flags in the bundle of every reader, to render the two in a switcher.
 * Static files are simply the right shape for this: the browser fetches what it
 * paints, caches it forever, and the rest costs disk.
 *
 * The output is generated, and therefore gitignored. Do not commit it.
 */
import { cpSync, mkdirSync, rmSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { FLAGS_SRC } from "./flags-source.js";

const REPO = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");

/**
 * `FLAG_BASE` in src/flags.ts is the URL. This is where that URL is served from.
 * The two have to agree, and the prefix is deliberately odd: `z-flags` cannot
 * collide with a page slug the way `flags` could on a site about vexillology.
 */
const DESTINATIONS = [
  join(REPO, "apps", "admin-web", "public", "z-flags"),
  join(REPO, "apps", "site-runtime", "public", "z-flags"),
];

/**
 * flag-icons is MIT, and MIT requires the notice to travel with the copies.
 * Dropping the licence in beside the SVGs is the cheapest way to make that true
 * of a directory that is otherwise assembled by a script and gitignored.
 */
const NOTICE = `Flags from flag-icons — https://github.com/lipis/flag-icons
Copyright (c) 2013 Panayiotis Lipiridis
Licensed under the MIT License.

Copied here by packages/i18n/scripts/sync-flags.ts. Do not edit; do not commit.
`;

const flags = readdirSync(FLAGS_SRC).filter((f) => f.endsWith(".svg"));

for (const destination of DESTINATIONS) {
  // Replaced wholesale rather than merged: a flag that flag-icons *removes* (a
  // country stops existing, and they do) must stop being served, not linger.
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });
  cpSync(FLAGS_SRC, destination, { recursive: true });
  writeFileSync(join(destination, "LICENSE.txt"), NOTICE);
}

console.log(
  `Synced ${flags.length} flags to ${DESTINATIONS.length} app(s): ` +
    DESTINATIONS.map((d) => d.replace(`${REPO}/`, "")).join(", "),
);
