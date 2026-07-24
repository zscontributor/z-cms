-- Theme drafts: the GUI Theme Editor's working document.
--
-- A draft is a DRAWING (a LayoutDocument), not a theme. It carries no bundle, no
-- checksum and no signature, because none of those exist until the build job
-- generates code from it and signs the package. That is why this is its own table
-- rather than nullable columns on theme_versions: a catalog row with no signature
-- is a row every signature check would have to special-case.
--
-- TENANT data, not platform catalog. An unfinished, unpublished design belongs to
-- the tenant who drew it; the shared registry starts at submission.

-- CreateEnum
CREATE TYPE "ThemeDraftStatus" AS ENUM ('DRAFT', 'BUILDING', 'BUILT', 'SUBMITTED', 'FAILED');

-- CreateTable
CREATE TABLE "theme_drafts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "author_id" UUID,
    "name" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "version" TEXT NOT NULL DEFAULT '0.1.0',
    "description" TEXT,
    "document" JSONB NOT NULL,
    "status" "ThemeDraftStatus" NOT NULL DEFAULT 'DRAFT',
    "build_error" TEXT,
    "last_built_at" TIMESTAMP(3),
    "submitted_at" TIMESTAMP(3),
    "submission_ref" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "theme_drafts_pkey" PRIMARY KEY ("id")
);

-- One drawing per proposed theme key per tenant. Two drafts claiming the same key
-- would race to register the same ThemeVersion, and the loser's build would fail at
-- the very end with an error about a key its author never typed twice.
CREATE UNIQUE INDEX "theme_drafts_tenant_id_key_key" ON "theme_drafts"("tenant_id", "key");

-- CreateIndex
CREATE INDEX "theme_drafts_tenant_id_idx" ON "theme_drafts"("tenant_id");

-- CreateIndex
CREATE INDEX "theme_drafts_site_id_idx" ON "theme_drafts"("site_id");

-- AddForeignKey
ALTER TABLE "theme_drafts" ADD CONSTRAINT "theme_drafts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "theme_drafts" ADD CONSTRAINT "theme_drafts_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A draft outlives the person who drew it: SET NULL, not CASCADE. Deleting a
-- departing employee's account must not silently delete the theme the company is
-- about to publish.
ALTER TABLE "theme_drafts" ADD CONSTRAINT "theme_drafts_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- RLS is NOT automatic for new tables. The policy loop in the
-- 20260712105000_row_level_security migration only ever saw the tables that existed
-- when it ran, so every table added later must opt in explicitly.
--
-- Without the policy, one tenant's application-role query could read another
-- tenant's unpublished theme design.
ALTER TABLE "theme_drafts" ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "theme_drafts"
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON "theme_drafts" TO zcms_app;
