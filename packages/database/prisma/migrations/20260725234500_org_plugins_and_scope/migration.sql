-- Org-wide plugins, and the plugin `scope` that distinguishes them, as a FORWARD
-- migration.
--
-- These were first introduced by EDITING the init migration, which is why they
-- never reached databases already past init: `migrate deploy` does not re-run an
-- applied migration, so production got the new cms-api code (which queries
-- org_plugins and plugins.scope) but not the schema, and every render failed with
-- "relation org_plugins does not exist" / "column plugins.scope does not exist".
-- The init migration has been restored to its original release form; this migration
-- carries the changes forward instead, so every existing database converges through
-- `migrate deploy` and init stays immutable.
--
-- Idempotent by construction (IF NOT EXISTS / guarded ADD CONSTRAINT): a database
-- that already has these objects — because it was hotfixed by hand during the
-- incident — applies this as a clean no-op. RLS is declared explicitly here because
-- this runs AFTER the 20260712105000_row_level_security loop, which only protected
-- the tables that existed when it ran.

-- CreateEnum (guarded — no IF NOT EXISTS for CREATE TYPE before PG 16)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'PluginScope') THEN
    CREATE TYPE "PluginScope" AS ENUM ('SITE', 'ORG');
  END IF;
END $$;

-- AlterTable: the plugin catalogue gains a scope (SITE = per-site, ORG = tenant-wide).
ALTER TABLE "plugins" ADD COLUMN IF NOT EXISTS "scope" "PluginScope" NOT NULL DEFAULT 'SITE';

-- CreateTable: tenant-wide plugin activation ("network-activated" tier).
CREATE TABLE IF NOT EXISTS "org_plugins" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "plugin_id" UUID NOT NULL,
    "version_id" UUID NOT NULL,
    "status" "InstallStatus" NOT NULL DEFAULT 'INACTIVE',
    "settings" JSONB NOT NULL DEFAULT '{}',
    "granted_permissions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "org_plugins_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "org_plugins_tenant_id_idx" ON "org_plugins"("tenant_id");
CREATE UNIQUE INDEX IF NOT EXISTS "org_plugins_tenant_id_plugin_id_key" ON "org_plugins"("tenant_id", "plugin_id");

-- AddForeignKey (guarded). RESTRICT on plugin/version: a plugin in use org-wide must
-- not be deletable out from under the tenants running it.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'org_plugins_tenant_id_fkey') THEN
    ALTER TABLE "org_plugins" ADD CONSTRAINT "org_plugins_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'org_plugins_plugin_id_fkey') THEN
    ALTER TABLE "org_plugins" ADD CONSTRAINT "org_plugins_plugin_id_fkey" FOREIGN KEY ("plugin_id") REFERENCES "plugins"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'org_plugins_version_id_fkey') THEN
    ALTER TABLE "org_plugins" ADD CONSTRAINT "org_plugins_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "plugin_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- RLS. Explicit, because this table did not exist when the row_level_security loop
-- ran. org_plugins carries a tenant's granted permissions and settings — a missing
-- policy would let one tenant's application-role query read another tenant's.
ALTER TABLE "org_plugins" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "org_plugins";
CREATE POLICY tenant_isolation ON "org_plugins"
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON "org_plugins" TO zcms_app;
