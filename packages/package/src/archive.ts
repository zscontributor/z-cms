import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import { extract, pack } from "tar-stream";
import { assertPayloadFilesAllowed } from "./payload-rules";
import { PackageError } from "./types";

/** Never unpack an archive bigger than this, decompressed. */
const MAX_UNPACKED_BYTES = 50 * 1024 * 1024;
const MAX_ENTRIES = 2000;

/**
 * Files that must never travel inside a package.
 *
 * Three groups. The first is KEY MATERIAL, and it is the reason this list is not
 * merely a tidiness feature. The workflow every publisher is told to follow is
 *
 *     zcms keygen        # writes publisher-private.pem into the project
 *     zcms pack .        # packs the project
 *
 * so without this rule the private key that signs the package travels INSIDE the
 * package — uploaded to the marketplace, then unpacked onto every runtime that
 * installs it, and signed by the very key it is leaking. A publisher's identity
 * would be forfeit the first time they published anything. Excluding the key is
 * silent and unconditional: the safe outcome must not depend on the author having
 * read a warning.
 *
 * The second is unsafe to ship for the usual reasons (env files, VCS, deps).
 *
 * The third is dev-only tooling and source that a *distributable* has no use for:
 * the runtime loads `dist/`, not `src/`, and it never runs a build. Excluding it
 * is not just tidiness either — a theme's build/generator script legitimately
 * imports `fs`, and shipping it would put an `fs` import inside the package, which
 * the scanner rightly rejects. The script is not part of what runs; it should not
 * be part of what is scanned or signed. This rule is name-broad on purpose: an
 * earlier `build.mjs`-only version shipped a theme's `gen-theme.mjs` and got the
 * package rejected at review — a script is a script whatever it is called.
 *
 * The fourth is a built package that ended up inside a package — a stale `.zcms`
 * an author left in the tree. It is never content; it only bloats the download and
 * gives the scanner a package-in-a-package to puzzle over.
 */
const DENIED = [
  // Key material. Anywhere in the tree, under any name this can be recognised by.
  /\.(?:pem|key|p12|pfx|keystore|jks)$/i,
  /(^|\/)id_(?:rsa|dsa|ecdsa|ed25519)(\.|$)/,

  // Secrets, VCS, dependencies.
  /(^|\/)node_modules(\/|$)/,
  /**
   * The workspace's own bookkeeping, which a package is not.
   *
   * A theme or plugin is described by `theme.json` / `plugin.json`; `package.json`
   * is how it was BUILT, and shipping it hands a downloader the internal package
   * name, the scripts and the dev dependencies for no benefit — nothing in the
   * loader has ever read one out of a payload.
   *
   * The lockfile matters more, and for a reason this repository already acted on
   * once: private products are excluded from the workspace precisely so the public
   * lockfile stops "publishing the name and full dependency list of every private
   * product" (pnpm-workspace.yaml). A lockfile travelling INSIDE the signed package
   * gives that away again to anyone who downloads it.
   */
  /(^|\/)package\.json$/,
  /(^|\/)(?:pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb)$/,
  /** A marker for this repo's build scripts, meaningless once packed. */
  /(^|\/)\.not-builtin$/,
  /(^|\/)\.git(\/|$)/,
  /(^|\/)\.env/,
  /(^|\/)\.npmrc$/,
  /(^|\/)\.DS_Store$/,
  /(^|\/)\.turbo(\/|$)/,

  // Dev-only: TypeScript source, tests, build/generator scripts, tool configs.
  // The script pattern covers `build.mjs`, `gen-theme.mjs`, `generate.cjs`, etc.,
  // at any depth — but not a data file like `generated-data.mjs` (no build/gen/
  // generate *name*). Note there is deliberately no blanket `scripts/` rule: a
  // non-JS file there (a `scripts/setup.py`) must reach the loud executable refusal
  // in payload-rules, not be silently dropped here.
  /(^|\/)src(\/|$)/,
  /^tests?\//,
  /(^|\/)(?:build|gen|generate)(?:[-.][^/]*)?\.(?:m|c)?js$/,
  /(^|\/)tsconfig(?:\.\w+)?\.json$/,
  /(^|\/)turbo\.json$/,
  /(^|\/)[^/]+\.config\.(?:m|c)?[jt]s$/,
  /\.map$/,

  // A built package that slipped into the source tree — never part of the payload.
  /\.zcms$/i,
];

function collect(dir: string, root = dir): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(root, full);
    if (DENIED.some((re) => re.test(rel))) continue;
    if (entry.isDirectory()) out.push(...collect(full, root));
    else if (entry.isFile()) out.push(rel);
  }
  return out.sort();
}

/**
 * Builds a package from a directory.
 *
 * Entries are sorted and timestamps zeroed so that packing the same directory
 * twice produces byte-identical output. That is not tidiness — it is what makes
 * the checksum reproducible, and therefore what lets anyone verify that the
 * package on the marketplace was built from the source they can see.
 */
export async function packDirectory(dir: string): Promise<Buffer> {
  const files = collect(dir);
  if (files.length === 0) throw new PackageError(`No files in "${dir}".`);
  if (files.length > MAX_ENTRIES) {
    throw new PackageError(`Package has too many files (${files.length} > ${MAX_ENTRIES}).`);
  }

  // What may travel in a package, as opposed to what DENIED quietly leaves out.
  // The distinction is deliberate: DENIED drops files the author is better off
  // not shipping and says nothing, because the safe outcome must not depend on
  // them reading a warning. This refuses, loudly, because an author who packed an
  // .exe or an .mp4 has made a decision, and silently discarding it would hand
  // them a package missing the file they meant to include.
  assertPayloadFilesAllowed(dir, files);

  const tarball = pack();
  const chunks: Buffer[] = [];
  const gzip = createGzip({ level: 9 });

  gzip.on("data", (c: Buffer) => chunks.push(c));
  const done = pipeline(tarball, gzip);

  for (const rel of files) {
    const body = fs.readFileSync(path.join(dir, rel));
    tarball.entry(
      {
        // Always POSIX separators, so a package built on Windows unpacks on Linux.
        name: rel.split(path.sep).join("/"),
        size: body.length,
        mode: 0o644,
        mtime: new Date(0),
        uid: 0,
        gid: 0,
        type: "file",
      },
      body,
    );
  }
  tarball.finalize();

  await done;
  return Buffer.concat(chunks);
}

/**
 * Unpacks a package into `dest`.
 *
 * Every guard here exists because a package is a file uploaded by a stranger:
 *
 *   - path traversal ("../../etc/cron.d/x") is the classic tar-slip, and it turns
 *     "install a theme" into "write anywhere the process can write";
 *   - absolute paths do the same thing more directly;
 *   - symlinks and hardlinks are refused outright — a link pointing at
 *     /etc/passwd would be read back later as if it were part of the theme;
 *   - a decompression bomb is bounded by MAX_UNPACKED_BYTES rather than by the
 *     server's disk running out.
 *
 * The rule is a single one, applied to every entry: the resolved destination
 * must still be inside `dest`. Anything else is rejected, not sanitised —
 * silently rewriting a hostile path is how you end up with a subtly wrong file
 * on disk instead of a loud error.
 */
export async function unpackTo(payload: Buffer, dest: string): Promise<string[]> {
  fs.mkdirSync(dest, { recursive: true });
  const root = fs.realpathSync(dest);

  const written: string[] = [];
  let totalBytes = 0;
  let entries = 0;

  const extractor = extract();

  // The first violation wins and is what the caller sees. Destroying the
  // extractor tears down the entry stream too, and an entry stream with no error
  // handler crashes the process — so rejecting a hostile package would take the
  // server down with it. Every entry gets a handler before it can fail.
  let firstError: Error | undefined;

  extractor.on("entry", (header, stream, next) => {
    stream.on("error", () => undefined);

    void (async () => {
      try {
        if (++entries > MAX_ENTRIES) {
          throw new PackageError(`Package has too many entries (> ${MAX_ENTRIES}).`);
        }

        if (header.type === "symlink" || header.type === "link") {
          throw new PackageError(
            `Package contains a link ("${header.name}"). Links are not allowed — one can point outside the package.`,
          );
        }

        if (header.type !== "file" && header.type !== "directory") {
          throw new PackageError(`Package contains an unexpected entry: ${header.type} ("${header.name}").`);
        }

        const name = header.name;

        if (path.isAbsolute(name) || name.startsWith("/") || /^[a-zA-Z]:/.test(name)) {
          throw new PackageError(`Absolute path in package: "${name}".`);
        }

        const target = path.resolve(root, name);
        // The check that matters. path.resolve() has already collapsed any "..",
        // so if the result escaped `root`, the entry was hostile.
        if (target !== root && !target.startsWith(root + path.sep)) {
          throw new PackageError(
            `Path traversal in package: "${name}" escapes the destination directory.`,
          );
        }

        if (header.type === "directory") {
          fs.mkdirSync(target, { recursive: true });
          stream.resume();
          next();
          return;
        }

        totalBytes += header.size ?? 0;
        if (totalBytes > MAX_UNPACKED_BYTES) {
          throw new PackageError(
            `Package unpacks to more than ${MAX_UNPACKED_BYTES / 1024 / 1024}MB (suspected decompression bomb).`,
          );
        }

        fs.mkdirSync(path.dirname(target), { recursive: true });

        const chunks: Buffer[] = [];
        for await (const chunk of stream) chunks.push(chunk as Buffer);
        fs.writeFileSync(target, Buffer.concat(chunks), { mode: 0o644 });

        written.push(name);
        next();
      } catch (err) {
        firstError ??= err as Error;
        stream.resume();
        extractor.destroy(firstError);
      }
    })();
  });

  try {
    await pipeline(
      (function* () {
        yield payload;
      })(),
      createGunzip(),
      extractor,
    );
  } catch (err) {
    // Surface our own diagnosis ("path traversal in package") rather than the
    // stream teardown error that followed it.
    throw firstError ?? err;
  }

  if (firstError) throw firstError;

  return written;
}
