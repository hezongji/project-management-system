-- CreateTable
CREATE TABLE "public"."ExternalOrgScope" (
    "id" TEXT NOT NULL,
    "type" "public"."ExternalOrgType" NOT NULL,
    "visibility" TEXT NOT NULL DEFAULT 'RESTRICTED',
    "deptIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "userIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExternalOrgScope_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ExternalOrgScope_type_key" ON "public"."ExternalOrgScope"("type");
