-- CreateTable
CREATE TABLE "plugin_data" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "plugin_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "plugin_data_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "plugin_data_tenant_id_idx" ON "plugin_data"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "plugin_data_site_id_plugin_id_key_key" ON "plugin_data"("site_id", "plugin_id", "key");

-- AddForeignKey
ALTER TABLE "plugin_data" ADD CONSTRAINT "plugin_data_plugin_id_fkey" FOREIGN KEY ("plugin_id") REFERENCES "plugins"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS is NOT automatic for new tables. The policy loop in the
-- 20260712105000_row_level_security migration only ever saw the tables that
-- existed when it ran, so every table added later must opt in explicitly.
--
-- Forgetting this is the single easiest way to reintroduce a tenant leak: the
-- table would work perfectly, and quietly return every tenant's rows.
ALTER TABLE "plugin_data" ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "plugin_data"
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON "plugin_data" TO zcms_app;
