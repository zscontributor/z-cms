-- CreateTable
CREATE TABLE "media_folders" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "parent_id" UUID,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "media_folders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "media_folders_tenant_id_idx" ON "media_folders"("tenant_id");

-- CreateIndex
CREATE INDEX "media_folders_site_id_parent_id_idx" ON "media_folders"("site_id", "parent_id");

-- CreateIndex
CREATE UNIQUE INDEX "media_folders_site_id_parent_id_name_key" ON "media_folders"("site_id", "parent_id", "name");

-- The unique index above cannot see the root: Postgres treats every NULL as
-- distinct, so ("site", NULL, "Logos") never collides with itself and the root
-- would accept "Logos" any number of times. This partial index covers it.
CREATE UNIQUE INDEX "media_folders_site_id_root_name_key"
  ON "media_folders"("site_id", "name")
  WHERE "parent_id" IS NULL;

-- AddForeignKey
ALTER TABLE "media_folders" ADD CONSTRAINT "media_folders_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_folders" ADD CONSTRAINT "media_folders_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_folders" ADD CONSTRAINT "media_folders_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "media_folders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "media" ADD COLUMN "folder_id" UUID;

-- CreateIndex
CREATE INDEX "media_site_id_folder_id_created_at_idx" ON "media"("site_id", "folder_id", "created_at");

-- SET NULL, not CASCADE. Deleting a folder is a filing decision; it must never
-- take the assets with it, because a live page is still rendering their URLs.
-- The files fall back to the root and stay in the library.
ALTER TABLE "media" ADD CONSTRAINT "media_folder_id_fkey" FOREIGN KEY ("folder_id") REFERENCES "media_folders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- RLS is NOT automatic for new tables. The policy loop in the
-- 20260712105000_row_level_security migration only ever saw the tables that
-- existed when it ran, so every table added later must opt in explicitly.
ALTER TABLE "media_folders" ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "media_folders"
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON "media_folders" TO zcms_app;
