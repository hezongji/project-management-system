-- DropForeignKey
ALTER TABLE "public"."FileAccessLog" DROP CONSTRAINT "FileAccessLog_fileId_fkey";

-- DropForeignKey
ALTER TABLE "public"."TaskRevision" DROP CONSTRAINT "TaskRevision_taskId_fkey";

-- AlterTable
ALTER TABLE "public"."FileAccessLog" ALTER COLUMN "fileId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "public"."TaskRevision" ALTER COLUMN "taskId" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "public"."TaskRevision" ADD CONSTRAINT "TaskRevision_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "public"."Task"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."FileAccessLog" ADD CONSTRAINT "FileAccessLog_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "public"."File"("id") ON DELETE SET NULL ON UPDATE CASCADE;
