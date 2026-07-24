import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Signs the built-in packages — plugins or themes — and writes the signed `.zcms`
 * next to each one.
 *
 *   tsx scripts/sign-builtins.mts plugin
 *   tsx scripts/sign-builtins.mts theme
 *
 * This is what makes a built-in *verifiable* rather than merely *trusted*. The
 * runtimes used to read the compiled bundle off the volume and run it, on the
 * reasoning that the volume belongs to the operator — which holds right up until it
 * is a bad image layer, a mounted host path, or a compromised CI step. Built-in code
 * is the code with the most privilege in the system:
 *
 *   - a built-in PLUGIN (zAI) holds `network:fetch` and spends the site's API keys;
 *   - a built-in THEME is worse, and it is worth saying plainly: a theme is not
 *     sandboxed at all. It renders inside site-runtime's own process, with its own
 *     Node. There is no isolate underneath it to catch anything.
 *
 * So the artefact is signed here, committed, and verified against
 * `FIRST_PARTY_PUBLIC_KEY` before anything is imported or executed. The compiled
 * bundle on the volume is no longer trusted and is no longer read.
 *
 * No marketplace is involved: a built-in ships in the image, so there is no
 * counter-signature and no registry to call. That is the point — it works offline.
 *
 *   ZCMS_PUBLISHER_KEY=.keys/zsoft-publisher-private.pem pnpm sign:plugins
 *
 * The private key never lives in this repo. `.keys/` is gitignored, and the real one
 * belongs in a secret manager; the public half in `keys/zsoft-publisher.pub.pem` is
 * what every runtime pins.
 */

const KIND = process.argv[2];
if (KIND !== "plugin" && KIND !== "theme") {
  console.error("Usage: tsx scripts/sign-builtins.mts <plugin|theme>");
  process.exit(1);
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");

const KEY = process.env.ZCMS_PUBLISHER_KEY ?? path.join(REPO, ".keys/zsoft-publisher-private.pem");
const PUB = process.env.ZCMS_PUBLISHER_PUB ?? path.join(REPO, "keys/zsoft-publisher.pub.pem");
const CLI = path.join(REPO, "packages/cli/dist/main.js");

/**
 * What each kind actually ships.
 *
 * Pointing `zcms pack` at a working directory would sweep in `src/`, `build.mjs` and
 * `scripts/sync-assets.ts`. The DENIED list in archive.ts drops most of that already,
 * but relying on a denylist to keep a SIGNING INPUT clean is the wrong way round: a
 * denylist can be widened by someone adding a file, an explicit payload cannot. And
 * the signature covers whatever we put in here, so "whatever happened to be in the
 * directory" is not a thing to sign.
 *
 * A theme carries its own CSS and assets because site-runtime's Tailwind only ever
 * scanned its own source — a theme installed later is invisible to it. See
 * docs/distribution.md, "Why a theme carries its own CSS".
 */
const SHAPE = {
  plugin: { dir: "plugins", manifest: "plugin.json", payload: ["plugin.json", "dist", "screenshots"] },
  theme: { dir: "themes", manifest: "theme.json", payload: ["theme.json", "dist", "assets", "screenshots"] },
} as const;

const shape = SHAPE[KIND];

if (!fs.existsSync(KEY)) {
  console.error(
    `\nNo signing key at ${KEY}.\n\n` +
      `A built-in is only runnable if it is signed, so this is not optional.\n` +
      `Point ZCMS_PUBLISHER_KEY at the first-party private key, or generate a new\n` +
      `keypair with:  pnpm keygen:first-party\n\n` +
      `If you generate a new one, every runtime must pin the new public key\n` +
      `(FIRST_PARTY_PUBLIC_KEY) or it will refuse to run these packages — which is\n` +
      `the system working, not breaking.\n`,
  );
  process.exit(1);
}

if (!fs.existsSync(CLI)) {
  console.error(`\nThe CLI is not built. Run:  pnpm --filter @zcmsorg/cli build\n`);
  process.exit(1);
}

const root = path.join(REPO, shape.dir);
const names = fs
  .readdirSync(root, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .filter((entry) => fs.existsSync(path.join(root, entry.name, shape.manifest)))
  .map((entry) => entry.name);

if (names.length === 0) {
  console.error(`No ${KIND}s found under ${shape.dir}/.`);
  process.exit(1);
}

console.log(`Signing ${names.length} built-in ${KIND}(s) with ${path.relative(REPO, KEY)}\n`);

for (const name of names) {
  const dir = path.join(root, name);
  const manifest = JSON.parse(
    fs.readFileSync(path.join(dir, shape.manifest), "utf8"),
  ) as { id: string; version: string; entry?: string };

  const entry = path.join(dir, manifest.entry ?? "dist/index.js");
  if (!fs.existsSync(entry)) {
    console.error(
      `\n${name}: ${manifest.entry ?? "dist/index.js"} is missing. Build it first.\n`,
    );
    process.exit(1);
  }

  const staging = path.join(REPO, `.packages/staging-${KIND}s`, name);
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  for (const item of shape.payload) {
    const from = path.join(dir, item);
    if (fs.existsSync(from)) fs.cpSync(from, path.join(staging, item), { recursive: true });
  }

  // The artefact lands NEXT TO the source, and is committed. It is what ships in the
  // image and what the runtime loads — the source beside it is how it got here, not
  // what runs.
  const out = path.join(dir, `${manifest.id}-${manifest.version}.zcms`);

  // Old versions would otherwise pile up in the image, and a stale signed bundle is
  // still a valid, runnable bundle — just no longer the one anyone reviewed.
  for (const stale of fs.readdirSync(dir).filter((f) => f.endsWith(".zcms"))) {
    if (path.join(dir, stale) !== out) fs.rmSync(path.join(dir, stale));
  }

  console.log(`── ${name} (${manifest.id}@${manifest.version})`);
  execFileSync(
    process.execPath,
    [CLI, "pack", staging, "--kind", KIND, "--key", KEY, "--pub", PUB, "--out", out],
    { stdio: "inherit" },
  );
  console.log(`   → ${path.relative(REPO, out)}\n`);
}

console.log(
  `Done. Commit the .zcms files.\n\n` +
    `Every runtime verifies them against FIRST_PARTY_PUBLIC_KEY before importing or\n` +
    `executing a byte, so a package whose bundle was edited after signing will not run.\n`,
);
