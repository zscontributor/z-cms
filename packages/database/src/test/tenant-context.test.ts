import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  currentTenantId,
  db,
  getTenantContext,
  withTenant,
} from "../tenant-context";

/**
 * This is the file that stops site A from reading site B's rows.
 *
 * The real Postgres RLS enforcement cannot be unit tested without a database, so
 * what is proven here is the layer in front of it: that the tenant id is bound
 * inside a transaction, that it is passed to Postgres as a bound PARAMETER (never
 * string-interpolated), that a query with no tenant context is REFUSED rather
 * than run unscoped, and — the one that matters most — that two concurrent
 * requests for different tenants never see each other's context.
 *
 * A leak in any of these is a cross-tenant data breach, so every test here is
 * written to fail loudly if the isolation gives way.
 */

/**
 * A fake tenant Prisma client. `$transaction(fn)` runs `fn` with a `tx` that
 * records every `$executeRaw` tagged-template call as { strings, values } — so a
 * test can prove the tenant id went in as a parameter and not as SQL text.
 */
function fakeDb() {
  const executeRawCalls: { strings: readonly string[]; values: unknown[] }[] = [];
  const transactionOptions: unknown[] = [];

  const client = {
    $transaction: async (fn: (tx: unknown) => Promise<unknown>, options?: unknown) => {
      transactionOptions.push(options);
      // A fresh tx per transaction, exactly as Prisma hands out a distinct
      // connection per transaction — so two concurrent requests get distinct
      // client handles and this fake cannot mask a leak by sharing one.
      const tx = {
        $executeRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
          executeRawCalls.push({ strings: [...strings], values });
          return Promise.resolve(1);
        },
      };
      return fn(tx);
    },
  };

  return { client, executeRawCalls, transactionOptions };
}

let current = fakeDb();

// clients.ts is the only real I/O tenant-context reaches. Mock it so no database
// is needed; the module under test itself is never mocked.
vi.mock("../clients", () => ({
  getTenantDb: () => current.client,
}));

beforeEach(() => {
  current = fakeDb();
});

/** A microtask boundary, so two "concurrent" tasks actually interleave. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("withTenant", () => {
  it("runs the callback inside a database transaction", async () => {
    let ran = false;

    await withTenant("tenant-a", async () => {
      ran = true;
    });

    // The tenant id only sticks to a connection for the life of a transaction;
    // running fn outside one would leave the query unscoped.
    expect(ran).toBe(true);
    expect(current.transactionOptions).toHaveLength(1);
  });

  it("binds the tenant id transaction-locally before the callback runs", async () => {
    await withTenant("tenant-a", async () => {});

    const [call] = current.executeRawCalls;
    // `true` (the third arg) = local to this transaction, discarded on commit, so
    // a recycled pool connection cannot carry one tenant's id into the next.
    expect(call?.values).toContain("tenant-a");
    expect(call?.strings.join("")).toContain("set_config");
    expect(call?.strings.join("")).toContain("app.tenant_id");
    expect(call?.strings.join("")).toContain("true");
  });

  it("passes the tenant id to Postgres as a bound parameter, not as SQL text", async () => {
    // If the id were interpolated into the string, this hostile value would close
    // the set_config call and run its own statement. It must arrive as a parameter.
    const hostile = "x'); DROP TABLE users; SELECT set_config('app.tenant_id','1";

    await withTenant(hostile, async () => {});

    const [call] = current.executeRawCalls;
    // The literal must NOT appear in any static SQL fragment...
    expect(call?.strings.join("")).not.toContain("DROP TABLE");
    // ...it must be carried in the parameter list, verbatim, for Postgres to bind.
    expect(call?.values).toContain(hostile);
  });

  it("returns whatever the callback returns", async () => {
    const result = await withTenant("tenant-a", async () => ({ id: 7 }));

    expect(result).toEqual({ id: 7 });
  });

  it("exposes the bound tenant id to the callback via the context", async () => {
    let seen: string | undefined;

    await withTenant("tenant-a", async (ctx) => {
      seen = ctx.tenantId;
    });

    expect(seen).toBe("tenant-a");
  });

  it("makes the tenant-scoped client available to the callback", async () => {
    let hasDb = false;

    await withTenant("tenant-a", async (ctx) => {
      hasDb = ctx.db != null;
    });

    expect(hasDb).toBe(true);
  });

  it("applies the caller's transaction timeout and maxWait", async () => {
    await withTenant("tenant-a", async () => {}, { timeout: 1000, maxWait: 200 });

    expect(current.transactionOptions[0]).toEqual({ timeout: 1000, maxWait: 200 });
  });

  it("defaults the transaction timeout and maxWait when the caller gives none", async () => {
    await withTenant("tenant-a", async () => {});

    expect(current.transactionOptions[0]).toEqual({ timeout: 15_000, maxWait: 5_000 });
  });

  describe("re-entrancy", () => {
    it("joins the ambient transaction when re-entered with the same tenant", async () => {
      // A nested withTenant for the SAME tenant must not open a second transaction,
      // which would deadlock against the first's row locks.
      await withTenant("tenant-a", async () => {
        await withTenant("tenant-a", async () => {});
      });

      expect(current.transactionOptions).toHaveLength(1);
    });

    it("refuses to switch to a different tenant inside an open context", async () => {
      // THE ATTACK: code inside tenant A's request that tries to open tenant B's
      // context. Allowing it would run B's work on A's transaction — a cross-tenant
      // read that RLS could not catch because the connection is already A's.
      await expect(
        withTenant("tenant-a", async () => {
          await withTenant("tenant-b", async () => {});
        }),
      ).rejects.toThrow(/Refusing to switch tenant/);
    });

    it("does not open a second transaction for the refused nested tenant", async () => {
      await withTenant("tenant-a", async () => {
        await expect(withTenant("tenant-b", async () => {})).rejects.toThrow();
      });

      // Only tenant A's transaction was ever opened.
      expect(current.transactionOptions).toHaveLength(1);
    });
  });

  describe("concurrent isolation", () => {
    it("does not leak one tenant's context into a concurrent request for another tenant", async () => {
      // The core multi-tenancy guarantee. Two overlapping requests, different
      // tenants; if AsyncLocalStorage leaked, one would read the other's id and
      // every query in that request would hit the wrong tenant's rows.
      const observed: Record<string, string[]> = { a: [], b: [] };

      const task = (tenant: string, bucket: string) =>
        withTenant(tenant, async () => {
          observed[bucket]!.push(currentTenantId()); // before yielding
          await tick(); // hand control to the other task mid-request
          observed[bucket]!.push(currentTenantId()); // after the other ran
        });

      await Promise.all([task("tenant-a", "a"), task("tenant-b", "b")]);

      // Each request saw only its own tenant, before AND after the interleave.
      expect(observed.a).toEqual(["tenant-a", "tenant-a"]);
      expect(observed.b).toEqual(["tenant-b", "tenant-b"]);
    });

    it("keeps db() bound to the right tenant's client across an await in a concurrent request", async () => {
      // Not just the id — the actual client handle must not cross requests either.
      const seen: unknown[][] = [];

      const task = (tenant: string) =>
        withTenant(tenant, async (ctx) => {
          const before = db();
          await tick();
          // After the other task ran, db() must still be THIS request's client.
          expect(db()).toBe(ctx.db);
          seen.push([before, db()]);
        });

      await Promise.all([task("tenant-a"), task("tenant-b")]);

      const [reqA, reqB] = seen;
      expect(reqA?.[0]).toBe(reqA?.[1]); // request A held one client throughout
      expect(reqB?.[0]).toBe(reqB?.[1]); // as did request B
      expect(reqA?.[0]).not.toBe(reqB?.[0]); // and the two were never the same client
    });

    it("leaves no ambient context behind after the request completes", async () => {
      // A leaked context after withTenant returns would scope the NEXT, unrelated
      // piece of work to a tenant it has nothing to do with.
      await withTenant("tenant-a", async () => {});

      expect(getTenantContext()).toBeUndefined();
    });

    it("clears the context even when the callback throws", async () => {
      await expect(
        withTenant("tenant-a", async () => {
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");

      // A failed request must not poison the async context for whatever runs next.
      expect(getTenantContext()).toBeUndefined();
    });
  });
});

describe("getTenantContext", () => {
  it("returns undefined outside of withTenant", () => {
    expect(getTenantContext()).toBeUndefined();
  });

  it("returns the active context inside withTenant", async () => {
    await withTenant("tenant-a", async () => {
      expect(getTenantContext()?.tenantId).toBe("tenant-a");
    });
  });
});

describe("db", () => {
  it("refuses to hand out a client when there is no tenant context", () => {
    // The single most important line in the package: NO fallback to an unscoped
    // client. A missing context is a bug, and querying without one leaks every
    // tenant's data. It must throw, not default to "all tenants".
    expect(() => db()).toThrow(/No tenant context/);
  });

  it("points the caller at getSystemDb for deliberate cross-tenant reads", () => {
    // The error must name the sanctioned escape hatch, or a developer under
    // pressure invents an unsafe one.
    expect(() => db()).toThrow(/getSystemDb/);
  });

  it("returns the tenant-bound client inside withTenant", async () => {
    await withTenant("tenant-a", async (ctx) => {
      expect(db()).toBe(ctx.db);
    });
  });
});

describe("currentTenantId", () => {
  it("throws rather than returning an empty id when there is no context", () => {
    // A caller that got "" back would build a query scoped to no tenant — which a
    // loosely written RLS policy could read as every tenant.
    expect(() => currentTenantId()).toThrow(/No tenant context/);
  });

  it("returns the active tenant id inside withTenant", async () => {
    await withTenant("tenant-a", async () => {
      expect(currentTenantId()).toBe("tenant-a");
    });
  });
});
