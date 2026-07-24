import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The runtime side of the marketplace kill switch. cms-api calls it to revoke a
 * theme version: drop it from memory and delete its verified cache so the next
 * load is a real (refused) load. It is publicly reachable, so an unauthenticated
 * caller must get nowhere near forgetTheme() or the filesystem — otherwise it is
 * another free cache-thrash DoS.
 */

const forgetTheme = vi.fn();
vi.mock("@/lib/theme-loader", () => ({
  forgetTheme: (...args: unknown[]) => forgetTheme(...args),
}));

import { POST } from "../route";

const TOKEN = "s3cret-internal-token";
let cacheRoot: string;

function post(body: unknown, token: string | null = TOKEN) {
  return POST(
    new Request("http://site.test/api/purge-package", {
      method: "POST",
      headers: token === null ? {} : { "x-internal-token": token },
      body: JSON.stringify(body),
    }),
  );
}

/** Seeds a verified-bundle directory the way the loader would have written it. */
function seedBundle(key: string, version: string) {
  const safe = (s: string) => s.replace(/[^a-zA-Z0-9._-]/g, "_");
  const dir = path.join(cacheRoot, "theme", safe(key), safe(version));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, ".zcms-verified"), "{}");
  return dir;
}

beforeEach(() => {
  forgetTheme.mockClear();
  cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zcms-purge-"));
  vi.stubEnv("THEME_CACHE_DIR", cacheRoot);
  vi.stubEnv("CMS_INTERNAL_TOKEN", TOKEN);
});

afterEach(() => {
  fs.rmSync(cacheRoot, { recursive: true, force: true });
});

describe("POST", () => {
  it("refuses a request with no internal token", async () => {
    const res = await post({ key: "vn.zsoft.theme.corp", version: "1.0.0" }, null);

    expect(res.status).toBe(401);
    expect(forgetTheme).not.toHaveBeenCalled();
  });

  it("refuses a request whose token is wrong", async () => {
    const res = await post(
      { key: "vn.zsoft.theme.corp", version: "1.0.0" },
      "not-the-token",
    );

    expect(res.status).toBe(401);
    expect(forgetTheme).not.toHaveBeenCalled();
  });

  it("refuses every request when no token is configured, rather than allowing all", async () => {
    vi.stubEnv("CMS_INTERNAL_TOKEN", "");

    const res = await post({ key: "vn.zsoft.theme.corp", version: "1.0.0" }, "");

    expect(res.status).toBe(401);
    expect(forgetTheme).not.toHaveBeenCalled();
  });

  it("rejects an authorised request missing key or version", async () => {
    expect((await post({ version: "1.0.0" })).status).toBe(400);
    expect((await post({ key: "vn.zsoft.theme.corp" })).status).toBe(400);
    expect(forgetTheme).not.toHaveBeenCalled();
  });

  it("forgets the in-memory module and deletes the verified cache on a valid call", async () => {
    const dir = seedBundle("vn.zsoft.theme.corp", "1.0.0");

    const res = await post({ key: "vn.zsoft.theme.corp", version: "1.0.0" });
    const json = (await res.json()) as { purged: boolean; diskCacheRemoved: boolean };

    expect(res.status).toBe(200);
    expect(forgetTheme).toHaveBeenCalledWith("vn.zsoft.theme.corp", "1.0.0");
    expect(json).toEqual({ purged: true, diskCacheRemoved: true });
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("still forgets the module when there was no cache directory on disk", async () => {
    // Revoking a version this process never downloaded: dropping memory is enough,
    // and the response reports nothing was on disk.
    const res = await post({ key: "vn.zsoft.theme.corp", version: "9.9.9" });
    const json = (await res.json()) as { diskCacheRemoved: boolean };

    expect(res.status).toBe(200);
    expect(forgetTheme).toHaveBeenCalledWith("vn.zsoft.theme.corp", "9.9.9");
    expect(json.diskCacheRemoved).toBe(false);
  });
});
