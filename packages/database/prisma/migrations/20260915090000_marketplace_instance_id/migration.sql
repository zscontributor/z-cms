-- How this instance introduces itself to the marketplace it shops at.
--
-- The marketplace operator wants to know which sites are connected. Until now a
-- consumer sent nothing but the request, so every hourly revocation sync from every
-- instance in the world was an anonymous GET. This column is the one stable fact an
-- instance can offer: an id minted on first contact and kept for the life of the
-- database, so the marketplace sees one instance across restarts and redeploys.
-- Random, nullable (an instance that never talks to a marketplace never mints one),
-- and unrelated to any tenant or user — it names the database, nothing else.

-- AlterTable
ALTER TABLE "marketplace_sync" ADD COLUMN "instance_id" UUID;

-- CreateIndex
CREATE UNIQUE INDEX "marketplace_sync_instance_id_key" ON "marketplace_sync"("instance_id");
