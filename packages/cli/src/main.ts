import fs from "node:fs";
import path from "node:path";
import {
  buildPackage,
  generateKeyPair,
  openPackage,
  verifyPackage,
  verifyPublisher,
  type PackageKind,
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
 */

const USAGE = `
zcms — the packaging tool for Z-CMS themes and plugins

  zcms init [<dir>] [--kind theme|plugin] [--id <reverse.dns.id>] [--name <name>]
            [--description <text>] [--author <name>] [--author-url <url>]
            [--version <semver>] [--yes]
      Scaffolds a new theme or plugin: manifest, source, build, test, README.
      Asks for anything it was not given. --yes never asks, and then --kind and
      --id are required.

  zcms keygen [--out <dir>]
      Generates the publisher's Ed25519 key pair.
      The private key must NEVER be committed or sent to anyone.

  zcms pack <dir> --kind theme|plugin --key <private.pem> --pub <public.pem> [--out <file>]
      Packs a built directory into one signed .zcms file.
      Add --operator-key <private.pem> to also stamp an operator signature for the
      sideload route (a self-hosted instance that pins the matching public key).

  zcms verify <file.zcms> [--marketplace-key <public.pem>]
      Checks a package. Without --marketplace-key only the publisher signature is
      checked (enough to check your own work before submitting, NOT enough to install).
`;

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

  // 0600: a private key readable by other users on the box is not a private key.
  fs.writeFileSync(priv, privateKey, { mode: 0o600 });
  fs.writeFileSync(pub, publicKey, { mode: 0o644 });

  console.log(`
  Publisher key pair generated.

    private key : ${priv}   (SECRET — do not commit, do not share)
    public key  : ${pub}    (register it at marketplace.z-cms.org to become a publisher)
`);
}

async function packCmd(argv: string[]) {
  const dir = argv[1];
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

  const { file, envelope } = await buildPackage(
    path.resolve(dir),
    kind,
    fs.readFileSync(keyPath, "utf8"),
    fs.readFileSync(pubPath, "utf8"),
    { operatorPrivateKey },
  );

  const out =
    arg("out", argv) ??
    path.join(process.cwd(), `${envelope.manifest.id}-${envelope.manifest.version}.zcms`);

  fs.writeFileSync(out, file);

  console.log(`
  Packed.

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

async function verifyCmd(argv: string[]) {
  const file = argv[1];
  if (!file) die("Missing .zcms file.");

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

  switch (command) {
    case "init":
      return initCmd(argv);
    case "keygen":
      return keygen(argv);
    case "pack":
      return packCmd(argv);
    case "verify":
      return verifyCmd(argv);
    default:
      console.log(USAGE);
      process.exit(command ? 1 : 0);
  }
}

main().catch((err: Error) => die(err.message));
