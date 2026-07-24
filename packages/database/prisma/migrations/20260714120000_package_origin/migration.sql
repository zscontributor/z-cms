-- Records where each package version came from, as a first-class column instead of
-- something the code re-derives every time from `bundle_url IS NULL` (which meant
-- "built-in") or `is_core` (seed-only). Both were binary; neither could name a third
-- source. A runtime now reads WHICH pinned key to verify a version against from this
-- column, and the admin groups Verified (BUILTIN, MARKETPLACE) apart from Unverified
-- (SIDELOAD) from it.
--
-- The column is NOT NULL with no default: every insert must state the origin, so a
-- future code path cannot let a package slip into the wrong trust class by omission.
-- Existing rows are backfilled first, then the constraint is set — the column is
-- added nullable so the backfill has something to write into.

-- CreateEnum
CREATE TYPE "Origin" AS ENUM ('BUILTIN', 'MARKETPLACE', 'SIDELOAD');

-- AlterTable: theme_versions
ALTER TABLE "theme_versions" ADD COLUMN "origin" "Origin";

-- Backfill: before this feature, a version either shipped inside the image (no
-- bundle to distribute -> BUILTIN) or came from the marketplace (has a bundle).
-- There were no sideloads, so this partition is exhaustive.
UPDATE "theme_versions"
SET "origin" = CASE WHEN "bundle_url" IS NULL THEN 'BUILTIN'::"Origin" ELSE 'MARKETPLACE'::"Origin" END;

ALTER TABLE "theme_versions" ALTER COLUMN "origin" SET NOT NULL;

-- AlterTable: plugin_versions (same reasoning)
ALTER TABLE "plugin_versions" ADD COLUMN "origin" "Origin";

UPDATE "plugin_versions"
SET "origin" = CASE WHEN "bundle_url" IS NULL THEN 'BUILTIN'::"Origin" ELSE 'MARKETPLACE'::"Origin" END;

ALTER TABLE "plugin_versions" ALTER COLUMN "origin" SET NOT NULL;
