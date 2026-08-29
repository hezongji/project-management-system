-- CreateTable
CREATE TABLE "public"."UrgeRecord" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "projectCode" TEXT NOT NULL,
    "requirementId" TEXT NOT NULL,
    "requirementName" TEXT NOT NULL,
    "urgedById" TEXT NOT NULL,
    "targetUserId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "doneAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UrgeRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UrgeRecord_targetUserId_status_idx" ON "public"."UrgeRecord"("targetUserId", "status");

-- CreateIndex
CREATE INDEX "UrgeRecord_urgedById_status_idx" ON "public"."UrgeRecord"("urgedById", "status");

-- CreateIndex
CREATE INDEX "UrgeRecord_requirementId_idx" ON "public"."UrgeRecord"("requirementId");

-- AddForeignKey
ALTER TABLE "public"."UrgeRecord" ADD CONSTRAINT "UrgeRecord_urgedById_fkey" FOREIGN KEY ("urgedById") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."UrgeRecord" ADD CONSTRAINT "UrgeRecord_targetUserId_fkey" FOREIGN KEY ("targetUserId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
