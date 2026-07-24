import fs from "node:fs";
import path from "node:path";
import { PackageError } from "./types";

/**
 * What a package is allowed to CONTAIN, as opposed to what its code is allowed
 * to DO (that is the scanner's source rules) or what its manifest may claim
 * (that is media.ts).
 *
 * A package is a bag of files that the runtime imports. It is never a program
 * the platform runs: there is no install hook, no postinstall, no entry point
 * that shells out. So a `.sh`, an `.exe`, or a `.so` inside a package has
 * nothing that would ever execute it — which is exactly why it should not be
 * there, and why finding one is worth stopping for rather than shrugging at.
 *
 * Be honest about what this buys, because it is easy to oversell:
 *
 *   - It is NOT what stops a hostile package from running a binary. Nothing
 *     execs these files, `unpackTo` writes every entry 0o644 (never +x), and a
 *     plugin runs in an isolate with no `child_process` at all. Those are the
 *     controls. This rule is defence in depth behind them.
 *   - It is trivially defeated by renaming `payload.sh` to `payload.txt` — so
 *     the extension check is paired with a magic-byte sniff (`sniffExecutable`)
 *     that reads what the file actually IS. That is harder to dodge, though a
 *     determined author can still base64 a binary into a .txt, which is what the
 *     scanner's `embedded-blob` rule is for.
 *
 * What it actually buys is the common case: an author who packed their whole
 * repo and swept a build script or a native `.node` addon in with it hears about
 * it from `zcms pack` in their own terminal, and a reviewer never has to wonder
 * why a theme ships an ELF binary.
 */

export type PayloadSeverity = "block" | "warn";

export interface PayloadIssue {
  severity: PayloadSeverity;
  /** Stable rule id, mirroring the scanner's vocabulary. */
  rule: string;
  message: string;
}

/**
 * Files with nothing in the platform that could ever run them.
 *
 * Grouped only for readability — every one of them is refused. Note what is NOT
 * here: `.js`, `.mjs`, `.cjs`. Those ARE the package, and they are governed by
 * the scanner's source rules instead.
 */
const EXECUTABLE_EXTENSIONS = new Set([
  // Shell and batch.
  ".sh", ".bash", ".zsh", ".fish", ".ksh", ".csh", ".command",
  ".bat", ".cmd", ".ps1", ".psm1", ".vbs", ".vbe", ".wsf", ".wsh", ".hta", ".scr",
  // Native code, in the shapes an OS will load.
  ".exe", ".dll", ".com", ".so", ".dylib", ".node", ".elf", ".o", ".a", ".bin",
  // Installers and bundles.
  ".msi", ".deb", ".rpm", ".pkg", ".dmg", ".apk", ".jar", ".war", ".appimage",
  // Other language runtimes. A Z-CMS package is JavaScript; a `.py` in one is
  // either dead weight or something hoping to be run by hand.
  ".py", ".rb", ".pl", ".php", ".lua",
]);

/**
 * Video, which does not belong in a package for a reason that has nothing to do
 * with security: it is enormous.
 *
 * A thirty-second clip is bigger than the entire code budget, and EVERY install
 * of that package — on every site, forever — downloads it. There are two places
 * a video should live instead, and the error says both, because an author who
 * packed an .mp4 wanted one of them and does not know it exists.
 *
 * Note the omission: `.ts` is NOT here. It is an MPEG transport stream and it is
 * also TypeScript, and refusing a package for shipping TypeScript would be an
 * absurd way to find that out.
 */
const VIDEO_EXTENSIONS = new Set([
  ".mp4", ".m4v", ".mov", ".avi", ".mkv", ".webm", ".wmv", ".flv",
  ".mpg", ".mpeg", ".ogv", ".3gp", ".m2ts", ".mts", ".vob", ".rmvb",
]);

/**
 * WebAssembly is warned about, not blocked.
 *
 * It is genuinely executable and genuinely unreadable — a human reviewer cannot
 * review a .wasm any more than they can review a minified bundle — but unlike an
 * .exe it has a legitimate reason to be in a JavaScript package (a bundled codec,
 * a parser). So it takes the same route as obfuscated source: QUARANTINED, and a
 * person decides. Blocking it outright would refuse real packages; ignoring it
 * would let an unreviewable blob through unremarked.
 */
const OPAQUE_EXTENSIONS = new Set([".wasm"]);

/** How the video error names the place to put the file instead. */
function videoGuidance(file: string, manifestFile: string): string {
  return (
    `The package contains a video file ("${file}"). Videos are not packaged: one clip is ` +
    `larger than the entire code budget, and every install of this package would download it.\n\n` +
    `  • To play a video inside a page or a blog post: upload it in the admin under ` +
    `Media Library (Media → Upload), copy the URL it gives you, and paste that URL into the ` +
    `page or post content.\n` +
    `  • To show a preview video on the marketplace listing: remove the file and set ` +
    `"media.video" in ${manifestFile} to an https:// URL (YouTube, Vimeo, …).`
  );
}

/**
 * Classifies one path inside a package by its extension alone.
 *
 * Returns null for the overwhelming majority of files — this says "there is
 * something wrong with this file", not "this file is fine".
 */
export function classifyPayloadFile(
  rel: string,
  manifestFile = "plugin.json / theme.json",
): PayloadIssue | null {
  const ext = path.extname(rel).toLowerCase();

  if (EXECUTABLE_EXTENSIONS.has(ext)) {
    return {
      severity: "block",
      rule: "executable-file",
      message:
        `The package contains an executable file ("${rel}"). A package is code the runtime ` +
        `imports, never a program it runs — nothing in the platform would ever execute a ` +
        `"${ext}", so shipping one is either a mistake or an attempt to get it onto a host. ` +
        `Remove it from the package directory before packing.`,
    };
  }

  if (VIDEO_EXTENSIONS.has(ext)) {
    return {
      severity: "block",
      rule: "video-file",
      message: videoGuidance(rel, manifestFile),
    };
  }

  if (OPAQUE_EXTENSIONS.has(ext)) {
    return {
      severity: "warn",
      rule: "opaque-binary",
      message:
        `The package contains "${rel}", a WebAssembly module. It is executable code that no ` +
        `reviewer can read, so the package goes to a human for review rather than being ` +
        `refused outright.`,
    };
  }

  return null;
}

/**
 * A shebang is normal in JavaScript and means nothing.
 *
 * Bundlers put `#!/usr/bin/env node` at the top of anything they think might be a
 * CLI, and esbuild will happily do it to a file that is nothing of the sort. A
 * `.js` that starts with `#!` is not evidence of anything — and blocking on it
 * would reject real packages for a banner their build tool wrote. Native binary
 * magic is still checked in these files, because a `.js` that is secretly an ELF
 * is not a bundler quirk.
 */
const SHEBANG_IS_NOISE = new Set([".js", ".mjs", ".cjs"]);

/**
 * Reads what a file actually IS, rather than what its name claims.
 *
 * The extension check is a wall with a door in it: rename `hack.sh` to
 * `readme.txt` and it walks straight through. These signatures cover essentially
 * every way an executable arrives — a shebang, and the three native binary
 * formats — and they come from the first bytes of the file, so the rename buys
 * nothing.
 *
 * Only the first 4 bytes are read. A scan walks up to 2000 files and this must
 * not become "read all of them into memory".
 */
export function sniffExecutable(abs: string, rel = path.basename(abs)): PayloadIssue | null {
  let fd: number | undefined;
  const head = Buffer.alloc(4);

  try {
    fd = fs.openSync(abs, "r");
    const read = fs.readSync(fd, head, 0, 4, 0);
    if (read < 4) return null;
  } catch {
    // A file we cannot open is not a file we can judge. The size and traversal
    // guards in unpackTo already ran; this is not the place to invent an error.
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }

  const ext = path.extname(rel).toLowerCase();
  const kind = binaryKind(head, SHEBANG_IS_NOISE.has(ext));
  if (!kind) return null;

  return {
    severity: "block",
    rule: "executable-content",
    message:
      `"${rel}" is ${kind}, whatever its extension says. A package may not carry an ` +
      `executable — and one hiding behind an innocent file name is worse than one that ` +
      `is not hiding at all.`,
  };
}

function binaryKind(head: Buffer, ignoreShebang: boolean): string | null {
  // #! — a script with an interpreter line.
  if (!ignoreShebang && head[0] === 0x23 && head[1] === 0x21) {
    return "a script with a #! interpreter line";
  }

  // \x7fELF — Linux and most Unix binaries.
  if (head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46) {
    return "an ELF binary";
  }

  // MZ — Windows PE (.exe, .dll).
  if (head[0] === 0x4d && head[1] === 0x5a) return "a Windows executable";

  // Mach-O, in its four flavours (32/64-bit, each byte order), plus the fat
  // binary header that wraps several of them.
  const magic = head.readUInt32BE(0);
  if (
    magic === 0xfeedface || magic === 0xcefaedfe ||
    magic === 0xfeedfacf || magic === 0xcffaedfe ||
    magic === 0xcafebabe || magic === 0xbebafeca
  ) {
    return "a Mach-O binary";
  }

  return null;
}

/**
 * The pack-time gate: refuses the whole build rather than quietly dropping files.
 *
 * Dropping would be the other option — `archive.ts` already silently excludes
 * `.pem` and `node_modules` — but the two cases are not alike. A dropped private
 * key leaves a working package and averts a disaster; a dropped `.mp4` leaves an
 * author with a package that is missing the file they meant to ship and no idea
 * why. Here the author is present, at a terminal, and the useful thing to do is
 * tell them.
 *
 * Every offending file is listed, not just the first: an author who packed a
 * `media/` folder has six of them, and finding out one per `zcms pack` is a
 * miserable way to spend an afternoon.
 */
export function assertPayloadFilesAllowed(dir: string, files: string[]): void {
  const blocking: string[] = [];

  // Which manifest to name in the advice. The directory being packed has exactly
  // one of the two, and telling an author to edit "plugin.json / theme.json" when
  // we are looking straight at their theme.json is the kind of small vagueness
  // that makes a person doubt the tool knows what it is talking about.
  const manifestFile = files.includes("theme.json") ? "theme.json" : "plugin.json";

  for (const rel of files) {
    const issue =
      classifyPayloadFile(rel, manifestFile) ?? sniffExecutable(path.join(dir, rel), rel);
    if (issue?.severity === "block") blocking.push(issue.message);
  }

  if (blocking.length > 0) {
    throw new PackageError(
      blocking.length === 1
        ? blocking[0]!
        : `The package cannot be built — ${blocking.length} files are not allowed in it:\n\n` +
            blocking.map((m) => `— ${m}`).join("\n\n"),
    );
  }
}
