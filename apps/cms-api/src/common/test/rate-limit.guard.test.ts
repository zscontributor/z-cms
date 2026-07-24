import type { ExecutionContext } from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RATE_LIMIT_KEY, type RateLimitRule } from "../rate-limit.decorator";

/**
 * The brute-force limiter in front of /auth/login.
 *
 * It is faked over a Redis that is really just an in-memory counter map here, so
 * the fixed-window arithmetic (INCR, TTL-on-first-hit, the reset) is exercised
 * for real rather than asserted against a stub. The attacks it must stop:
 *   - unbounded password guessing against one account;
 *   - one account's guessing spilling into another's budget (a shared bucket is
 *     both a bypass and a denial-of-service);
 *   - a client forging its own limit key.
 */

const redisState = vi.hoisted(() => ({ instance: null as any }));
vi.mock("ioredis", () => ({
  // `new Redis(...)` — return the instance the test wired up. A plain function so
  // it can be used as a constructor (an arrow function has no [[Construct]]).
  default: vi.fn(function () {
    return redisState.instance;
  }),
}));

import { RateLimitGuard } from "../rate-limit.guard";

/** An in-memory Redis with just the four calls the guard makes. */
function inMemoryRedis() {
  const counts = new Map<string, number>();
  const ttls = new Map<string, number>();
  return {
    counts,
    ttls,
    on: vi.fn(),
    incr: vi.fn(async (key: string) => {
      const next = (counts.get(key) ?? 0) + 1;
      counts.set(key, next);
      return next;
    }),
    expire: vi.fn(async (key: string, sec: number) => {
      ttls.set(key, sec);
      return 1;
    }),
    ttl: vi.fn(async (key: string) => ttls.get(key) ?? -1),
  };
}

function makeGuard(rules: RateLimitRule[] | undefined, redis = inMemoryRedis()) {
  redisState.instance = redis;
  const reflector = { getAllAndOverride: vi.fn(() => rules) } as any;
  const config = { get: () => "redis://localhost:6379" } as any;
  return { guard: new RateLimitGuard(reflector, config), redis };
}

function contextFor(req: any): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => () => undefined,
    getClass: () => class {},
  } as any;
}

function loginRequest(email: string, ip = "1.2.3.4") {
  return {
    method: "POST",
    path: "/api/v1/auth/login",
    body: { email },
    ip,
    socket: { remoteAddress: ip },
  };
}

describe("RateLimitGuard", () => {
  it("allows a route that declares no rules", async () => {
    const { guard } = makeGuard(undefined);

    await expect(guard.canActivate(contextFor(loginRequest("a@b.test")))).resolves.toBe(
      true,
    );
  });

  it("allows requests up to the limit", async () => {
    const { guard } = makeGuard([{ by: "email", points: 3, windowSec: 900 }]);
    const req = loginRequest("target@example.test");

    for (let i = 0; i < 3; i++) {
      await expect(guard.canActivate(contextFor(req))).resolves.toBe(true);
    }
  });

  it("refuses the request that goes over the limit", async () => {
    // The whole point: without this, a leaked password list can be checked as
    // fast as the network allows and bcrypt only slows each guess, not their
    // number.
    const { guard } = makeGuard([{ by: "email", points: 3, windowSec: 900 }]);
    const req = loginRequest("target@example.test");

    for (let i = 0; i < 3; i++) await guard.canActivate(contextFor(req));

    await expect(guard.canActivate(contextFor(req))).rejects.toThrow();
  });

  it("keeps a separate budget per identity, so one account cannot exhaust another's", async () => {
    // A GLOBAL bucket is two bugs at once: an attacker hammering their own account
    // could lock every other user out (DoS), and spreading guesses across accounts
    // could dodge a per-account limit. The key must include the identity.
    const { guard } = makeGuard([{ by: "email", points: 2, windowSec: 900 }]);

    const victim = loginRequest("victim@example.test");
    for (let i = 0; i < 2; i++) await guard.canActivate(contextFor(victim));
    await expect(guard.canActivate(contextFor(victim))).rejects.toThrow(); // victim spent

    // A different account, starting from zero, is unaffected.
    const other = loginRequest("someone-else@example.test");
    await expect(guard.canActivate(contextFor(other))).resolves.toBe(true);
  });

  it("keys the limit on the route as well, so spending it on login does not block signup", async () => {
    const { guard } = makeGuard([{ by: "email", points: 1, windowSec: 900 }]);

    const login = loginRequest("same@example.test");
    login.path = "/api/v1/auth/login";
    await guard.canActivate(contextFor(login));
    await expect(guard.canActivate(contextFor(login))).rejects.toThrow();

    const otherRoute = loginRequest("same@example.test");
    otherRoute.path = "/api/v1/auth/accept-invite";
    await expect(guard.canActivate(contextFor(otherRoute))).resolves.toBe(true);
  });

  it("sets the window TTL only on the first hit, so the window does not slide forever", async () => {
    // If expire() were called every hit, a persistent attacker would keep pushing
    // the reset out and the window would never close. TTL is set once.
    const { guard, redis } = makeGuard([{ by: "email", points: 5, windowSec: 900 }]);
    const req = loginRequest("target@example.test");

    await guard.canActivate(contextFor(req));
    await guard.canActivate(contextFor(req));

    expect(redis.expire).toHaveBeenCalledTimes(1);
  });

  it("lets the window reset once it expires, restoring the budget", async () => {
    // A blocked account is not blocked forever — after the window the counter is
    // gone and the next attempt starts fresh.
    const { guard, redis } = makeGuard([{ by: "email", points: 1, windowSec: 900 }]);
    const req = loginRequest("target@example.test");

    await guard.canActivate(contextFor(req));
    await expect(guard.canActivate(contextFor(req))).rejects.toThrow();

    // Simulate the window elapsing: Redis drops the expired key.
    redis.counts.clear();
    redis.ttls.clear();

    await expect(guard.canActivate(contextFor(req))).resolves.toBe(true);
  });

  it("keys an ip rule on the client address, independent of the email budget", async () => {
    const { guard, redis } = makeGuard([{ by: "ip", points: 5, windowSec: 900 }]);
    const req = loginRequest("target@example.test", "9.9.9.9");

    await guard.canActivate(contextFor(req));

    expect([...redis.counts.keys()][0]).toContain("ip:9.9.9.9");
  });

  it("skips an email rule when the body carries no email, rather than blocking everyone", async () => {
    // A rule whose subject is absent must be skipped, not treated as a single
    // shared key that every anonymous request would pile onto.
    const { guard, redis } = makeGuard([{ by: "email", points: 1, windowSec: 900 }]);
    const req = { method: "POST", path: "/api/v1/auth/login", body: {}, ip: "1.1.1.1", socket: {} };

    await expect(guard.canActivate(contextFor(req))).resolves.toBe(true);
    await expect(guard.canActivate(contextFor(req))).resolves.toBe(true);
    expect(redis.incr).not.toHaveBeenCalled();
  });

  it("fails OPEN when Redis is down, rather than locking every user out of login", async () => {
    // The deliberate opposite of the revocation service. This limiter is a
    // mitigation, not the gate — the password check behind it still stands — so a
    // Redis outage must not become a self-inflicted, total login outage.
    const brokenRedis = {
      on: vi.fn(),
      incr: vi.fn(async () => {
        throw new Error("connection refused");
      }),
      expire: vi.fn(),
      ttl: vi.fn(),
    };
    const { guard } = makeGuard([{ by: "email", points: 1, windowSec: 900 }], brokenRedis as any);
    const req = loginRequest("target@example.test");

    await expect(guard.canActivate(contextFor(req))).resolves.toBe(true);
  });

  it("enforces the tightest of several rules on the same route", async () => {
    // login declares both a per-email and a per-ip budget; the request must clear
    // both. The smaller one is what actually bites.
    const { guard } = makeGuard([
      { by: "email", points: 1, windowSec: 900 },
      { by: "ip", points: 100, windowSec: 900 },
    ]);
    const req = loginRequest("target@example.test");

    await guard.canActivate(contextFor(req));
    await expect(guard.canActivate(contextFor(req))).rejects.toThrow(); // email budget spent
  });
});
