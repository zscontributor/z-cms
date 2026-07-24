import { beforeEach, describe, expect, it, vi } from "vitest";
import { CMS_API_URL, CMS_INTERNAL_TOKEN, RENDER_REVALIDATE_SECONDS } from "../env";

/**
 * Config is read lazily so a build never needs a live API, but the reads must be
 * normalised the same way every time: a trailing slash on CMS_API_URL that leaks
 * through would turn every fetch URL into a "//" that some proxies 404, and an
 * unset internal token must read as "" (which the auth checks then fail closed
 * on) rather than as `undefined`.
 */

beforeEach(() => {
  vi.stubEnv("CMS_API_URL", undefined as unknown as string);
  vi.stubEnv("CMS_INTERNAL_TOKEN", undefined as unknown as string);
});

describe("CMS_API_URL", () => {
  it("returns the configured URL", () => {
    vi.stubEnv("CMS_API_URL", "http://api.internal:4100");

    expect(CMS_API_URL()).toBe("http://api.internal:4100");
  });

  it("strips trailing slashes so callers can append a path cleanly", () => {
    vi.stubEnv("CMS_API_URL", "http://api.internal:4100///");

    expect(CMS_API_URL()).toBe("http://api.internal:4100");
  });

  it("falls back to the local default when unset", () => {
    expect(CMS_API_URL()).toBe("http://localhost:4100");
  });

  it("is read lazily, reflecting a change made after import", () => {
    // Proves it is not frozen at module load — the whole reason it is a function.
    vi.stubEnv("CMS_API_URL", "http://first:4100");
    expect(CMS_API_URL()).toBe("http://first:4100");
    vi.stubEnv("CMS_API_URL", "http://second:4100");
    expect(CMS_API_URL()).toBe("http://second:4100");
  });
});

describe("CMS_INTERNAL_TOKEN", () => {
  it("returns the configured token", () => {
    vi.stubEnv("CMS_INTERNAL_TOKEN", "abc123");

    expect(CMS_INTERNAL_TOKEN()).toBe("abc123");
  });

  it("reads as empty string when unset, so auth checks fail closed", () => {
    // The endpoints treat "" as "no one may call me". Returning undefined would
    // make `provided !== token` behave differently — this pins it to "".
    expect(CMS_INTERNAL_TOKEN()).toBe("");
  });
});

describe("RENDER_REVALIDATE_SECONDS", () => {
  it("is a positive TTL used as the missed-webhook safety net", () => {
    expect(RENDER_REVALIDATE_SECONDS).toBeGreaterThan(0);
  });
});
