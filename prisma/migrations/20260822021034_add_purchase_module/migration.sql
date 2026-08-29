-- CreateEnum
CREATE TYPE "public"."PurchaseRequestStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'PROCESSING', 'DECOMPOSED', 'COMPLETED', 'REJECTED');

-- CreateEnum
CREATE TYPE "public"."PurchaseRequestPriority" AS ENUM ('LOW', 'NORMAL', 'URGENT');

-- CreateEnum
CREATE TYPE "public"."SupplierRequestStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'QUOTED', 'ORDERED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "public"."PurchaseOrderStatus" AS ENUM ('DRAFT', 'ORDERED', 'PARTIAL', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "public"."PurchaseCategory" AS ENUM ('MECHANICAL', 'ELECTRICAL', 'OTHER');

-- CreateEnum
CREATE TYPE "public"."ArrivalStatus" AS ENUM ('PENDING', 'RECEIVED', 'PARTIAL', 'REJECTED');

-- CreateTable
CREATE TABLE "public"."PurchaseRequest" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "purpose" TEXT,
    "category" "public"."PurchaseCategory" NOT NULL DEFAULT 'OTHER',
    "status" "public"."PurchaseRequestStatus" NOT NULL DEFAULT 'DRAFT',
    "priority" "public"."PurchaseRequestPriority" NOT NULL DEFAULT 'NORMAL',
    "expectedArrivalDate" TIMESTAMP(3),
    "requesterId" TEXT NOT NULL,
    "handlerId" TEXT,
    "rejectReason" TEXT,
    "remark" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PurchaseRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."PurchaseRequestItem" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "spec" TEXT,
    "brand" TEXT,
    "quantity" DECIMAL(12,2) NOT NULL,
    "unit" TEXT NOT NULL DEFAULT '件',
    "targetPrice" DECIMAL(14,2),
    "remark" TEXT,
    "allocatedQty" DECIMAL(12,2) NOT NULL DEFAULT 0,

    CONSTRAINT "PurchaseRequestItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."SupplierRequest" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "requestId" TEXT,
    "supplierId" TEXT NOT NULL,
    "title" TEXT,
    "category" "public"."PurchaseCategory" NOT NULL DEFAULT 'OTHER',
    "status" "public"."SupplierRequestStatus" NOT NULL DEFAULT 'DRAFT',
    "expectedDate" TIMESTAMP(3),
    "quoteAmount" DECIMAL(14,2),
    "quoteNote" TEXT,
    "quotedAt" TIMESTAMP(3),
    "orderId" TEXT,
    "creatorId" TEXT NOT NULL,
    "remark" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupplierRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."SupplierRequestItem" (
    "id" TEXT NOT NULL,
    "supplierRequestId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "spec" TEXT,
    "brand" TEXT,
    "quantity" DECIMAL(12,2) NOT NULL,
    "unit" TEXT NOT NULL DEFAULT '件',
    "unitPrice" DECIMAL(14,2),
    "remark" TEXT,
    "sourceRequestItemIds" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "SupplierRequestItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."PurchaseOrder" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "category" "public"."PurchaseCategory" NOT NULL DEFAULT 'MECHANICAL',
    "supplierId" TEXT,
    "title" TEXT NOT NULL,
    "status" "public"."PurchaseOrderStatus" NOT NULL DEFAULT 'DRAFT',
    "isSupplementary" BOOLEAN NOT NULL DEFAULT false,
    "supplementaryReason" TEXT,
    "supplementaryOfId" TEXT,
    "orderDate" TIMESTAMP(3),
    "plannedArrivalDate" TIMESTAMP(3),
    "amount" DECIMAL(14,2),
    "settlementAmount" DECIMAL(14,2),
    "remark" TEXT,
    "ownerId" TEXT,
    "creatorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PurchaseOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."PurchaseOrderItem" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "spec" TEXT,
    "brand" TEXT,
    "quantity" DECIMAL(12,2) NOT NULL,
    "unit" TEXT NOT NULL DEFAULT '件',
    "unitPrice" DECIMAL(14,2),
    "receivedQty" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "remark" TEXT,

    CONSTRAINT "PurchaseOrderItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."GoodsArrival" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "batchNo" TEXT NOT NULL,
    "supplierId" TEXT,
    "arrivalDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "public"."ArrivalStatus" NOT NULL DEFAULT 'PENDING',
    "remark" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GoodsArrival_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."GoodsArrivalItem" (
    "id" TEXT NOT NULL,
    "arrivalId" TEXT NOT NULL,
    "orderItemId" TEXT NOT NULL,
    "arrivedQty" DECIMAL(12,2) NOT NULL,
    "defectQty" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "rejectQty" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "remark" TEXT,

    CONSTRAINT "GoodsArrivalItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseRequest_code_key" ON "public"."PurchaseRequest"("code");

-- CreateIndex
CREATE INDEX "PurchaseRequest_projectId_status_idx" ON "public"."PurchaseRequest"("projectId", "status");

-- CreateIndex
CREATE INDEX "PurchaseRequest_requesterId_idx" ON "public"."PurchaseRequest"("requesterId");

-- CreateIndex
CREATE INDEX "PurchaseRequest_status_priority_idx" ON "public"."PurchaseRequest"("status", "priority");

-- CreateIndex
CREATE INDEX "PurchaseRequestItem_requestId_idx" ON "public"."PurchaseRequestItem"("requestId");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierRequest_code_key" ON "public"."SupplierRequest"("code");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierRequest_orderId_key" ON "public"."SupplierRequest"("orderId");

-- CreateIndex
CREATE INDEX "SupplierRequest_projectId_status_idx" ON "public"."SupplierRequest"("projectId", "status");

-- CreateIndex
CREATE INDEX "SupplierRequest_supplierId_status_idx" ON "public"."SupplierRequest"("supplierId", "status");

-- CreateIndex
CREATE INDEX "SupplierRequest_requestId_idx" ON "public"."SupplierRequest"("requestId");

-- CreateIndex
CREATE INDEX "SupplierRequestItem_supplierRequestId_idx" ON "public"."SupplierRequestItem"("supplierRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseOrder_code_key" ON "public"."PurchaseOrder"("code");

-- CreateIndex
CREATE INDEX "PurchaseOrder_projectId_status_idx" ON "public"."PurchaseOrder"("projectId", "status");

-- CreateIndex
CREATE INDEX "PurchaseOrder_supplierId_idx" ON "public"."PurchaseOrder"("supplierId");

-- CreateIndex
CREATE INDEX "PurchaseOrder_category_status_idx" ON "public"."PurchaseOrder"("category", "status");

-- CreateIndex
CREATE INDEX "PurchaseOrderItem_orderId_idx" ON "public"."PurchaseOrderItem"("orderId");

-- CreateIndex
CREATE INDEX "GoodsArrival_orderId_idx" ON "public"."GoodsArrival"("orderId");

-- CreateIndex
CREATE INDEX "GoodsArrival_projectId_arrivalDate_idx" ON "public"."GoodsArrival"("projectId", "arrivalDate");

-- CreateIndex
CREATE INDEX "GoodsArrivalItem_arrivalId_idx" ON "public"."GoodsArrivalItem"("arrivalId");

-- CreateIndex
CREATE INDEX "GoodsArrivalItem_orderItemId_idx" ON "public"."GoodsArrivalItem"("orderItemId");

-- AddForeignKey
ALTER TABLE "public"."PurchaseRequest" ADD CONSTRAINT "PurchaseRequest_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "public"."Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PurchaseRequest" ADD CONSTRAINT "PurchaseRequest_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PurchaseRequest" ADD CONSTRAINT "PurchaseRequest_handlerId_fkey" FOREIGN KEY ("handlerId") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PurchaseRequestItem" ADD CONSTRAINT "PurchaseRequestItem_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "public"."PurchaseRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."SupplierRequest" ADD CONSTRAINT "SupplierRequest_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "public"."Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."SupplierRequest" ADD CONSTRAINT "SupplierRequest_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "public"."PurchaseRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."SupplierRequest" ADD CONSTRAINT "SupplierRequest_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "public"."ExternalOrg"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."SupplierRequest" ADD CONSTRAINT "SupplierRequest_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "public"."PurchaseOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."SupplierRequest" ADD CONSTRAINT "SupplierRequest_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."SupplierRequestItem" ADD CONSTRAINT "SupplierRequestItem_supplierRequestId_fkey" FOREIGN KEY ("supplierRequestId") REFERENCES "public"."SupplierRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "public"."Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "public"."ExternalOrg"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_supplementaryOfId_fkey" FOREIGN KEY ("supplementaryOfId") REFERENCES "public"."PurchaseOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PurchaseOrderItem" ADD CONSTRAINT "PurchaseOrderItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "public"."PurchaseOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."GoodsArrival" ADD CONSTRAINT "GoodsArrival_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "public"."Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."GoodsArrival" ADD CONSTRAINT "GoodsArrival_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "public"."PurchaseOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."GoodsArrival" ADD CONSTRAINT "GoodsArrival_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "public"."ExternalOrg"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."GoodsArrival" ADD CONSTRAINT "GoodsArrival_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."GoodsArrivalItem" ADD CONSTRAINT "GoodsArrivalItem_arrivalId_fkey" FOREIGN KEY ("arrivalId") REFERENCES "public"."GoodsArrival"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."GoodsArrivalItem" ADD CONSTRAINT "GoodsArrivalItem_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "public"."PurchaseOrderItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
