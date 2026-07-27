import fs from "node:fs";
import path from "node:path";
import {
  buildPackage,
  bumpSemver,
  generateKeyPair,
  openPackage,
  verifyPackage,
  verifyPublisher,
  type PackageKind,
  type ReleaseLevel,
} from "@zcmsorg/package";
import {
  scaffold,
  suggestId,
  suggestName,
  validateId,
  validateName,
  validateVersion,
  writeScaffold,
  type InitOptions,
} from "./init";
import { resolveLang, unknownCommand, usage } from "./help";
import { createPrompter, interactive } from "./prompt";

/**
 * `zcms` — the tool a theme or plugin author uses.
 *
 * Four commands, and the split is deliberate:
 *
 *   init    — starts a package that already satisfies the two contracts an author
 *             cannot see: a plugin is one CommonJS file, a theme entry is ESM and
 *             shares the host's React. Both are enforced on a live site, so the
 *             cost of guessing wrong is paid by somebody else.
 *   keygen  — makes the author's identity. Their private key never leaves their
 *             machine; the marketplace only ever sees the public half.
 *   pack    — turns a built directory into one signed .zcms file.
 *   verify  — checks a package the way a runtime would, so an author can prove
 *             to themselves that what they are about to publish is what they
 *             think it is.
 *
 * `publish` is deliberately NOT here yet: uploading is `POST /packages` with an
 * admin session, and pretending the CLI can do it before there is a publisher
 * account system would be a lie in tab-completion form.
 *
 * The help text itself lives in ./help, in English, Japanese and Vietnamese; the
 * language is chosen by --lang, ZCMS_LANG, or the shell locale.
 */

function arg(name: string, argv: string[]): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

function has(name: string, argv: string[]): boolean {
  return argv.includes(`--${name}`);
}

function die(message: string): never {
  console.error(`\n  Error: ${message}\n`);
  process.exit(1);
}

/** The first non-flag argument after the command, if there is one. */
function positional(argv: string[]): string | undefined {
  const value = argv[1];
  return value && !value.startsWith("--") ? value : undefined;
}

/**
 * Scaffolds a new theme or plugin.
 *
 * It asks, when it can. `--yes` and a non-TTY stdin both mean "do not ask" — the
 * second because a prompt written to a pipe is not a prompt, it is a hang, and a
 * scaffold that hangs inside a CI job is worse than one that fails.
 */
async function initCmd(argv: string[]) {
  const ask = !has("yes", argv) && interactive();

  let kind = arg("kind", argv) as PackageKind | undefined;
  if (kind && kind !== "theme" && kind !== "plugin") {
    die("--kind must be theme or plugin.");
  }

  let id = arg("id", argv);
  let name = arg("name", argv);
  let description = arg("description", argv);
  let authorName = arg("author", argv);
  const authorUrl = arg("author-url", argv) ?? "";
  const version = arg("version", argv) ?? "0.1.0";

  const versionError = validateVersion(version);
  if (versionError) die(versionError);

  if (!ask && (!kind || !id)) {
    die(
      "Nothing to ask with: stdin is not a terminal, or --yes was given. " +
        "Pass at least --kind theme|plugin and --id <reverse.dns.id>.",
    );
  }

  if (ask) {
    const prompter = createPrompter();
    try {
      if (!kind) {
        const choice = await prompter.choose("What are you building?", [
          "A plugin — code that reacts to the CMS (sandboxed, no UI of its own)",
          "A theme — how a site looks (React templates, blocks, CSS)",
        ]);
        kind = choice === 1 ? "theme" : "plugin";
      }

      console.log("");

      // Asked in a loop, like the id below it. A prompt that accepts a bad answer
      // and fails four steps later, after the author has typed three more, is a
      // worse prompt than one that says no immediately.
      while (!name) {
        const answer = await prompter.ask("Name", suggestName(id ?? `my-${kind}`));
        const error = validateName(answer);
        if (!error) {
          name = answer;
          break;
        }
        console.log(`  ${error}`);
      }

      if (!id) {
        for (;;) {
          const answer = await prompter.ask("Id", suggestId(kind, name));
          const error = validateId(answer);
          if (!error) {
            id = answer;
            break;
          }
          console.log(`  ${error}`);
        }
      }

      if (!description) {
        description = await prompter.ask(
          "Description",
          `A Z-CMS ${kind}.`,
        );
      }

      if (!authorName) authorName = await prompter.ask("Author");
    } finally {
      prompter.close();
    }
  }

  // Everything below holds whether the values were prompted for or passed as
  // flags, so the non-interactive path gets the same validation as the human one.
  if (!kind) die("--kind must be theme or plugin.");
  if (!id) die("--id is required, e.g. --id com.acme.plugin.hello");

  const idError = validateId(id);
  if (idError) die(idError);

  name ??= suggestName(id);
  description ??= `A Z-CMS ${kind}.`;
  authorName ??= name;

  // The --name/--author/--description path reaches here without ever having been
  // through a prompt, and `--yes` skips the prompts entirely. Same rules, both ways.
  const nameError = validateName(name);
  if (nameError) die(nameError);

  const options: InitOptions = {
    kind,
    id,
    name,
    description,
    version,
    authorName,
    authorUrl,
  };

  const dir = path.resolve(positional(argv) ?? arg("dir", argv) ?? id.split(".").pop() ?? id);

  const files = scaffold(options);
  const written = writeScaffold(dir, files);

  const relative = path.relative(process.cwd(), dir) || ".";

  console.log(`
  Created ${name} (${kind}) in ${relative}/

${written.map((file) => `    ${file}`).join("\n")}

  Next:

    cd ${relative}
    pnpm install
    pnpm build          # ${kind === "theme" ? "dist/index.mjs + dist/theme.css" : "dist/index.js — one CommonJS file, which is what the sandbox runs"}
    pnpm keygen         # once, ever. Your private key never leaves this machine.
    pnpm pack           # -> ${id}-${version}.zcms, signed by you
    pnpm verify

  README.md has the rest, including why the build is shaped the way it is.
`);
}

function keygen(argv: string[]) {
  const out = arg("out", argv) ?? process.cwd();
  fs.mkdirSync(out, { recursive: true });

  const { privateKey, publicKey } = generateKeyPair();
  const priv = path.join(out, "publisher-private.pem");
  const pub = path.join(out, "publisher-public.pem");

  if (fs.existsSync(priv)) {
    die(`${priv} already exists. Overwriting a private key orphans every package it has ever signed.`);
  }
  // The public half is guarded too: silently rewriting it while leaving an
  // unrelated private key in place would hand out a key pair whose halves no
  // longer match, and every signature made with it would then fail to verify.
  if (fs.existsSync(pub)) {
    die(`${pub} already exists. Point --out at an empty directory so the pair stays matched.`);
  }

  // 0600: a private key readable by other users on the box is not a private key.
  fs.writeFileSync(priv, privateKey, { mode: 0o600 });
  fs.writeFileSync(pub, publicKey, { mode: 0o644 });

  console.log(`
  Publisher key pair generated.

    private key : ${priv}   (SECRET — do not commit, do not share)
    public key  : ${pub}    (register it at marketplace.z-cms.org to become a publisher)
`);
}

/**
 * How `pack` handles the version, read off the flags.
 *
 * The model is "ship what the manifest declares, then advance it for next time":
 * the artifact carries the version currently in the manifest (so a fresh 0.1.0
 * scaffold packs as 0.1.0, the version the author chose), and AFTER a successful
 * pack the manifest is bumped so the next pack is automatically a new version.
 * That is the default, and it needs no flags — a rebuild-and-repack just works.
 *
 *   setVersion — override the version to ship THIS pack (written before packing).
 *   advance    — the level to bump the manifest to after packing, or null for
 *                --no-bump. These compose: `--set-version 1.0.0` ships 1.0.0 and
 *                still advances to 1.0.1 unless --no-bump is also given.
 */
interface VersionPlan {
  setVersion?: string;
  advance: ReleaseLevel | null;
}

function resolveVersionPlan(argv: string[]): VersionPlan {
  const setVersion = arg("set-version", argv);
  const noBump = has("no-bump", argv);
  const bumpLevel = arg("bump", argv);

  if (noBump && bumpLevel !== undefined) {
    die("--no-bump cannot be combined with --bump.");
  }
  if (setVersion !== undefined) {
    const error = validateVersion(setVersion);
    if (error) die(error);
  }

  const level = bumpLevel ?? "patch";
  if (level !== "major" && level !== "minor" && level !== "patch") {
    die("--bump must be major, minor or patch.");
  }

  return { setVersion, advance: noBump ? null : level };
}

/** Preserves the file's own indentation and trailing-newline habit on rewrite. */
function writeJsonPreserving(file: string, original: string, obj: unknown): void {
  const match = original.match(/\n([ \t]+)/);
  const indent = match ? match[1] : 2;
  const trailing = original.endsWith("\n") ? "\n" : "";
  fs.writeFileSync(file, JSON.stringify(obj, null, indent) + trailing);
}

/**
 * The manifest (and its sibling package.json) opened for a version rewrite: the
 * parsed objects, their original bytes for indentation-preserving writes and for
 * rollback, and the current version.
 *
 * package.json is only tracked when it exists AND already carries a version, so
 * the two never drift; a missing, unversioned, or malformed package.json is left
 * entirely alone — it is not this command's to create or police.
 */
interface VersionState {
  manifestName: string;
  manifestFile: string;
  manifest: Record<string, unknown>;
  originalManifest: string;
  current: string;
  pkgFile?: string;
  pkg?: Record<string, unknown>;
  originalPkg?: string;
}

function openVersion(dir: string, kind: PackageKind): VersionState {
  const manifestName = kind === "theme" ? "theme.json" : "plugin.json";
  const manifestFile = path.join(dir, manifestName);
  if (!fs.existsSync(manifestFile)) die(`Missing ${manifestName} in "${dir}".`);

  const originalManifest = fs.readFileSync(manifestFile, "utf8");
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(originalManifest) as Record<string, unknown>;
  } catch {
    die(`${manifestName} is not valid JSON.`);
  }

  const current = typeof manifest.version === "string" ? manifest.version : undefined;
  if (!current) {
    die(`${manifestName} has no "version". Add one, e.g. --set-version 0.1.0.`);
  }

  const state: VersionState = { manifestName, manifestFile, manifest, originalManifest, current };

  const pkgFile = path.join(dir, "package.json");
  if (fs.existsSync(pkgFile)) {
    const originalPkg = fs.readFileSync(pkgFile, "utf8");
    try {
      const pkg = JSON.parse(originalPkg) as Record<string, unknown>;
      if (typeof pkg.version === "string") {
        state.pkgFile = pkgFile;
        state.pkg = pkg;
        state.originalPkg = originalPkg;
      }
    } catch {
      // Leave a malformed package.json untouched.
    }
  }

  return state;
}

/** Writes `version` into the manifest, and package.json when it is tracked. */
function writeVersion(state: VersionState, version: string): void {
  state.manifest.version = version;
  writeJsonPreserving(state.manifestFile, state.originalManifest, state.manifest);
  if (state.pkgFile && state.pkg && state.originalPkg !== undefined) {
    state.pkg.version = version;
    writeJsonPreserving(state.pkgFile, state.originalPkg, state.pkg);
  }
}

/** Puts the exact original bytes back — used when a pack fails after a rewrite. */
function restoreVersion(state: VersionState): void {
  fs.writeFileSync(state.manifestFile, state.originalManifest);
  if (state.pkgFile && state.originalPkg !== undefined) {
    fs.writeFileSync(state.pkgFile, state.originalPkg);
  }
}

async function packCmd(argv: string[]) {
  // Via `positional`, not `argv[1]`, so `zcms pack --kind theme ...` (dir omitted)
  // reports the missing directory instead of trying to pack a directory named
  // "--kind" and failing later with an opaque ENOENT.
  const dir = positional(argv);
  if (!dir) die("Missing source directory. Example: zcms pack ./themes/corporate --kind theme ...");

  const kind = arg("kind", argv) as PackageKind | undefined;
  if (kind !== "theme" && kind !== "plugin") die("--kind must be theme or plugin.");

  const keyPath = arg("key", argv);
  const pubPath = arg("pub", argv);
  if (!keyPath || !pubPath) die("--key <private.pem> and --pub <public.pem> are required. Run `zcms keygen` if you have neither.");

  // --operator-key stamps an OPERATOR signature as well, for the sideload route: a
  // self-hosted instance whose runtimes pin this key's public half will run the
  // package without any marketplace round-trip. The operator is the publisher of
  // their own sideload, so --key/--pub should be that same operator key pair.
  const operatorKeyPath = arg("operator-key", argv);
  const operatorPrivateKey = operatorKeyPath
    ? fs.readFileSync(operatorKeyPath, "utf8")
    : undefined;

  const resolvedDir = path.resolve(dir);
  const plan = resolveVersionPlan(argv);
  const state = openVersion(resolvedDir, kind);

  // The version this pack ships: an explicit --set-version, else whatever the
  // manifest already declares. Written to disk before packing so the artifact and
  // its filename carry it; rolled back if the pack then fails.
  const shipVersion = plan.setVersion ?? state.current;
  if (shipVersion !== state.current) writeVersion(state, shipVersion);

  let built;
  try {
    built = await buildPackage(
      resolvedDir,
      kind,
      fs.readFileSync(keyPath, "utf8"),
      fs.readFileSync(pubPath, "utf8"),
      { operatorPrivateKey },
    );
  } catch (err) {
    restoreVersion(state);
    throw err;
  }
  const { file, envelope } = built;

  // The pack succeeded, so `shipVersion` is valid semver (buildPackage rejects a
  // malformed one). Advance the manifest so the NEXT pack is automatically a new
  // version — this is what makes the whole feature hands-off. --no-bump skips it.
  const advancedTo =
    plan.advance !== null ? bumpSemver(shipVersion, plan.advance) : undefined;
  if (advancedTo) writeVersion(state, advancedTo);

  const out =
    arg("out", argv) ??
    path.join(process.cwd(), `${envelope.manifest.id}-${envelope.manifest.version}.zcms`);

  fs.writeFileSync(out, file);

  const versionLine = advancedTo
    ? `    version  : packed ${shipVersion}; ${state.manifestName} advanced to ${advancedTo} for the next pack`
    : `    version  : packed ${shipVersion}  (--no-bump; ${state.manifestName} left unchanged)`;

  console.log(`
  Packed.

${versionLine}
    package  : ${envelope.manifest.id}@${envelope.manifest.version} (${kind})
    file     : ${out}  (${(file.length / 1024).toFixed(1)} KB)
    checksum : ${envelope.checksum}
${
  envelope.operatorSignature
    ? `
  The package carries an OPERATOR signature. An instance whose runtimes pin the
  matching OPERATOR_PUBLIC_KEY will run it once an admin sideloads and approves it —
  no marketplace involved, which is the point: it works fully offline. Do not submit
  this to the marketplace; the operator route and the marketplace route are separate.
`
    : `
  The package carries a publisher signature and no marketplace counter-signature.
  What that means depends on where it is going:

    - a MARKETPLACE package needs the counter-signature, and a runtime will refuse
      to run it without one. Submit this file to have it reviewed and co-signed.

    - a BUILT-IN package (one that ships inside the image, verified against the
      operator's pinned FIRST_PARTY_PUBLIC_KEY) is already complete. There is no
      marketplace in that path, which is the point: it works offline.

    - an OPERATOR sideload: re-run with --operator-key to stamp the operator
      signature this instance's runtimes verify.
`
}`);
}

/** The most recently written *.zcms in `dir`, or undefined if there are none. */
function newestPackage(dir: string): string | undefined {
  let newest: { file: string; mtime: number } | undefined;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".zcms")) continue;
    const full = path.join(dir, name);
    const stat = fs.statSync(full);
    if (!stat.isFile()) continue;
    if (!newest || stat.mtimeMs > newest.mtime) newest = { file: full, mtime: stat.mtimeMs };
  }
  return newest?.file;
}

async function verifyCmd(argv: string[]) {
  // No file? Verify the newest .zcms in the current directory. Because `pack` bumps
  // the version, the output filename moves every time, so a `verify` script cannot
  // hardcode it — "the one I just packed" is what the author means, and this is it.
  const file = positional(argv) ?? newestPackage(process.cwd());
  if (!file) {
    die("No .zcms file given and none found in the current directory. Pass one: zcms verify <file.zcms>.");
  }

  const pkg = await openPackage(fs.readFileSync(file));
  const m = pkg.envelope.manifest;

  console.log(`
  ${m.id}@${m.version}  (${m.kind})
    author   : ${m.author?.name}
    engine   : ${m.engine}
    checksum : ${pkg.envelope.checksum}
`);

  try {
    verifyPublisher(pkg.envelope, pkg.payload);
    console.log("    publisher signature   : VALID");
  } catch (err) {
    console.log(`    publisher signature   : INVALID — ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }

  const marketplaceKey = arg("marketplace-key", argv);
  if (!marketplaceKey) {
    console.log(
      "    marketplace signature : not checked (no --marketplace-key)\n" +
        "\n  Note: a runtime runs ONLY packages the marketplace has signed.\n",
    );
    return;
  }

  try {
    verifyPackage(pkg.envelope, pkg.payload, fs.readFileSync(marketplaceKey, "utf8"));
    console.log("    marketplace signature : VALID — this package is installable.\n");
  } catch (err) {
    console.log(`    marketplace signature : INVALID — ${(err as Error).message}\n`);
    process.exitCode = 1;
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const command = argv[0];

  // Help is the only localized output: --lang, then ZCMS_LANG, then the shell
  // locale, then English. Resolved up front so every help path below speaks it,
  // including the one an unknown command falls into.
  const lang = resolveLang(argv, process.env);

  switch (command) {
    case "init":
      return initCmd(argv);
    case "keygen":
      return keygen(argv);
    case "pack":
      return packCmd(argv);
    case "verify":
      return verifyCmd(argv);
    case "help":
    case "-h":
    case "-help":
    case "--help":
      console.log(usage(lang));
      return;
    default:
      // An unknown command is a mistake worth naming, so the hint points at it
      // rather than burying it under the whole usage text; no command at all just
      // prints help and exits 0.
      if (command) console.error(unknownCommand(command, lang));
      console.log(usage(lang));
      process.exit(command ? 1 : 0);
  }
}

main().catch((err: Error) => die(err.message));
