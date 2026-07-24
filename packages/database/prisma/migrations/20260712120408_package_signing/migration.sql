/*
  Warnings:

  - You are about to drop the column `signature` on the `plugin_versions` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "plugin_versions" DROP COLUMN "signature",
ADD COLUMN     "marketplace_signature" TEXT,
ADD COLUMN     "publisher_signature" TEXT;

-- AlterTable
ALTER TABLE "plugins" ADD COLUMN     "publisher_id" UUID;

-- AlterTable
ALTER TABLE "theme_versions" ADD COLUMN     "marketplace_signature" TEXT,
ADD COLUMN     "publisher_signature" TEXT;

-- AlterTable
ALTER TABLE "themes" ADD COLUMN     "publisher_id" UUID;

-- CreateTable
CREATE TABLE "publishers" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "public_key" TEXT NOT NULL,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "trusted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "publishers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "publishers_slug_key" ON "publishers"("slug");

-- AddForeignKey
ALTER TABLE "themes" ADD CONSTRAINT "themes_publisher_id_fkey" FOREIGN KEY ("publisher_id") REFERENCES "publishers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plugins" ADD CONSTRAINT "plugins_publisher_id_fkey" FOREIGN KEY ("publisher_id") REFERENCES "publishers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
