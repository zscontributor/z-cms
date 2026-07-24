-- Mail settings: how a site sends email, and the credential it sends with.
--
-- A table rather than a corner of sites.settings, because a JSONB blob is read
-- wholesale and an SMTP password has no business riding along in every query
-- that wanted the site's locale. Here it is one column, it is encrypted with
-- MAIL_ENCRYPTION_KEY (AES-256-GCM, the same v1.<iv>.<tag>.<ct> envelope as a
-- TOTP secret), and the DTO the API returns has no field to leak it into.

-- CreateTable
CREATE TABLE "site_mail_settings" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "host" TEXT NOT NULL,
    "port" INTEGER NOT NULL DEFAULT 587,
    "secure" BOOLEAN NOT NULL DEFAULT false,
    "username" TEXT,
    "password_encrypted" TEXT,
    "from_name" TEXT NOT NULL,
    "from_email" TEXT NOT NULL,
    "reply_to" TEXT,
    "last_test_at" TIMESTAMP(3),
    "last_test_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "site_mail_settings_pkey" PRIMARY KEY ("id")
);

-- One configuration per site. A second row would be a second answer to "which
-- server does this site send from", and the code would have to pick one.
CREATE UNIQUE INDEX "site_mail_settings_site_id_key" ON "site_mail_settings"("site_id");

-- CreateIndex
CREATE INDEX "site_mail_settings_tenant_id_idx" ON "site_mail_settings"("tenant_id");

-- AddForeignKey
ALTER TABLE "site_mail_settings" ADD CONSTRAINT "site_mail_settings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_mail_settings" ADD CONSTRAINT "site_mail_settings_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS is NOT automatic for new tables. The policy loop in the
-- 20260712105000_row_level_security migration only ever saw the tables that
-- existed when it ran, so every table added later must opt in explicitly.
--
-- It matters more here than almost anywhere else: without the policy, one
-- tenant's application-role query could read another tenant's mail credential.
ALTER TABLE "site_mail_settings" ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "site_mail_settings"
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON "site_mail_settings" TO zcms_app;
