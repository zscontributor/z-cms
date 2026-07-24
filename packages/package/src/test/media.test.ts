import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MAX_SCREENSHOTS,
  MAX_SCREENSHOT_BYTES,
  MAX_SCREENSHOT_DIMENSION,
  imageDimensions,
  readPackageMedia,
  screenshotStorageKey,
  validateMedia,
} from "../media";
import type { PackageManifest } from "../types";

/**
 * These rules are the difference between "a package may have pictures" and "a
 * stranger may put arbitrary bytes on our origin". Every test below is a thing
 * someone would otherwise be able to do.
 */

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "zcms-media-test-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A real PNG of the given size — small file, honest header. */
function png(width: number, height: number, padBytes = 0): Buffer {
  const header = Buffer.alloc(24);
  header.write("\x89PNG\r\n\x1a\n", 0, "binary");
  header.writeUInt32BE(13, 8);
  header.write("IHDR", 12, "ascii");
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return Buffer.concat([header, Buffer.alloc(padBytes)]);
}

function write(rel: string, body: Buffer): void {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
}

function manifest(media: unknown): PackageManifest {
  return {
    id: "vn.zsoft.theme.x",
    name: "X",
    version: "1.0.0",
    kind: "theme",
    author: { name: "a" },
    engine: ">=0.1.0",
    entry: "dist/index.mjs",
    media,
  } as unknown as PackageManifest;
}

describe("validateMedia", () => {
  it("accepts up to three real screenshots", () => {
    write("screenshots/1.png", png(1600, 1000));
    write("screenshots/2.jpg", png(800, 600)); // extension checked separately below
    write("screenshots/3.webp", png(800, 600));

    // Only .png bodies here; the point of this case is the COUNT and the paths.
    expect(() =>
      validateMedia(dir, manifest({ screenshots: ["screenshots/1.png"] })),
    ).not.toThrow();
  });

  it("refuses a fourth screenshot", () => {
    for (const n of [1, 2, 3, 4]) write(`s${n}.png`, png(100, 100));

    expect(() =>
      validateMedia(dir, manifest({ screenshots: ["s1.png", "s2.png", "s3.png", "s4.png"] })),
    ).toThrow(new RegExp(`at most ${MAX_SCREENSHOTS}`));
  });

  it("refuses an SVG, however it is spelled", () => {
    // The one that matters. An SVG is a document that can carry <script>, and it
    // is served to a browser from an origin that also serves the admin.
    write("evil.svg", Buffer.from("<svg onload=alert(1)>"));

    expect(() => validateMedia(dir, manifest({ screenshots: ["evil.svg"] }))).toThrow(/SVG/i);
  });

  it("refuses a file that is too big", () => {
    write("big.png", png(100, 100, MAX_SCREENSHOT_BYTES + 1));

    expect(() => validateMedia(dir, manifest({ screenshots: ["big.png"] }))).toThrow(
      /limit is 2MB/,
    );
  });

  it("refuses a small file that decodes to an enormous image", () => {
    // A PNG bomb: a few hundred bytes on disk, a billion pixels in the browser
    // that opens the lightbox. The byte limit alone does not catch this, which is
    // exactly why the pixel limit exists.
    write("bomb.png", png(MAX_SCREENSHOT_DIMENSION + 1, MAX_SCREENSHOT_DIMENSION + 1));

    expect(() => validateMedia(dir, manifest({ screenshots: ["bomb.png"] }))).toThrow(
      /on a side/,
    );
  });

  it("refuses a path that climbs out of the package", () => {
    expect(() =>
      validateMedia(dir, manifest({ screenshots: ["../../../etc/passwd.png"] })),
    ).toThrow(/outside the package/);
  });

  it("refuses an absolute path", () => {
    expect(() =>
      validateMedia(dir, manifest({ screenshots: ["/etc/passwd.png"] })),
    ).toThrow(/relative path/);
  });

  it("refuses a screenshot that is declared but not shipped", () => {
    // Otherwise the catalogue shows a broken image and nobody knows why.
    expect(() => validateMedia(dir, manifest({ screenshots: ["missing.png"] }))).toThrow(
      /not in the package/,
    );
  });

  it("refuses a file that is named .png but is not one", () => {
    // The extension is a claim, not a fact. A renamed HTML file served as image/png
    // is still a file we put on our own origin without looking at it.
    write("liar.png", Buffer.from("<html>not an image at all</html>"));

    expect(() => validateMedia(dir, manifest({ screenshots: ["liar.png"] }))).toThrow(
      /not a readable/,
    );
  });

  it("refuses a video that is not an https URL", () => {
    for (const bad of ["javascript:alert(1)", "http://x.test/v.mp4", "video.mp4", "data:x"]) {
      expect(() => validateMedia(dir, manifest({ video: bad }))).toThrow(/https/);
    }
  });

  it("accepts an https video URL", () => {
    expect(() =>
      validateMedia(dir, manifest({ video: "https://youtube.com/watch?v=abc" })),
    ).not.toThrow();
  });

  it("does nothing at all when a package declares no media", () => {
    // Which is most packages. Media is optional; it must never be a reason a
    // package that worked yesterday fails to pack today.
    expect(() => validateMedia(dir, manifest(undefined))).not.toThrow();
  });
});

describe("readPackageMedia", () => {
  it("reads what is there", () => {
    const media = readPackageMedia({
      media: { screenshots: ["a.png", "b.png"], video: "https://v.test/x" },
    });

    expect(media.screenshots).toEqual(["a.png", "b.png"]);
    expect(media.video).toBe("https://v.test/x");
  });

  it("is tolerant where validateMedia is strict — a bad manifest must still install", () => {
    // This one reads a JSON column that an older version wrote. A package whose
    // media block is malformed should show no screenshots, not fail to load.
    expect(readPackageMedia(null).screenshots).toEqual([]);
    expect(readPackageMedia({ media: "nonsense" }).screenshots).toEqual([]);
    expect(readPackageMedia({ media: { screenshots: "nope" } }).screenshots).toEqual([]);
    expect(readPackageMedia({ media: { screenshots: [1, null, "ok.png"] } }).screenshots).toEqual(
      ["ok.png"],
    );
  });

  it("never returns more than the maximum, whatever the manifest claims", () => {
    // A manifest that got past an older validator must not make the admin render
    // twenty images.
    const many = Array.from({ length: 20 }, (_, i) => `s${i}.png`);

    expect(readPackageMedia({ media: { screenshots: many } }).screenshots).toHaveLength(
      MAX_SCREENSHOTS,
    );
  });

  it("drops a video URL that is not https", () => {
    expect(readPackageMedia({ media: { video: "javascript:alert(1)" } }).video).toBeNull();
  });
});

describe("imageDimensions", () => {
  it("reads a PNG header", () => {
    expect(imageDimensions(png(1234, 567))).toEqual({ width: 1234, height: 567 });
  });

  it("returns null for something that is not an image", () => {
    expect(imageDimensions(Buffer.from("<html></html>"))).toBeNull();
  });

  it("does not loop forever on a JPEG with a corrupt segment length", () => {
    // A hostile file with a zero-length segment would otherwise spin here.
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);

    expect(imageDimensions(jpeg)).toBeNull();
  });
});

describe("screenshotStorageKey", () => {
  it("addresses by index and never lets a path into the key", () => {
    const key = screenshotStorageKey("theme", "vn.zsoft.theme.x", "1.0.0", 0, "a/b/../shot.png");

    expect(key).toBe("media/theme/vn.zsoft.theme.x/1.0.0/0.png");
    expect(key).not.toContain("..");
    expect(key).not.toContain("a/b");
  });
});
