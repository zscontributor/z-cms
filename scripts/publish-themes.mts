/**
 * Packs, signs and submits the first-party themes to a Z-CMS Marketplace.
 *
 *   ZCMS_PUBLISHER_KEY=... ZCMS_PUBLISHER_PUB=... pnpm tsx scripts/publish-themes.mts
 *   pnpm tsx scripts/publish-themes.mts default market   # a subset
 *
 * This does the author's half of the release and nothing more. It cannot approve
 * anything, and it does not hold the marketplace's key: what it uploads carries
 * only a PUBLISHER signature, and the marketplace decides for itself whether to
 * counter-sign. That asymmetry is the point of the whole scheme, so a release
 * script that could shortcut it would be a release script that had defeated it.
 *
 * The steps, per theme:
 *
 *   1. `zcms pack` — tar the payload, hash it, sign the hash with the publisher's
 *      Ed25519 private key, wrap it all into one .zcms
 *   2. `POST /api/v1/packages` as staff — the marketplace re-hashes the bytes,
 *      looks the publisher up BY PUBLIC KEY, verifies the signature against the key
 *      in its own database, scans the payload, extracts the screenshots, and only
 *      then counter-signs and stores it
 *   3. read the public catalogue back, and print what a visitor would now see
 *
 * A trusted first-party publisher lands on APPROVED without a human; anyone else
 * lands on PENDING and waits for one. This script reports whichever happened rather
 * than assuming.
 *
 * Environment:
 *   ZCMS_PUBLISHER_KEY   path to publisher-private.pem   (never commit it)
 *   ZCMS_PUBLISHER_PUB   path to publisher-public.pem
 *   MARKETPLACE_API_URL  default http://localhost:4300
 *   MARKETPLACE_EMAIL    default admin@marketplace.z-cms.org
 *   MARKETPLACE_PASSWORD default changeme123   (the published dev default)
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(REPO, "packages/cli/dist/main.js");
const OUT_DIR = path.join(REPO, ".packages");

const API = process.env.MARKETPLACE_API_URL ?? "http://localhost:4300";
const EMAIL = process.env.MARKETPLACE_EMAIL ?? "admin@marketplace.z-cms.org";
const PASSWORD = process.env.MARKETPLACE_PASSWORD ?? "changeme123";

const KEY = process.env.ZCMS_PUBLISHER_KEY;
const PUB = process.env.ZCMS_PUBLISHER_PUB;

const themes = process.argv.slice(2);
if (themes.length === 0) themes.push("default", "market", "magazine");

if (!KEY || !PUB) {
  console.error(
    "ZCMS_PUBLISHER_KEY and ZCMS_PUBLISHER_PUB must point at the publisher keypair.\n" +
      "Generate one with:  node packages/cli/dist/main.js keygen --out <dir>",
  );
  process.exit(1);
}

// ------------------------------------------------------------------------- pack

fs.mkdirSync(OUT_DIR, { recursive: true });

interface Packed {
  theme: string;
  id: string;
  version: string;
  file: string;
}

/**
 * What a theme actually ships.
 *
 * `zcms pack` tars the directory it is given, minus node_modules and dotfiles — so
 * pointing it at a theme's working directory would put that theme's *source tree*
 * into the artefact: its TypeScript, its esbuild config, and (for the default theme)
 * `scripts/sync-assets.ts`, which reads and writes files because its job is to copy
 * assets into site-runtime at build time.
 *
 * The marketplace scanner refuses that package, and it is right to. It cannot know
 * that the `fs` import belongs to a build script rather than to the theme; all it
 * sees is a package that reaches for the filesystem, which is exactly the shape of
 * the thing it exists to stop. "It's only the build script" is what the next person
 * to ship a backdoor would also say.
 *
 * So the payload is assembled explicitly instead: the compiled bundle, the
 * stylesheet, the manifest, and the files the manifest points at. A runtime needs
 * nothing else, and everything else is a liability — larger downloads, a bigger
 * attack surface, and a scanner arguing with a toolchain it was never shown.
 */
const PAYLOAD = ["theme.json", "dist", "assets", "screenshots"];

function stage(themeDir: string, theme: string): string {
  const staging = path.join(OUT_DIR, "staging", theme);
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });

  for (const item of PAYLOAD) {
    const from = path.join(themeDir, item);
    if (!fs.existsSync(from)) continue;
    fs.cpSync(from, path.join(staging, item), { recursive: true });
  }

  return staging;
}

const packed: Packed[] = themes.map((theme) => {
  const dir = path.join(REPO, "themes", theme);
  const manifest = JSON.parse(
    fs.readFileSync(path.join(dir, "theme.json"), "utf8"),
  ) as { id: string; version: string };

  const file = path.join(OUT_DIR, `${manifest.id}-${manifest.version}.zcms`);

  console.log(`\n── ${theme} ────────────────────────────────────────────`);
  execFileSync(
    process.execPath,
    [
      CLI,
      "pack",
      stage(dir, theme),
      "--kind",
      "theme",
      "--key",
      KEY,
      "--pub",
      PUB,
      "--out",
      file,
    ],
    { stdio: "inherit" },
  );

  return { theme, id: manifest.id, version: manifest.version, file };
});

// ----------------------------------------------------------------------- upload

async function login(): Promise<string> {
  const response = await fetch(`${API}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });

  if (!response.ok) {
    throw new Error(
      `Login failed (${response.status}). Is the marketplace API running on ${API}?\n` +
        (await response.text()),
    );
  }

  const body = (await response.json()) as {
    token?: string;
    accessToken?: string;
    mfaRequired?: boolean;
  };

  if (body.mfaRequired) {
    throw new Error(
      "This staff account has TOTP enabled. Upload from the admin console instead — " +
        "a release script is not a place to type a second factor.",
    );
  }

  const token = body.token ?? body.accessToken;
  if (!token) throw new Error(`Login returned no token: ${JSON.stringify(body)}`);
  return token;
}

async function upload(token: string, item: Packed): Promise<void> {
  const form = new FormData();
  form.set(
    "file",
    new Blob([fs.readFileSync(item.file)], { type: "application/octet-stream" }),
    path.basename(item.file),
  );

  const response = await fetch(`${API}/api/v1/packages`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });

  const text = await response.text();

  if (!response.ok) {
    // The marketplace refuses a package for reasons the author needs to read in
    // full — a scanner finding, an unknown publisher key, a version that already
    // exists with different bytes. Truncating that would make it un-actionable.
    throw new Error(`${item.id}@${item.version} rejected (${response.status}):\n${text}`);
  }

  console.log(`  uploaded ${item.id}@${item.version} → ${text}`);
}

const token = await login();
console.log(`\nAuthenticated with ${API} as ${EMAIL}.\n`);

for (const item of packed) {
  await upload(token, item);
}

// -------------------------------------------------------------------- catalogue

const catalogue = (await (
  await fetch(`${API}/api/v1/registry/packages?kind=theme`)
).json()) as unknown;

console.log("\nPublic catalogue (what a Z-CMS admin now sees):");
console.log(JSON.stringify(catalogue, null, 2));
