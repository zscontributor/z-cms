-- The consumer side of the marketplace: what this instance last heard, and when.
--
-- Platform-level (no tenant_id, no RLS), like themes/plugins/publishers. In the
-- database rather than Redis because the AGE of the last accepted revocation list
-- is a security signal, and must survive a cache flush.
CREATE TABLE "marketplace_sync" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "last_attempt_at" TIMESTAMP(3),
    "last_synced_at" TIMESTAMP(3),
    "last_issued_at" TIMESTAMP(3),
    "last_error" TEXT,
    "revoked_count" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "marketplace_sync_pkey" PRIMARY KEY ("id")
);
