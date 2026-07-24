import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { crc32 } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { looksLikeZip, unzipToDir } from "../zip";
import { PackageError } from "../types";

/**
 * A hand-rolled ZIP builder, so a test can forge the exact hostile archive a real
 * attacker would — a traversal name, a symlink mode, a lying size — none of which a
 * well-behaved zip writer will produce for you. STORED entries only (method 0): the
 * reader's job is not decompression correctness, it is refusing what must be refused.
 */
interface ZipEntry {
  name: string;
  data?: Buffer;
  /** Unix st_mode to stamp into external attrs (implies "made on Unix"). */
  unixMode?: number;
  /** Override the uncompressed size written to the headers (to forge a lie). */
  declaredSize?: number;
  dir?: boolean;
}

function u16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n & 0xffff, 0);
  return b;
}
function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0, 0);
  return b;
}

function makeZip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const e of entries) {
    const nameBuf = Buffer.from(e.dir && !e.name.endsWith("/") ? `${e.name}/` : e.name, "utf8");
    const data = e.data ?? Buffer.alloc(0);
    const crc = crc32(data) >>> 0;
    const size = e.declaredSize ?? data.length;

    const local = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(crc), u32(data.length), u32(size), u16(nameBuf.length), u16(0),
      nameBuf, data,
    ]);
    locals.push(local);

    const madeByUnix = e.unixMode !== undefined;
    const versionMadeBy = madeByUnix ? (3 << 8) | 20 : 20;
    const externalAttrs = madeByUnix ? (e.unixMode! << 16) >>> 0 : 0;

    centrals.push(
      Buffer.concat([
        u32(0x02014b50), u16(versionMadeBy), u16(20), u16(0), u16(0), u16(0), u16(0),
        u32(crc), u32(data.length), u32(size), u16(nameBuf.length),
        u16(0), u16(0), u16(0), u16(0), u32(externalAttrs), u32(offset),
        nameBuf,
      ]),
    );
    offset += local.length;
  }

  const cd = Buffer.concat(centrals);
  const eocd = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length),
    u32(cd.length), u32(offset), u16(0),
  ]);

  return Buffer.concat([...locals, cd, eocd]);
}

const S_IFREG = 0o100644;
const S_IFLNK = 0o120777;
const S_IFIFO = 0o010644;

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "zip-test-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("unzipToDir — the happy path", () => {
  it("extracts a normal archive, writing files mode 0644", async () => {
    const zip = makeZip([
      { name: "theme.json", data: Buffer.from("{}"), unixMode: S_IFREG },
      { name: "dist/", dir: true, unixMode: 0o040755 },
      { name: "dist/index.js", data: Buffer.from("export default {}"), unixMode: S_IFREG },
    ]);

    const written = await unzipToDir(zip, tmp);

    expect(written.sort()).toEqual(["dist/index.js", "theme.json"]);
    expect(fs.readFileSync(path.join(tmp, "dist/index.js"), "utf8")).toBe("export default {}");
    // Never executable, whatever the archive claimed.
    expect(fs.statSync(path.join(tmp, "dist/index.js")).mode & 0o777).toBe(0o644);
  });
});

describe("unzipToDir — refuses hostile archives", () => {
  it("rejects a path-traversal entry", async () => {
    // Refused as a PackageError — whether by yauzl's own relative-path guard or the
    // resolve-against-root backstop, the entry never lands. Both layers exist.
    const zip = makeZip([{ name: "../escape.js", data: Buffer.from("x") }]);
    await expect(unzipToDir(zip, tmp)).rejects.toThrow(PackageError);
    expect(fs.existsSync(path.join(path.dirname(tmp), "escape.js"))).toBe(false);
  });

  it("rejects a deeper traversal that resolves outside", async () => {
    const zip = makeZip([{ name: "a/b/../../../evil.js", data: Buffer.from("x") }]);
    await expect(unzipToDir(zip, tmp)).rejects.toThrow(PackageError);
    expect(fs.existsSync(path.join(path.dirname(tmp), "evil.js"))).toBe(false);
  });

  it("rejects an absolute path", async () => {
    const zip = makeZip([{ name: "/etc/passwd", data: Buffer.from("x") }]);
    await expect(unzipToDir(zip, tmp)).rejects.toThrow(/absolute/i);
  });

  it("rejects a Windows drive-letter path", async () => {
    const zip = makeZip([{ name: "C:/windows/x", data: Buffer.from("x") }]);
    await expect(unzipToDir(zip, tmp)).rejects.toThrow(/absolute/i);
  });

  it("rejects a backslash before it can be normalised into a traversal", async () => {
    // yauzl normalises backslash to slash and then rejects the resulting `..`; the
    // manual backslash check is the backstop for a name yauzl's guard did not catch.
    const zip = makeZip([{ name: "..\\..\\evil.js", data: Buffer.from("x") }]);
    await expect(unzipToDir(zip, tmp)).rejects.toThrow(PackageError);
    expect(fs.existsSync(path.join(path.dirname(tmp), "evil.js"))).toBe(false);
  });

  it("rejects a symlink encoded in the Unix mode bits", async () => {
    // THE ZIP-SPECIFIC ATTACK: tar flags a symlink as a type; a ZIP hides it in
    // externalFileAttributes. A reader that only asks "is it a file?" is fooled.
    const zip = makeZip([{ name: "link", data: Buffer.from("/etc/passwd"), unixMode: S_IFLNK }]);
    await expect(unzipToDir(zip, tmp)).rejects.toThrow(/symlink|link/i);
  });

  it("rejects a fifo / special file", async () => {
    const zip = makeZip([{ name: "pipe", unixMode: S_IFIFO }]);
    await expect(unzipToDir(zip, tmp)).rejects.toThrow(/special/i);
  });

  it("rejects a setuid entry", async () => {
    const zip = makeZip([{ name: "x", data: Buffer.from("x"), unixMode: 0o104755 }]);
    await expect(unzipToDir(zip, tmp)).rejects.toThrow(/setuid|setgid/i);
  });

  it("rejects a duplicate entry name", async () => {
    const zip = makeZip([
      { name: "dup.js", data: Buffer.from("a"), unixMode: S_IFREG },
      { name: "dup.js", data: Buffer.from("b"), unixMode: S_IFREG },
    ]);
    await expect(unzipToDir(zip, tmp)).rejects.toThrow(/duplicate/i);
  });

  it("rejects an entry that declares a size over the cap (bomb, by header)", async () => {
    const zip = makeZip([
      { name: "big", data: Buffer.from("small"), declaredSize: 60 * 1024 * 1024, unixMode: S_IFREG },
    ]);
    // yauzl validates the stream length against the declared size, and the declared
    // size is over the cap — either way it is refused before it can fill the disk.
    await expect(unzipToDir(zip, tmp)).rejects.toThrow(PackageError);
  });

  it("rejects an archive with more entries than the limit", async () => {
    const many: ZipEntry[] = Array.from({ length: 2001 }, (_, i) => ({
      name: `f${i}.txt`,
      data: Buffer.from("x"),
      unixMode: S_IFREG,
    }));
    await expect(unzipToDir(makeZip(many), tmp)).rejects.toThrow(/too many entries/i);
  });

  it("rejects a NUL byte in the entry name", async () => {
    const zip = makeZip([{ name: "a\0b.js", data: Buffer.from("x") }]);
    await expect(unzipToDir(zip, tmp)).rejects.toThrow(PackageError);
  });

  it("rejects bytes that are not a ZIP at all", async () => {
    await expect(unzipToDir(Buffer.from("not a zip"), tmp)).rejects.toThrow(PackageError);
  });
});

describe("looksLikeZip", () => {
  it("recognises the ZIP local-header magic and rejects gzip", () => {
    expect(looksLikeZip(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]))).toBe(true);
    // A .zcms is gzip: 0x1f 0x8b.
    expect(looksLikeZip(Buffer.from([0x1f, 0x8b, 0x08, 0x00]))).toBe(false);
    expect(looksLikeZip(Buffer.from([0x50]))).toBe(false);
  });
});
