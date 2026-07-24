import fs from "node:fs";
import path from "node:path";
import { PackageError, type PackageManifest } from "./types";

/**
 * Screenshots and a preview video for a theme or a plugin.
 *
 * A package that shows you nothing is a package nobody installs, so the format
 * has a place for pictures. What it does NOT have is a place for arbitrary bytes:
 * these images are served to a browser, from an origin that also serves the
 * admin, on the say-so of a stranger who published a package. Every rule below is
 * there because of what happens when one is missing.
 *
 * The images live INSIDE the signed package. That is the whole point: they are
 * covered by the publisher's signature and the marketplace's counter-signature,
 * exactly like the code. Nobody can swap the screenshot of a package without
 * breaking a signature — which is not true of a marketplace that stores its
 * pictures in a bucket beside the code.
 *
 * The video does NOT live in the package: it is a URL to somewhere that already
 * does video (YouTube, Vimeo). A thirty-second clip would eat the entire package
 * budget, and every install of that package would pay to download a video that
 * almost nobody watches.
 */

/** Three. A gallery, not a photo album — and it is what the admin renders. */
export const MAX_SCREENSHOTS = 3;

/** 2 MB each: 3 × 2 MB is 6 MB, which fits inside the package budget with room. */
export const MAX_SCREENSHOT_BYTES = 2 * 1024 * 1024;

/**
 * Raster only, and deliberately no SVG.
 *
 * An SVG is not a picture, it is a document — it can carry <script>, and a
 * browser will run it. Serving a stranger's SVG from the marketplace's own origin
 * (or the admin's) is cross-site scripting with extra steps, and no amount of
 * sanitising an image you did not author is worth the alternative of just saying
 * no. GIF is out too: an animated screenshot is a video that dodged the rule.
 */
export const SCREENSHOT_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp"] as const;

/**
 * A 2 MB PNG can decode to a billion pixels — the bytes are compressed, the
 * pixels are not. The browser that opens the lightbox is the one that pays for
 * that, so the pixel count is bounded as well as the file size.
 */
export const MAX_SCREENSHOT_DIMENSION = 4096;

/** Only real video hosts. A "video URL" pointing at javascript: is not a video. */
const VIDEO_URL = /^https:\/\/[^\s]+$/i;

export interface PackageMedia {
  /** Paths inside the package, at most MAX_SCREENSHOTS of them. */
  screenshots: string[];
  /** An https URL to an external video, or null. Never a packaged file. */
  video: string | null;
}

export const EMPTY_MEDIA: PackageMedia = { screenshots: [], video: null };

/**
 * Reads `media` off a manifest without trusting a byte of it.
 *
 * Tolerant on purpose: a manifest is JSON that someone else wrote, and a package
 * whose media block is malformed should list no screenshots — not fail to install.
 * The strict half is `validateMedia`, which runs when the package is BUILT and
 * again when it is PUBLISHED, and which refuses rather than shrugs.
 */
export function readPackageMedia(manifest: unknown): PackageMedia {
  const media = (manifest as { media?: unknown } | null | undefined)?.media as
    | { screenshots?: unknown; video?: unknown }
    | undefined;

  if (!media || typeof media !== "object") return EMPTY_MEDIA;

  const screenshots = Array.isArray(media.screenshots)
    ? media.screenshots
        .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
        .slice(0, MAX_SCREENSHOTS)
    : [];

  const video =
    typeof media.video === "string" && VIDEO_URL.test(media.video.trim())
      ? media.video.trim()
      : null;

  return { screenshots, video };
}

/**
 * A screenshot path is a name, not a route.
 *
 * It is joined onto a directory on the packer's disk and, later, onto a storage
 * key on the marketplace's. "../../.ssh/id_rsa" must not be either of those, and
 * neither must "/etc/passwd" — so the path is required to be a plain relative
 * path that stays inside the package.
 */
function assertSafePath(rel: string): void {
  if (path.isAbsolute(rel) || rel.startsWith("/") || /^[a-z]:/i.test(rel)) {
    throw new PackageError(`Screenshot "${rel}" must be a relative path inside the package.`);
  }
  const normalised = path.normalize(rel);
  if (normalised.startsWith("..") || normalised.split(path.sep).includes("..")) {
    throw new PackageError(`Screenshot "${rel}" must not point outside the package.`);
  }
}

/** PNG, JPEG and WebP all announce their size in the first few bytes. Read it. */
export function imageDimensions(
  buf: Buffer,
): { width: number; height: number } | null {
  // PNG: an 8-byte signature, then the IHDR chunk, whose first two fields are
  // width and height as big-endian uint32.
  if (buf.length >= 24 && buf.toString("ascii", 1, 4) === "PNG") {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }

  // WebP: "RIFF" .... "WEBP", then a chunk whose type says how to read the size.
  if (
    buf.length >= 30 &&
    buf.toString("ascii", 0, 4) === "RIFF" &&
    buf.toString("ascii", 8, 12) === "WEBP"
  ) {
    const type = buf.toString("ascii", 12, 16);
    if (type === "VP8X") {
      // 24-bit little-endian, and stored as (size - 1).
      const width = 1 + (buf.readUIntLE(24, 3) & 0xffffff);
      const height = 1 + (buf.readUIntLE(27, 3) & 0xffffff);
      return { width, height };
    }
    if (type === "VP8 ") {
      return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    }
    if (type === "VP8L") {
      const bits = buf.readUInt32LE(21);
      return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
    }
    return null;
  }

  // JPEG: walk the segment chain to a Start-Of-Frame marker, which carries the
  // dimensions. There is no fixed offset — the file is a list of segments, and
  // how many come before SOF depends on what the encoder wrote.
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buf.length) {
      if (buf[offset] !== 0xff) {
        offset++;
        continue;
      }
      const marker = buf[offset + 1]!;

      // SOF0..SOF15, minus the markers in that range that are not frame headers.
      const isSof =
        marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) {
        return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
      }

      const length = buf.readUInt16BE(offset + 2);
      // A zero/garbage length would spin this loop forever on a hostile file.
      if (length < 2) return null;
      offset += 2 + length;
    }
  }

  return null;
}

/**
 * Where the marketplace keeps a screenshot it extracted from a package.
 *
 * The path inside the package is flattened to its basename on purpose. It becomes
 * part of a URL and a storage key, and "screenshots/1.png" and "a/b/../1.png" are
 * the same picture — but only one of them is a path this wants to reason about.
 * The index keeps two files called "1.png" in different folders from colliding.
 */
export function screenshotStorageKey(
  kind: string,
  id: string,
  version: string,
  index: number,
  screenshotPath: string,
): string {
  const safe = (s: string) => s.replace(/[^a-zA-Z0-9._-]/g, "_");
  const ext = path.extname(screenshotPath).toLowerCase();
  return `media/${safe(kind)}/${safe(id)}/${safe(version)}/${index}${safe(ext)}`;
}

/** An image is served as the type its extension claims, never as anything else. */
export const SCREENSHOT_CONTENT_TYPE: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

/**
 * Enforces the rules against the files actually on disk.
 *
 * Called when a package is BUILT (so an author finds out at `zcms pack`, not from
 * a reviewer) and again when it is PUBLISHED — because the marketplace does not
 * trust that the thing it was handed was built by our packer.
 */
export function validateMedia(dir: string, manifest: PackageManifest): void {
  const declared = (manifest as { media?: { screenshots?: unknown; video?: unknown } }).media;
  if (!declared) return;

  const raw = declared.screenshots;
  if (raw !== undefined && !Array.isArray(raw)) {
    throw new PackageError("media.screenshots must be an array of paths.");
  }

  const screenshots = (raw ?? []) as unknown[];
  if (screenshots.length > MAX_SCREENSHOTS) {
    throw new PackageError(
      `A package may declare at most ${MAX_SCREENSHOTS} screenshots (found ${screenshots.length}).`,
    );
  }

  for (const entry of screenshots) {
    if (typeof entry !== "string" || !entry.trim()) {
      throw new PackageError("Every entry in media.screenshots must be a non-empty path.");
    }
    assertSafePath(entry);

    const ext = path.extname(entry).toLowerCase();
    if (!(SCREENSHOT_EXTENSIONS as readonly string[]).includes(ext)) {
      throw new PackageError(
        `Screenshot "${entry}" must be one of ${SCREENSHOT_EXTENSIONS.join(", ")} — not "${ext || "(none)"}". ` +
          "SVG is refused on purpose: it can carry script, and it is served to a browser.",
      );
    }

    const full = path.join(dir, entry);
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
      throw new PackageError(
        `Screenshot "${entry}" is declared in the manifest but is not in the package.`,
      );
    }

    const { size } = fs.statSync(full);
    if (size > MAX_SCREENSHOT_BYTES) {
      throw new PackageError(
        `Screenshot "${entry}" is ${(size / 1024 / 1024).toFixed(1)}MB — the limit is ` +
          `${MAX_SCREENSHOT_BYTES / 1024 / 1024}MB.`,
      );
    }

    const dimensions = imageDimensions(fs.readFileSync(full));
    if (!dimensions) {
      throw new PackageError(
        `Screenshot "${entry}" is not a readable ${SCREENSHOT_EXTENSIONS.join("/")} image. ` +
          "A file with the right extension is not the same as a file with the right contents.",
      );
    }
    if (
      dimensions.width > MAX_SCREENSHOT_DIMENSION ||
      dimensions.height > MAX_SCREENSHOT_DIMENSION
    ) {
      throw new PackageError(
        `Screenshot "${entry}" is ${dimensions.width}×${dimensions.height}px — the limit is ` +
          `${MAX_SCREENSHOT_DIMENSION}px on a side. Compressed bytes are not the same as pixels: ` +
          "the browser that opens it has to decode every one of them.",
      );
    }
  }

  const video = declared.video;
  if (video !== undefined && video !== null && video !== "") {
    if (typeof video !== "string" || !VIDEO_URL.test(video.trim())) {
      throw new PackageError(
        "media.video must be an https:// URL to an external video (YouTube, Vimeo, …). " +
          "Video files are not packaged: they would dwarf the code and every install would pay for them.",
      );
    }
  }
}
