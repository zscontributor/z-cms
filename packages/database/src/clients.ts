import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/client";

/**
 * Z-CMS talks to Postgres through two clients with different privileges.
 *
 * `tenantDb` connects as `zcms_app`, a role with NOBYPASSRLS that owns no
 * tables, so every statement it issues is filtered by the Row-Level Security
 * policies. It is only usable inside `withTenant()`, which opens a transaction
 * and stamps `app.tenant_id` onto that connection.
 *
 * `systemDb` connects as the table owner and is therefore NOT filtered. It
 * exists for the handful of operations that legitimately span tenants —
 * resolving a hostname to a site, finding a user by email at login, and
 * reading the theme/plugin catalog. Reach for it deliberately and rarely;
 * anything that touches customer rows belongs in `withTenant()`.
 */

function createClient(connectionString: string): PrismaClient {
  const adapter = new PrismaPg({
    connectionString,
    // RLS relies on `SET LOCAL`, which is transaction-scoped. Pooling is safe
    // because each tenant transaction sets and discards its own setting.
    max: Number(process.env.DB_POOL_MAX ?? 10),
  });

  return new PrismaClient({
    adapter,
    log:
      process.env.NODE_ENV === "development"
        ? ["warn", "error"]
        : ["error"],
  });
}

let _tenantDb: PrismaClient | undefined;
let _systemDb: PrismaClient | undefined;

/** RLS-enforced client. Do not query it directly — go through `withTenant()`. */
export function getTenantDb(): PrismaClient {
  if (!_tenantDb) {
    const url = process.env.APP_DATABASE_URL;
    if (!url) {
      throw new Error(
        "APP_DATABASE_URL is not set. It must point at the zcms_app role, " +
          "never the owner role, or Row-Level Security will not be enforced.",
      );
    }
    _tenantDb = createClient(url);
  }
  return _tenantDb;
}

/** RLS-bypassing client. Only for cross-tenant control-plane reads. */
export function getSystemDb(): PrismaClient {
  if (!_systemDb) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set.");
    _systemDb = createClient(url);
  }
  return _systemDb;
}

export async function disconnectDb(): Promise<void> {
  await Promise.all([_tenantDb?.$disconnect(), _systemDb?.$disconnect()]);
  _tenantDb = undefined;
  _systemDb = undefined;
}
