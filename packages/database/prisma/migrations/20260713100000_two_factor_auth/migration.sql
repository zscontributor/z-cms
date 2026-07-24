-- Two-factor authentication (TOTP).
--
-- The secret columns hold CIPHERTEXT, not plaintext and not a hash. A second
-- factor must be recomputed on every login, so it cannot be hashed — which is
-- exactly what makes it dangerous at rest. Encrypting it under a key that lives
-- in the environment is what keeps a stolen database dump from handing over
-- every second factor on the instance, and that is the one scenario 2FA exists
-- to survive. See apps/cms-api/src/auth/totp.ts.

-- AlterTable
ALTER TABLE "users"
  ADD COLUMN "totp_secret" TEXT,
  ADD COLUMN "totp_pending_secret" TEXT,
  ADD COLUMN "totp_enabled_at" TIMESTAMP(3),
  -- The last time-step consumed. A TOTP code is valid for its whole 30-second
  -- window, so without this a code seen over someone's shoulder works a second
  -- time. Codes are accepted strictly ascending.
  ADD COLUMN "totp_last_step" BIGINT;

-- CreateTable
CREATE TABLE "recovery_codes" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "code_hash" TEXT NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recovery_codes_pkey" PRIMARY KEY ("id")
);

-- One row per code, so a code can be SPENT. An array column could not express
-- "this one is used and the other nine are not" without a rewrite per login.
CREATE UNIQUE INDEX "recovery_codes_user_id_code_hash_key" ON "recovery_codes"("user_id", "code_hash");

-- CreateIndex
CREATE INDEX "recovery_codes_user_id_idx" ON "recovery_codes"("user_id");

-- CreateIndex
CREATE INDEX "recovery_codes_tenant_id_idx" ON "recovery_codes"("tenant_id");

-- AddForeignKey
ALTER TABLE "recovery_codes" ADD CONSTRAINT "recovery_codes_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recovery_codes" ADD CONSTRAINT "recovery_codes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS is NOT automatic for new tables. The policy loop in the
-- 20260712105000_row_level_security migration only ever saw the tables that
-- existed when it ran, so every table added later must opt in explicitly.
ALTER TABLE "recovery_codes" ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "recovery_codes"
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON "recovery_codes" TO zcms_app;
