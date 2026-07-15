-- Publisher key rotation ---------------------------------------------------
-- A publisher is the reviewed identity; keys are credentials that can rotate.
-- Existing publishers keep their current public_key as an ACTIVE key.

CREATE TYPE "PublisherKeyStatus" AS ENUM (
  'PENDING',
  'ACTIVE',
  'RETIRED',
  'REVOKED',
  'COMPROMISED'
);

CREATE TABLE "publisher_keys" (
  "id" UUID NOT NULL,
  "publisher_id" UUID NOT NULL,
  "public_key" TEXT NOT NULL,
  "status" "PublisherKeyStatus" NOT NULL DEFAULT 'PENDING',
  "label" TEXT,
  "verified_at" TIMESTAMP(3),
  "retired_at" TIMESTAMP(3),
  "revoked_at" TIMESTAMP(3),
  "revoke_reason" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "publisher_keys_pkey" PRIMARY KEY ("id")
);

INSERT INTO "publisher_keys" (
  "id",
  "publisher_id",
  "public_key",
  "status",
  "label",
  "verified_at",
  "created_at"
)
SELECT
  gen_random_uuid(),
  "id",
  "public_key",
  CASE WHEN "verified" THEN 'ACTIVE'::"PublisherKeyStatus" ELSE 'PENDING'::"PublisherKeyStatus" END,
  'Original key',
  CASE WHEN "verified" THEN CURRENT_TIMESTAMP ELSE NULL END,
  "created_at"
FROM "publishers"
WHERE "public_key" IS NOT NULL;

CREATE UNIQUE INDEX "publisher_keys_public_key_key" ON "publisher_keys"("public_key");
CREATE INDEX "publisher_keys_publisher_id_idx" ON "publisher_keys"("publisher_id");
CREATE INDEX "publisher_keys_status_idx" ON "publisher_keys"("status");

ALTER TABLE "publisher_keys"
  ADD CONSTRAINT "publisher_keys_publisher_id_fkey"
  FOREIGN KEY ("publisher_id") REFERENCES "publishers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "theme_versions" ADD COLUMN "publisher_key_id" UUID;
ALTER TABLE "plugin_versions" ADD COLUMN "publisher_key_id" UUID;

ALTER TABLE "theme_versions"
  ADD CONSTRAINT "theme_versions_publisher_key_id_fkey"
  FOREIGN KEY ("publisher_key_id") REFERENCES "publisher_keys"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "plugin_versions"
  ADD CONSTRAINT "plugin_versions_publisher_key_id_fkey"
  FOREIGN KEY ("publisher_key_id") REFERENCES "publisher_keys"("id") ON DELETE SET NULL ON UPDATE CASCADE;

DROP INDEX IF EXISTS "publishers_public_key_key";
ALTER TABLE "publishers" DROP COLUMN "public_key";
