import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "../route";

/**
 * This route is a PUBLIC file server fed an attacker-controlled path. Every test
 * here is the same shape: send the hostile path, prove nothing outside the active
 * theme's verified asset directory is ever returned. A regression that serves one
 * byte of /etc/passwd — or of another theme's private files — is a full read
 * primitive over the box, so these are the load-bearing tests of the app.
 */

let cacheRoot: string;
let themeDir: string;

/** Fabricates a verified bundle on disk: the marker plus one real asset. */
function seedTheme(key: string, version: string, files: Record<string, string>) {
  const safe = (s: string) => s.replace(/[^a-zA-Z0-9._-]/g, "_");
  const dir = path.join(cacheRoot, "theme", safe(key), safe(version));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, ".zcms-verified"), "{}");
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), body);
  }
  return dir;
}

/** Calls the handler the way Next does: params is a promise of the segments. */
function call(segments: string[]) {
  return GET(new Request("http://site.test/theme-assets"), {
    params: Promise.resolve({ path: segments }),
  });
}

beforeEach(() => {
  cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zcms-assets-"));
  vi.stubEnv("THEME_CACHE_DIR", cacheRoot);
  themeDir = seedTheme("vn.zsoft.theme.corp", "1.0.0", {
    "styles.css": "body{color:red}",
    "logo.png": "PNGDATA",
    "favicon.ico": "ICODATA",
  });
});

afterEach(() => {
  fs.rmSync(cacheRoot, { recursive: true, force: true });
});

describe("GET", () => {
  it("serves a legitimate asset of the active theme", async () => {
    const res = await call(["vn.zsoft.theme.corp", "1.0.0", "styles.css"]);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("body{color:red}");
  });

  it("sets content-type from the extension allow-list, not from anything the caller controls", async () => {
    // If the type were echoed/guessable, an attacker-uploaded file served as
    // text/html on the site's own origin is stored XSS. It must be pinned to .css.
    const res = await call(["vn.zsoft.theme.corp", "1.0.0", "styles.css"]);

    expect(res.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect(res.headers.get("content-type")).not.toContain("text/html");
  });

  it("pins image content-types to their extension so a .png can never be served as html", async () => {
    const res = await call(["vn.zsoft.theme.corp", "1.0.0", "logo.png"]);

    expect(res.headers.get("content-type")).toBe("image/png");
  });

  it("serves a theme's own favicon.ico", async () => {
    // A theme owns its favicon, and browsers still ask for one by that extension.
    // Left off the allow-list, every installed theme's favicon is a silent 404 —
    // and a 404 favicon looks like "the CMS ignored my branding", not like a bug.
    const res = await call(["vn.zsoft.theme.corp", "1.0.0", "favicon.ico"]);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ICODATA");
    expect(res.headers.get("content-type")).toBe("image/x-icon");
  });

  it("refuses a file whose extension is not on the allow-list (never serves theme .js to a browser)", async () => {
    // Serving a theme's .js as a script is code the runtime imports, not code a
    // visitor should be handed. Anything off the allow-list is a 404.
    fs.writeFileSync(path.join(themeDir, "evil.js"), "alert(1)");

    const res = await call(["vn.zsoft.theme.corp", "1.0.0", "evil.js"]);

    expect(res.status).toBe(404);
  });

  it("refuses a dot-dot path that escapes into another theme's private files", async () => {
    // Cross-theme read: one site walking out of its own bundle into another's.
    seedTheme("vn.zsoft.theme.other", "1.0.0", { "secret.css": "STOLEN" });

    const res = await call([
      "vn.zsoft.theme.corp",
      "1.0.0",
      "..",
      "..",
      "vn.zsoft.theme.other",
      "1.0.0",
      "secret.css",
    ]);

    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("STOLEN");
  });

  it("refuses a deep ../ traversal aimed at /etc even when the extension is allowed", async () => {
    // classic path traversal: ../../../../etc/passwd, dressed with .css to clear
    // the extension gate. The startsWith(root) check must still reject it.
    const res = await call([
      "vn.zsoft.theme.corp",
      "1.0.0",
      "..",
      "..",
      "..",
      "..",
      "..",
      "..",
      "..",
      "etc",
      "passwd.css",
    ]);

    expect(res.status).toBe(404);
  });

  it("refuses an absolute path that would reset resolution outside the bundle", async () => {
    // An absolute segment makes path.resolve discard the bundle root entirely.
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "zcms-outside-"));
    fs.writeFileSync(path.join(outside, "evil.css"), "OUTSIDE");
    try {
      const res = await call([
        "vn.zsoft.theme.corp",
        "1.0.0",
        path.join(outside, "evil.css"),
      ]);

      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain("OUTSIDE");
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("does not decode a URL-encoded traversal into real slashes", async () => {
    // %2e%2e%2f arriving as a literal segment must stay a filename, not become ../
    const res = await call([
      "vn.zsoft.theme.corp",
      "1.0.0",
      "..%2f..%2fsecret.css",
    ]);

    expect(res.status).toBe(404);
  });

  it("treats a backslash segment as a filename, not a Windows path separator", async () => {
    const res = await call([
      "vn.zsoft.theme.corp",
      "1.0.0",
      "..\\..\\secret.css",
    ]);

    expect(res.status).toBe(404);
  });

  // Arbitrary-file-read via a symlink that lives INSIDE the verified bundle and
  // points at /etc/passwd. Resolving the target by name keeps it inside root, so
  // a lexical startsWith check passes and the link is followed. The route now
  // realpath()s the target as well and re-checks it is inside root, so the read
  // is refused. The packing layer already refuses to include a link, so a link
  // here means a tampered cache — the file server must not be its only defence.
  it("does not serve a file through a symlink that points out of the bundle", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "zcms-secret-"));
    const secret = path.join(outside, "passwd");
    fs.writeFileSync(secret, "root:x:0:0");
    fs.symlinkSync(secret, path.join(themeDir, "link.css"));
    try {
      const res = await call(["vn.zsoft.theme.corp", "1.0.0", "link.css"]);

      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain("root:x:0:0");
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("does not read a path containing a NUL byte", async () => {
    // A NUL byte is a classic way to confuse a downstream C string check. It must
    // never reach the filesystem as a readable path; a refusal (or a caught
    // failure) is fine, serving bytes is not.
    let served = "";
    try {
      const res = await call(["vn.zsoft.theme.corp", "1.0.0", "styles\0.css"]);
      served = await res.text();
    } catch {
      // A thrown request is still a non-serve, which is all this test cares about.
    }
    expect(served).not.toBe("body{color:red}");
  });

  it("refuses when the bundle directory is not marked verified", async () => {
    // Without the .zcms-verified marker the bytes have not passed a signature
    // check; serving them would be serving unverified code's assets.
    const dir = path.join(cacheRoot, "theme", "vn.zsoft.theme.unverified", "1.0.0");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "styles.css"), "body{}");

    const res = await call(["vn.zsoft.theme.unverified", "1.0.0", "styles.css"]);

    expect(res.status).toBe(404);
  });

  it("refuses a request missing the key, version or filename", async () => {
    expect((await call(["only-key"])).status).toBe(404);
    expect((await call(["key", "1.0.0"])).status).toBe(404);
  });
});
