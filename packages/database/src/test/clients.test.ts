import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { disconnectDb, getSystemDb, getTenantDb } from "../clients";

/**
 * clients.ts wires up the two Prisma clients Z-CMS uses: the RLS-enforced
 * `tenantDb` (role zcms_app, NOBYPASSRLS) and the RLS-bypassing `systemDb` (table
 * owner). Prisma and the pg adapter are the external I/O, so they are mocked —
 * no database is touched. What is asserted is the configuration, because a
 * mistake here is a silent one: point the tenant client at the owner role and
 * every RLS policy in the product is bypassed with no error anywhere.
 */

const mocks = vi.hoisted(() => ({
  PrismaClientCtor: vi.fn(),
  PrismaPgCtor: vi.fn(),
  disconnect: vi.fn(),
}));

vi.mock("../../generated/client", () => ({
  PrismaClient: class {
    $disconnect = mocks.disconnect;
    constructor(options: unknown) {
      mocks.PrismaClientCtor(options);
    }
  },
}));

vi.mock("@prisma/adapter-pg", () => ({
  PrismaPg: class {
    constructor(options: unknown) {
      mocks.PrismaPgCtor(options);
    }
  },
}));

/** The pg adapter options captured on the Nth construction. */
function adapterOptions(call = 0) {
  return mocks.PrismaPgCtor.mock.calls[call]?.[0] as Record<string, unknown>;
}

/** The PrismaClient options captured on the Nth construction. */
function clientOptions(call = 0) {
  return mocks.PrismaClientCtor.mock.calls[call]?.[0] as Record<string, unknown>;
}

beforeEach(() => {
  // The hoisted vi.fn mocks are shared across tests; clear their call history so
  // adapterOptions(0) and the call counts reflect THIS test, not earlier ones.
  mocks.PrismaClientCtor.mockReset();
  mocks.PrismaPgCtor.mockReset();
  mocks.disconnect.mockReset();
  vi.stubEnv("APP_DATABASE_URL", "postgres://zcms_app@db/zcms");
  vi.stubEnv("DATABASE_URL", "postgres://owner@db/zcms");
});

afterEach(async () => {
  // The module holds the clients in singletons; reset them so one test's cached
  // client does not answer the next test's call without re-reading the env.
  await disconnectDb();
});

describe("getTenantDb", () => {
  it("connects using APP_DATABASE_URL, which must point at the RLS-enforced role", () => {
    // If this read DATABASE_URL (the owner) instead, every query would BYPASS RLS
    // and the whole tenant isolation model would be silently off.
    getTenantDb();

    expect(adapterOptions().connectionString).toBe("postgres://zcms_app@db/zcms");
  });

  it("refuses to start when APP_DATABASE_URL is not set", () => {
    // Failing closed is the point: better a boot crash than a client that quietly
    // falls back to an unscoped connection.
    vi.stubEnv("APP_DATABASE_URL", "");

    expect(() => getTenantDb()).toThrow(/APP_DATABASE_URL is not set/);
  });

  it("warns in its error that the app role, not the owner, must back this URL", () => {
    vi.stubEnv("APP_DATABASE_URL", "");

    expect(() => getTenantDb()).toThrow(/zcms_app role/);
  });

  it("constructs the client only once and reuses it", () => {
    // A new PrismaClient per call opens a new pool per call — a connection leak
    // that exhausts Postgres under load.
    getTenantDb();
    getTenantDb();

    expect(mocks.PrismaClientCtor).toHaveBeenCalledTimes(1);
  });

  it("sizes the connection pool from DB_POOL_MAX when set", () => {
    vi.stubEnv("DB_POOL_MAX", "25");

    getTenantDb();

    expect(adapterOptions().max).toBe(25);
  });

  it("defaults the pool to 10 connections when DB_POOL_MAX is unset", () => {
    vi.stubEnv("DB_POOL_MAX", undefined);

    getTenantDb();

    expect(adapterOptions().max).toBe(10);
  });

  it("logs only errors outside development", () => {
    // Query logs in production leak tenant data into stdout and are a performance
    // tax on every statement.
    vi.stubEnv("NODE_ENV", "production");

    getTenantDb();

    expect(clientOptions().log).toEqual(["error"]);
  });

  it("adds warnings to the log in development", () => {
    vi.stubEnv("NODE_ENV", "development");

    getTenantDb();

    expect(clientOptions().log).toEqual(["warn", "error"]);
  });
});

describe("getSystemDb", () => {
  it("connects using DATABASE_URL, the owner role that bypasses RLS", () => {
    getSystemDb();

    expect(adapterOptions().connectionString).toBe("postgres://owner@db/zcms");
  });

  it("refuses to start when DATABASE_URL is not set", () => {
    vi.stubEnv("DATABASE_URL", "");

    expect(() => getSystemDb()).toThrow(/DATABASE_URL is not set/);
  });

  it("constructs the client only once and reuses it", () => {
    getSystemDb();
    getSystemDb();

    expect(mocks.PrismaClientCtor).toHaveBeenCalledTimes(1);
  });

  it("is a different client from the tenant client, on a different role", () => {
    // The two must never collapse into one: the whole design is one RLS-enforced
    // client and one RLS-bypassing one, kept apart.
    getTenantDb();
    getSystemDb();

    expect(mocks.PrismaClientCtor).toHaveBeenCalledTimes(2);
    expect(adapterOptions(0).connectionString).not.toBe(adapterOptions(1).connectionString);
  });
});

describe("disconnectDb", () => {
  it("disconnects the clients that were created", async () => {
    getTenantDb();
    getSystemDb();

    await disconnectDb();

    expect(mocks.disconnect).toHaveBeenCalledTimes(2);
  });

  it("does nothing when no client was ever created", async () => {
    await expect(disconnectDb()).resolves.toBeUndefined();

    expect(mocks.disconnect).not.toHaveBeenCalled();
  });

  it("clears the singletons so the next call rebuilds a fresh client", async () => {
    getTenantDb();
    await disconnectDb();

    getTenantDb();

    // Two constructions total: the singleton was genuinely released, not reused.
    expect(mocks.PrismaClientCtor).toHaveBeenCalledTimes(2);
  });
});
