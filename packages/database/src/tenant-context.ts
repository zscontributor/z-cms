import { AsyncLocalStorage } from "node:async_hooks";
import { getTenantDb } from "./clients";
import type { Prisma, PrismaClient } from "../generated/client";

/** The client handle services actually use: a transaction bound to one tenant. */
export type TenantClient = Omit<
  PrismaClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$extends"
>;

export interface TenantContext {
  tenantId: string;
  db: TenantClient;
}

const storage = new AsyncLocalStorage<TenantContext>();

/**
 * Runs `fn` with every database query scoped to `tenantId`.
 *
 * Why this is a transaction and not a middleware or a client extension:
 *
 * `SET LOCAL` / `set_config(..., true)` binds the tenant id to a *connection*
 * for the life of a *transaction*. Prisma hands out pooled connections per
 * query, so setting the variable outside a transaction would stamp it on one
 * connection and then run the query on a different one — the policy would see
 * a NULL tenant and return nothing (or, if the policy were written loosely,
 * everything).
 *
 * Prisma's own docs recommend a client extension for this, but that path is
 * broken for our case: an extension that calls `$transaction` from inside an
 * interactive transaction opens a *new* connection and silently drops the
 * surrounding transaction context (prisma/prisma#20678). That failure mode is
 * invisible in tests and catastrophic in production, so we bind the tenant
 * explicitly, once, at the top of the request instead.
 *
 * Every query inside `fn` therefore runs on one connection, inside one
 * transaction, with `app.tenant_id` set — which is exactly what the RLS
 * policies read.
 */
export async function withTenant<T>(
  tenantId: string,
  fn: (ctx: TenantContext) => Promise<T>,
  options?: { timeout?: number; maxWait?: number },
): Promise<T> {
  // Re-entrant calls join the ambient transaction rather than opening a second
  // one, which would deadlock against the first's row locks.
  const existing = storage.getStore();
  if (existing) {
    if (existing.tenantId !== tenantId) {
      throw new Error(
        `Refusing to switch tenant inside an open tenant context ` +
          `(${existing.tenantId} -> ${tenantId}). Cross-tenant work must use ` +
          `the system client explicitly.`,
      );
    }
    return fn(existing);
  }

  const prisma = getTenantDb();

  return prisma.$transaction(
    async (tx: Prisma.TransactionClient) => {
      // `true` = local to this transaction; it is discarded on commit/rollback,
      // so a recycled pool connection can never carry one tenant's id into the
      // next tenant's request.
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;

      const ctx: TenantContext = { tenantId, db: tx as unknown as TenantClient };
      return storage.run(ctx, () => fn(ctx));
    },
    {
      timeout: options?.timeout ?? 15_000,
      maxWait: options?.maxWait ?? 5_000,
    },
  );
}

/** The ambient tenant context, or undefined outside `withTenant()`. */
export function getTenantContext(): TenantContext | undefined {
  return storage.getStore();
}

/**
 * The tenant-scoped client for the current request.
 * Throws rather than falling back to an unscoped client — a missing tenant
 * context is a bug, and silently querying without one is how data leaks.
 */
export function db(): TenantClient {
  const ctx = storage.getStore();
  if (!ctx) {
    throw new Error(
      "No tenant context. Database access must happen inside withTenant(). " +
        "For deliberate cross-tenant reads, use getSystemDb().",
    );
  }
  return ctx.db;
}

export function currentTenantId(): string {
  const ctx = storage.getStore();
  if (!ctx) throw new Error("No tenant context.");
  return ctx.tenantId;
}
