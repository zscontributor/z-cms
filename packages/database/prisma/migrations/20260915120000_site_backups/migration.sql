-- Site backups: one row per archive the worker builds of a site, so the admin
-- can watch it being built, download its parts and delete it — and so a site
-- can be deleted only after its owner has had the chance to take everything
-- with them.

-- CreateEnum
CREATE TYPE "SiteBackupStatus" AS ENUM ('PENDING', 'RUNNING', 'READY', 'FAILED');

-- CreateTable
CREATE TABLE "site_backups" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "status" "SiteBackupStatus" NOT NULL DEFAULT 'PENDING',
    "filename" TEXT NOT NULL,
    "part_bytes" INTEGER NOT NULL,
    "total_bytes" BIGINT,
    "parts" JSONB NOT NULL DEFAULT '[]',
    "summary" JSONB NOT NULL DEFAULT '{}',
    "error" TEXT,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "site_backups_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "site_backups_tenant_id_idx" ON "site_backups"("tenant_id");
CREATE INDEX "site_backups_site_id_created_at_idx" ON "site_backups"("site_id", "created_at");
CREATE INDEX "site_backups_expires_at_idx" ON "site_backups"("expires_at");

-- AddForeignKey
ALTER TABLE "site_backups" ADD CONSTRAINT "site_backups_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "site_backups" ADD CONSTRAINT "site_backups_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "site_backups" ADD CONSTRAINT "site_backups_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- RLS is NOT automatic for new tables (see the commerce migration). A backup
-- row names where a whole site's data sits in the bucket; a missing policy would
-- let one tenant list — and, through the download route, fetch — another's.
ALTER TABLE "site_backups" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "site_backups"
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON "site_backups" TO zcms_app;
