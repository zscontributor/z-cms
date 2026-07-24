-- Publisher accounts -------------------------------------------------------
-- A publisher is now owned by the user who registered it, so key rotation and
-- package submission have an accountable human behind them rather than a script.
ALTER TABLE "publishers" ADD COLUMN "owner_id" UUID;

ALTER TABLE "publishers"
  ADD CONSTRAINT "publishers_owner_id_fkey"
  FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE SET NULL;

CREATE INDEX "publishers_owner_id_idx" ON "publishers"("owner_id");

-- One key, one publisher. Two publishers sharing a public key would make the
-- signature check ambiguous: a package signed by that key could be attributed to
-- either of them, which defeats the point of attributing it at all.
CREATE UNIQUE INDEX "publishers_public_key_key" ON "publishers"("public_key");

-- Kill switch --------------------------------------------------------------
-- REJECTED alone only stops NEW downloads. A runtime that already cached a
-- bundle keeps serving it — possibly for months. These columns record the pull,
-- and the revoke endpoint additionally purges the runtime caches and moves
-- affected sites back to safety.
ALTER TABLE "theme_versions"
  ADD COLUMN "revoked_at" TIMESTAMP(3),
  ADD COLUMN "revoked_reason" TEXT;

ALTER TABLE "plugin_versions"
  ADD COLUMN "revoked_at" TIMESTAMP(3),
  ADD COLUMN "revoked_reason" TEXT;
