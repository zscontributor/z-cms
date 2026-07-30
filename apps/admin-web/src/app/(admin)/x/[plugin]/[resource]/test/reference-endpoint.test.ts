import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Where the reference picker sends its search.
 *
 * This is a URL test, which sounds trivial until you have paid for it: the picker
 * asked for a bare `/api/plugin-admin/…`, the admin is served under `/admin` in
 * production, and the request left the app and 404'd against the origin. The
 * picker rendered that as "No matches." — so a broken endpoint and an empty table
 * looked identical, in the one environment nobody could reproduce locally,
 * because in dev the base path is "" and the bare path happened to be right.
 *
 * `adminAssetPath` reads the base path at module scope, so each case re-imports
 * it with the environment it is testing.
 */

/** The path the picker builds, for a given environment. */
async function endpointFor(env: {
  ADMIN_BASE_PATH?: string;
  NODE_ENV?: string;
}): Promise<string> {
  vi.resetModules();
  const previous = { ...process.env };
  if (env.ADMIN_BASE_PATH === undefined) delete process.env.ADMIN_BASE_PATH;
  else process.env.ADMIN_BASE_PATH = env.ADMIN_BASE_PATH;
  vi.stubEnv("NODE_ENV", env.NODE_ENV ?? "test");

  const { adminAssetPath } = await import("@/lib/assets");
  const path = adminAssetPath(
    `/api/plugin-admin/${encodeURIComponent("vn.zsoft.plugin.cafe")}/${encodeURIComponent(
      "shifts",
    )}/options/${encodeURIComponent("staff_id")}`,
  );

  process.env = previous;
  return path;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the reference picker's endpoint", () => {
  it("carries the admin base path in production, where it defaults to /admin", async () => {
    // The exact URL that 404'd: without the prefix this asks the ORIGIN for a
    // route only the Next app under /admin serves.
    expect(await endpointFor({ NODE_ENV: "production" })).toBe(
      "/admin/api/plugin-admin/vn.zsoft.plugin.cafe/shifts/options/staff_id",
    );
  });

  it("stays at the root in development, where there is no base path", async () => {
    expect(await endpointFor({ NODE_ENV: "development" })).toBe(
      "/api/plugin-admin/vn.zsoft.plugin.cafe/shifts/options/staff_id",
    );
  });

  it("honours an explicitly configured base path over the default", async () => {
    expect(await endpointFor({ ADMIN_BASE_PATH: "/console", NODE_ENV: "production" })).toBe(
      "/console/api/plugin-admin/vn.zsoft.plugin.cafe/shifts/options/staff_id",
    );
  });

  it("treats an explicit '/' as no base path at all", async () => {
    expect(await endpointFor({ ADMIN_BASE_PATH: "/", NODE_ENV: "production" })).toBe(
      "/api/plugin-admin/vn.zsoft.plugin.cafe/shifts/options/staff_id",
    );
  });

  it("escapes a plugin id so its dots cannot become path segments", async () => {
    const path = await endpointFor({ NODE_ENV: "development" });
    // The id is a dotted string; it must arrive as ONE segment.
    expect(path.split("/").filter(Boolean)).toEqual([
      "api",
      "plugin-admin",
      "vn.zsoft.plugin.cafe",
      "shifts",
      "options",
      "staff_id",
    ]);
  });
});
