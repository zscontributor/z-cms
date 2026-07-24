-- The author's marketplace identity, and the digest they sign.
--
-- publisher_key_vaults holds CIPHERTEXT THIS SERVER CANNOT OPEN: the Ed25519
-- private key, wrapped in the author's browser under a passphrase that never
-- leaves it. Unlike the SMTP password or the TOTP secret — which are encrypted
-- with an env key because cms-api has to USE them — nothing on the server ever
-- needs this key. Only the author does. A server that could open it would be a
-- server that could sign as them.
--
-- It exists because the alternative, a key that lives only in one browser, is lost
-- the day somebody clears their site data.

-- CreateTable
CREATE TABLE "publisher_key_vaults" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "public_key_pem" TEXT NOT NULL,
    "wrapped_private_key" TEXT NOT NULL,
    "kdf_salt" TEXT NOT NULL,
    "kdf_iv" TEXT NOT NULL,
    "kdf" TEXT NOT NULL DEFAULT 'PBKDF2-SHA256',
    "kdf_iterations" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "publisher_key_vaults_pkey" PRIMARY KEY ("id")
);

-- One key per person. The marketplace binds a Publisher to a single developer
-- account, so a shared team key would need a shared passphrase — and a shared
-- passphrase is one that ends up pasted into a chat.
CREATE UNIQUE INDEX "publisher_key_vaults_user_id_key" ON "publisher_key_vaults"("user_id");

-- CreateIndex
CREATE INDEX "publisher_key_vaults_tenant_id_idx" ON "publisher_key_vaults"("tenant_id");

-- AddForeignKey
ALTER TABLE "publisher_key_vaults" ADD CONSTRAINT "publisher_key_vaults_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CASCADE, unlike theme_drafts' author: a draft outlives the person who drew it,
-- but an identity does not outlive its owner. Deleting the account must take the
-- key with it — a wrapped blob nobody can open is not worth keeping, and keeping
-- it would leave an offline guessing target behind for no benefit.
ALTER TABLE "publisher_key_vaults" ADD CONSTRAINT "publisher_key_vaults_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS is NOT automatic for new tables — the policy loop in
-- 20260712105000_row_level_security only saw the tables that existed when it ran.
ALTER TABLE "publisher_key_vaults" ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "publisher_key_vaults"
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON "publisher_key_vaults" TO zcms_app;

-- The digest the author signs, and where the bytes it describes are staged.
--
-- Recorded rather than recomputed: a tar carries mtimes, so building the same
-- design twice yields two different digests. A signature made over the first would
-- not match the second, and the author would have signed a payload that no longer
-- exists.
ALTER TABLE "theme_drafts" ADD COLUMN "payload_checksum" TEXT;
ALTER TABLE "theme_drafts" ADD COLUMN "payload_ref" TEXT;
