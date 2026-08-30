-- CreateEnum
CREATE TYPE "public"."FolderKind" AS ENUM ('SYSTEM', 'USER');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "public"."FileAccessAction" ADD VALUE 'CREATE';
ALTER TYPE "public"."FileAccessAction" ADD VALUE 'RENAME';
ALTER TYPE "public"."FileAccessAction" ADD VALUE 'DELETE';
ALTER TYPE "public"."FileAccessAction" ADD VALUE 'RESTORE';
ALTER TYPE "public"."FileAccessAction" ADD VALUE 'PURGE';
ALTER TYPE "public"."FileAccessAction" ADD VALUE 'COPY';

-- AlterTable
ALTER TABLE "public"."File" ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "deletedById" TEXT,
ADD COLUMN     "folderId" TEXT;

-- AlterTable
ALTER TABLE "public"."FileCatalog" ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "deletedById" TEXT,
ADD COLUMN     "kind" "public"."FolderKind" NOT NULL DEFAULT 'USER',
ADD COLUMN     "path" TEXT NOT NULL DEFAULT '';

-- CreateIndex
CREATE INDEX "File_projectId_folderId_deletedAt_idx" ON "public"."File"("projectId", "folderId", "deletedAt");

-- CreateIndex
CREATE INDEX "File_folderId_originalName_idx" ON "public"."File"("folderId", "originalName");

-- CreateIndex
CREATE INDEX "FileCatalog_projectId_deletedAt_idx" ON "public"."FileCatalog"("projectId", "deletedAt");

-- AddForeignKey
ALTER TABLE "public"."File" ADD CONSTRAINT "File_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "public"."FileCatalog"("id") ON DELETE SET NULL ON UPDATE CASCADE;

