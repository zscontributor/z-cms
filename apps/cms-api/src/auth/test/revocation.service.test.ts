import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The denylist that makes "log out" and "kill this stolen session" take effect
 * NOW rather than at the end of the access token's TTL.
 *
 * Two properties are worth more than the rest of the class combined, and both
 * are tested from the failure side:
 *   - it FAILS CLOSED: if Redis cannot answer, an unknown token is treated as
 *     revoked, because an authorisation control that cannot say "no" must not
 *     default to "yes";
 *   - a revoke() that cannot reach Redis does not throw into the request path.
 *
 * ioredis is mocked at the module boundary: the real client would open a socket.
 */

const redisState = vi.hoisted(() => ({ instance: null as any }));

vi.mock("ioredis", () => {
  // A constructor that hands back whatever the test wired up for this run. Plain
  // function, not an arrow — `new Redis()` needs something with [[Construct]].
  return {
    default: vi.fn(function () {
      return redisState.instance;
    }),
  };
});

import { RevocationService } from "../revocation.service";

function makeRedis(overrides: Record<string, any> = {}) {
  return {
    set: vi.fn(async () => "OK"),
    exists: vi.fn(async () => 0),
    on: vi.fn(),
    quit: vi.fn(async () => "OK"),
    ...overrides,
  };
}

function makeService(redis = makeRedis()) {
  redisState.instance = redis;
  const config = {
    get: (key: string) => (key === "JWT_ACCESS_TTL" ? "15m" : undefined),
  } as any;
  return { service: new RevocationService(config), redis };
}

describe("RevocationService", () => {
  describe("revoke", () => {
    it("writes the family to the denylist with an expiry that outlives the access TTL", async () => {
      // The entry must survive at least as long as any access token that could
      // still name the family; an entry that expired first would un-revoke a
      // still-valid stolen token.
      const { service, redis } = makeService();

      await service.revoke("family-1");

      expect(redis.set).toHaveBeenCalledWith(
        "revoked:family:family-1",
        "1",
        "EX",
        // 15m + 60s of slack.
        15 * 60 + 60,
      );
    });

    it("does not throw when Redis is unreachable, so a revocation never 500s the caller", async () => {
      // revoke() runs inside logout and the theft response. If it threw, detecting
      // a theft would crash the very request that detected it.
      const redis = makeRedis({
        set: vi.fn(async () => {
          throw new Error("connection refused");
        }),
      });
      const { service } = makeService(redis);

      await expect(service.revoke("family-1")).resolves.toBeUndefined();
    });
  });

  describe("isRevoked", () => {
    it("reports a family that is on the denylist as revoked", async () => {
      const { service } = makeService(makeRedis({ exists: vi.fn(async () => 1) }));

      await expect(service.isRevoked("family-1")).resolves.toBe(true);
    });

    it("reports a family that is not on the denylist as still valid", async () => {
      const { service } = makeService(makeRedis({ exists: vi.fn(async () => 0) }));

      await expect(service.isRevoked("family-1")).resolves.toBe(false);
    });

    it("treats a token as revoked when Redis cannot answer — it FAILS CLOSED", async () => {
      // The property that separates this from the rate limiter. If the denylist
      // is unreachable we cannot prove a token is still good, and an authorisation
      // control that guesses "yes" hands a logged-out or stolen session a pass.
      const redis = makeRedis({
        exists: vi.fn(async () => {
          throw new Error("connection refused");
        }),
      });
      const { service } = makeService(redis);

      await expect(service.isRevoked("family-1")).resolves.toBe(true);
    });
  });
});
