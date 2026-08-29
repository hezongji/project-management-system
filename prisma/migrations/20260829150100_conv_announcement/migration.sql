-- AlterTable (v1.2 W1: 群公告)
ALTER TABLE "public"."Conversation" ADD COLUMN "announcement" TEXT;
ALTER TABLE "public"."Conversation" ADD COLUMN "announcementAt" TIMESTAMP(3);
