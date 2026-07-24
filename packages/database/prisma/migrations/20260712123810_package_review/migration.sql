-- CreateEnum
CREATE TYPE "ReviewStatus" AS ENUM ('PENDING', 'APPROVED', 'QUARANTINED', 'REJECTED');

-- AlterTable
ALTER TABLE "plugin_versions" ADD COLUMN     "review_status" "ReviewStatus" NOT NULL DEFAULT 'PENDING',
ADD COLUMN     "scan_report" JSONB;

-- AlterTable
ALTER TABLE "theme_versions" ADD COLUMN     "review_status" "ReviewStatus" NOT NULL DEFAULT 'PENDING',
ADD COLUMN     "scan_report" JSONB;
