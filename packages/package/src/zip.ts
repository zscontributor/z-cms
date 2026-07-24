import fs from "node:fs";
import path from "node:path";
import yauzl from "yauzl";
import { PackageError } from "./types";

/**
 * A hardened ZIP extractor — the one place a raw .zip an operator uploaded is opened.
 *
 * A ZIP is a far nastier input than the tar.gz that `unpackTo` handles, and this
 * reader exists only because sideloading lets an operator hand cms-api a zip to pack
 * and sign on their behalf. Everything it does is about not trusting that zip:
 *
 *   - It reads names, sizes and modes from the CENTRAL DIRECTORY (what yauzl does by
 *     default), not the per-entry local headers, which a hostile archive can make
 *     disagree with it — the classic zip smuggling trick.
 *   - It refuses symlinks and device/fifo/socket entries, which a ZIP encodes in the
 *     Unix mode bits of `externalFileAttributes` rather than as a distinct type the
 *     way tar does — so a reader that only checks "is it a file?" would let one
 *     through. This is the ZIP-shaped version of the link check in `unpackTo`.
 *   - It counts ACTUAL decompressed bytes and stops at a cap, so a declared size in
 *     the header cannot be trusted and a compression bomb cannot run the disk out.
 *   - It resolves every path against the real destination and refuses anything that
 *     escapes it, plus absolute paths, drive letters, backslashes and NUL bytes.
 *   - It writes every file mode 0o644 — never executable, whatever the archive said.
 *
 * The result is a plain directory tree the caller then packs into a .zcms with the
 * normal, allow-listed packer. No zip byte travels any further into the system.
 */

const MAX_UNPACKED_BYTES = 50 * 1024 * 1024;
const MAX_ENTRIES = 2000;

// Unix st_mode masks, as they sit in the high 16 bits of externalFileAttributes.
const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;
const S_ISUID = 0o004000;
const S_ISGID = 0o002000;

/** ZIP host-system code (versionMadeBy >> 8) for Unix, where the mode bits are meaningful. */
const HOST_UNIX = 3;

/**
 * Extracts `zip` into `dest`, safely. Returns the relative paths written.
 *
 * Throws PackageError on the first violation; the destination is the caller's to
 * clean up (it is always a fresh temp dir at the one call site).
 */
export async function unzipToDir(zip: Buffer, dest: string): Promise<string[]> {
  fs.mkdirSync(dest, { recursive: true });
  const root = fs.realpathSync(dest);

  const written: string[] = [];
  const seen = new Set<string>();
  let totalBytes = 0;
  let entries = 0;

  const zipfile = await openZip(zip);

  return await new Promise<string[]>((resolve, reject) => {
    const fail = (err: Error) => {
      zipfile.close();
      reject(err instanceof PackageError ? err : new PackageError(err.message));
    };

    zipfile.on("error", fail);
    zipfile.on("end", () => resolve(written));

    zipfile.on("entry", (entry: yauzl.Entry) => {
      void (async () => {
        try {
          if (++entries > MAX_ENTRIES) {
            throw new PackageError(`Archive has too many entries (> ${MAX_ENTRIES}).`);
          }

          const name = entry.fileName;

          if (name.includes("\0")) {
            throw new PackageError(`Archive entry name contains a NUL byte.`);
          }
          // Backslash is a Windows separator; normalising it away first would let
          // "..\\.." slip past the traversal check on a POSIX host.
          if (name.includes("\\")) {
            throw new PackageError(`Archive entry "${name}" contains a backslash.`);
          }
          if (path.isAbsolute(name) || name.startsWith("/") || /^[a-zA-Z]:/.test(name)) {
            throw new PackageError(`Absolute path in archive: "${name}".`);
          }

          const isDir = name.endsWith("/");
          const rel = isDir ? name.slice(0, -1) : name;

          const target = path.resolve(root, rel);
          if (target !== root && !target.startsWith(root + path.sep)) {
            throw new PackageError(
              `Path traversal in archive: "${name}" escapes the destination directory.`,
            );
          }

          // Mode bits live in the top 16 bits of externalFileAttributes, but only
          // when the archive was made on a Unix host. On any other host they are not
          // mode bits and must not be read as such — a regular file is assumed.
          const madeOnUnix = entry.versionMadeBy >> 8 === HOST_UNIX;
          const mode = madeOnUnix ? (entry.externalFileAttributes >>> 16) & 0xffff : S_IFREG;
          const fmt = mode & S_IFMT;

          if (madeOnUnix && (mode & (S_ISUID | S_ISGID)) !== 0) {
            throw new PackageError(`Archive entry "${name}" is setuid/setgid.`);
          }
          if (fmt === S_IFLNK) {
            throw new PackageError(
              `Archive contains a symlink ("${name}"). Links are not allowed — one can point outside the archive.`,
            );
          }
          if (madeOnUnix && fmt !== 0 && fmt !== S_IFREG && fmt !== S_IFDIR) {
            throw new PackageError(
              `Archive contains a special file ("${name}"). Only regular files and directories are allowed.`,
            );
          }

          if (isDir) {
            fs.mkdirSync(target, { recursive: true });
            zipfile.readEntry();
            return;
          }

          if (seen.has(target)) {
            throw new PackageError(`Archive contains a duplicate entry: "${name}".`);
          }
          seen.add(target);

          // Reject on the DECLARED size before decompressing, then again on the real
          // decompressed byte count below — the header may lie, so both are enforced.
          if (entry.uncompressedSize > MAX_UNPACKED_BYTES) {
            throw new PackageError(
              `Archive entry "${name}" declares more than ${MAX_UNPACKED_BYTES / 1024 / 1024}MB.`,
            );
          }

          fs.mkdirSync(path.dirname(target), { recursive: true });
          await writeEntry(zipfile, entry, target, (n) => {
            totalBytes += n;
            if (totalBytes > MAX_UNPACKED_BYTES) {
              throw new PackageError(
                `Archive unpacks to more than ${MAX_UNPACKED_BYTES / 1024 / 1024}MB (suspected decompression bomb).`,
              );
            }
          });

          written.push(rel);
          zipfile.readEntry();
        } catch (err) {
          fail(err as Error);
        }
      })();
    });

    zipfile.readEntry();
  });
}

/** Opens a zip from a buffer, reading the central directory. lazyEntries so we drive the walk. */
function openZip(zip: Buffer): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    // decodeStrings validates and decodes file names (rejecting malformed UTF-8);
    // lazyEntries lets us readEntry() one at a time so a bomb cannot be buffered
    // all at once; validateEntrySizes makes yauzl itself error if a stream's real
    // length disagrees with the central-directory size.
    yauzl.fromBuffer(
      zip,
      { lazyEntries: true, decodeStrings: true, validateEntrySizes: true },
      (err, zipfile) => {
        if (err || !zipfile) {
          reject(new PackageError(`Not a readable ZIP archive: ${err?.message ?? "unknown"}`));
          return;
        }
        resolve(zipfile);
      },
    );
  });
}

/** Streams one entry to disk mode 0o644, calling `onBytes` per chunk so the caller can cap. */
function writeEntry(
  zipfile: yauzl.ZipFile,
  entry: yauzl.Entry,
  target: string,
  onBytes: (n: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    zipfile.openReadStream(entry, (err, stream) => {
      if (err || !stream) {
        reject(new PackageError(`Could not read archive entry "${entry.fileName}".`));
        return;
      }
      const out = fs.createWriteStream(target, { mode: 0o644 });
      let failed = false;
      const bail = (e: Error) => {
        if (failed) return;
        failed = true;
        stream.destroy();
        out.destroy();
        reject(e instanceof PackageError ? e : new PackageError(e.message));
      };
      stream.on("data", (chunk: Buffer) => {
        try {
          onBytes(chunk.length);
        } catch (e) {
          bail(e as Error);
        }
      });
      stream.on("error", bail);
      out.on("error", bail);
      out.on("finish", () => {
        if (!failed) resolve();
      });
      stream.pipe(out);
    });
  });
}

/** True if the bytes look like a ZIP (local file header "PK\x03\x04"), not a gzip/.zcms. */
export function looksLikeZip(buf: Buffer): boolean {
  return buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;
}
