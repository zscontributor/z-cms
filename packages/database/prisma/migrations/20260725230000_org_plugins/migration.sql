-- Org-wide plugins: a plugin installed once for a whole tenant rather than per
-- site. The model (OrgPlugin, @@map("org_plugins")) and the code that reads it
-- (PluginsService.renderContributionsFor, on the render hot path) shipped without
-- this table, so every render/resolve threw P2021 "relation org_plugins does not
-- exist" and every public site returned 500. This creates the table it needs.

-- CreateTable
CREATE TABLE "org_plugins" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "plugin_id" UUID NOT NULL,
    "version_id" UUID NOT NULL,
    "status" "InstallStatus" NOT NULL DEFAULT 'INACTIVE',
    "settings" JSONB NOT NULL DEFAULT '{}',
    "granted_permissions" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "org_plugins_pkey" PRIMARY KEY ("id")
);

-- One activation of a plugin per tenant.
CREATE UNIQUE INDEX "org_plugins_tenant_id_plugin_id_key" ON "org_plugins"("tenant_id", "plugin_id");

-- CreateIndex
CREATE INDEX "org_plugins_tenant_id_idx" ON "org_plugins"("tenant_id");

-- AddForeignKey
ALTER TABLE "org_plugins" ADD CONSTRAINT "org_plugins_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey. RESTRICT, not CASCADE: a plugin/version in use org-wide must not
-- be deletable out from under the tenants running it.
ALTER TABLE "org_plugins" ADD CONSTRAINT "org_plugins_plugin_id_fkey" FOREIGN KEY ("plugin_id") REFERENCES "plugins"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_plugins" ADD CONSTRAINT "org_plugins_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "plugin_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- RLS is NOT automatic for new tables. org_plugins carries a tenant's granted
-- permissions and settings — without this policy one tenant's application-role
-- query could read or activate another tenant's org plugins.
ALTER TABLE "org_plugins" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "org_plugins"
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON "org_plugins" TO zcms_app;
