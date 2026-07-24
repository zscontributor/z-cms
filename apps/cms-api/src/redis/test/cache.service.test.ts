import { beforeEach, describe, expect, it, vi } from "vitest";

// ioredis is mocked: a unit test must not open a socket, and a Redis failure is
// something we deliberately provoke below to prove the site degrades, not dies.
const redisState = vi.hoisted(() => ({ instance: null as any }));
vi.mock("ioredis", () => ({
  default: class {
    constructor() {
      return redisState.instance;
    }
  },
}));

// getSystemDb is only reached by the site-runtime revalidation ping, which is
// skipped entirely when no runtime URL is configured (the default in these tests).
vi.mock("@zcmsorg/database", () => ({
  getSystemDb: () => ({ domain: { findMany: vi.fn().mockResolvedValue([]) } }),
}));

import { CacheService } from "../cache.service";

function newRedis() {
  return {
    get: vi.fn(),
    set: vi.fn().mockResolvedValue("OK"),
    incr: vi.fn().mockResolvedValue(1),
    unlink: vi.fn().mockResolvedValue(1),
    quit: vi.fn().mockResolvedValue("OK"),
    on: vi.fn(),
  };
}

function makeService(config: Record<string, string | undefined> = {}) {
  const configService = { get: (key: string) => config[key] } as any;
  return new CacheService(configService);
}

describe("CacheService", () => {
  beforeEach(() => {
    redisState.instance = newRedis();
  });

  describe("renderKey", () => {
    it("puts the site id in the key so two sites cannot collide", () => {
      // A shared key would serve one tenant's rendered page to another — the
      // single worst outcome a shared cache can produce.
      const a = CacheService.renderKey("siteA", 1, "/about", 1);
      const b = CacheService.renderKey("siteB", 1, "/about", 1);

      expect(a).not.toBe(b);
      expect(a).toContain("siteA");
    });

    it("changes when the site's cache version changes", () => {
      // Version bump is how a site-wide purge orphans the old generation.
      const v1 = CacheService.renderKey("s1", 1, "/about", 1);
      const v2 = CacheService.renderKey("s1", 2, "/about", 1);

      expect(v1).not.toBe(v2);
    });

    it("distinguishes pages of the same path", () => {
      expect(CacheService.renderKey("s1", 1, "/blog", 1)).not.toBe(
        CacheService.renderKey("s1", 1, "/blog", 2),
      );
    });
  });

  describe("get", () => {
    it("parses and returns a cached JSON value", async () => {
      redisState.instance.get.mockResolvedValue(JSON.stringify({ hello: "world" }));

      await expect(makeService().get("k")).resolves.toEqual({ hello: "world" });
    });

    it("returns null for a key that is not cached", async () => {
      redisState.instance.get.mockResolvedValue(null);

      await expect(makeService().get("k")).resolves.toBeNull();
    });

    it("degrades to a cache miss when Redis throws, instead of failing the request", async () => {
      // A cache outage must make the site slow, never broken. If this returned a
      // rejection, every public page would 500 the moment Redis hiccuped.
      redisState.instance.get.mockRejectedValue(new Error("ECONNREFUSED"));

      await expect(makeService().get("k")).resolves.toBeNull();
    });
  });

  describe("set", () => {
    it("writes the value as JSON with the configured TTL", async () => {
      await makeService({ RENDER_CACHE_TTL: "120" }).set("k", { a: 1 });

      expect(redisState.instance.set).toHaveBeenCalledWith(
        "k",
        JSON.stringify({ a: 1 }),
        "EX",
        120,
      );
    });

    it("honours a per-call TTL over the default", async () => {
      await makeService({ RENDER_CACHE_TTL: "300" }).set("k", 1, 30);

      expect(redisState.instance.set).toHaveBeenCalledWith("k", "1", "EX", 30);
    });

    it("swallows a write failure so a caching problem never surfaces to the user", async () => {
      redisState.instance.set.mockRejectedValue(new Error("down"));

      await expect(makeService().set("k", 1)).resolves.toBeUndefined();
    });
  });

  describe("siteVersion", () => {
    it("reads the counter as a number", async () => {
      redisState.instance.get.mockResolvedValue("7");

      await expect(makeService().siteVersion("s1")).resolves.toBe(7);
    });

    it("reads a never-bumped site as generation zero", async () => {
      redisState.instance.get.mockResolvedValue(null);

      await expect(makeService().siteVersion("s1")).resolves.toBe(0);
    });

    it("reads generation zero when Redis is unreachable, never a stale version", async () => {
      // Reading 0 on failure is safe: the worst case is a write under a version
      // nobody reads (a miss). Reading a stale number would serve old pages.
      redisState.instance.get.mockRejectedValue(new Error("down"));

      await expect(makeService().siteVersion("s1")).resolves.toBe(0);
    });
  });

  describe("invalidateSite", () => {
    it("bumps the version counter rather than scanning the keyspace", async () => {
      await makeService().invalidateSite("s1");

      expect(redisState.instance.incr).toHaveBeenCalledWith(CacheService.versionKey("s1"));
    });

    it("does not throw when the purge write fails", async () => {
      redisState.instance.incr.mockRejectedValue(new Error("down"));

      await expect(makeService().invalidateSite("s1")).resolves.toBeUndefined();
    });
  });

  describe("invalidateSitePaths", () => {
    it("unlinks the render keys for each path across the paginated window", async () => {
      redisState.instance.get.mockResolvedValue("1");

      await makeService().invalidateSitePaths("s1", ["/about"]);

      // Pages 1..5 of the one path.
      expect(redisState.instance.unlink).toHaveBeenCalledTimes(1);
      const keys = redisState.instance.unlink.mock.calls[0];
      expect(keys).toHaveLength(5);
      expect(keys.every((k: string) => k.includes("s1") && k.includes("/about"))).toBe(true);
    });

    it("survives a Redis failure during invalidation", async () => {
      redisState.instance.get.mockResolvedValue("1");
      redisState.instance.unlink.mockRejectedValue(new Error("down"));

      await expect(
        makeService().invalidateSitePaths("s1", ["/about"]),
      ).resolves.toBeUndefined();
    });
  });
});
