-- AlterTable
ALTER TABLE "public"."User" ADD COLUMN     "extraVisibleProjectIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "pagePermissions" JSONB;
