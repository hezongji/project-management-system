-- AlterTable (v1.2 W1: 会话列表置顶/免打扰/删除)
ALTER TABLE "public"."ConversationMember" ADD COLUMN "isPinned" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "public"."ConversationMember" ADD COLUMN "hiddenAt" TIMESTAMP(3);
