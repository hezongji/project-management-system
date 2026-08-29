-- CreateEnum
CREATE TYPE "public"."ContractStatus" AS ENUM ('PENDING', 'CONFIRMED', 'VOIDED');

-- CreateEnum
CREATE TYPE "public"."PaymentType" AS ENUM ('PREPAYMENT', 'FULL', 'TAIL', 'REFUND');

-- CreateEnum
CREATE TYPE "public"."PaymentStatus" AS ENUM ('PLANNED', 'PAID');

-- CreateEnum
CREATE TYPE "public"."DeliveryType" AS ENUM ('TO_COMPANY', 'TO_CUSTOMER', 'SELF_PICKUP');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "public"."NotifType" ADD VALUE 'PURCHASE_REQUEST_SUBMITTED';
ALTER TYPE "public"."NotifType" ADD VALUE 'PURCHASE_CONTRACT_CONFIRMED';
ALTER TYPE "public"."NotifType" ADD VALUE 'PURCHASE_ORDERED';
ALTER TYPE "public"."NotifType" ADD VALUE 'PURCHASE_SHIPPED';
ALTER TYPE "public"."NotifType" ADD VALUE 'PURCHASE_RECEIVED';
ALTER TYPE "public"."NotifType" ADD VALUE 'PURCHASE_REJECTED';
ALTER TYPE "public"."NotifType" ADD VALUE 'PURCHASE_STATUS_CHANGED';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "public"."PurchaseOrderStatus" ADD VALUE 'CONTRACT_PENDING';
ALTER TYPE "public"."PurchaseOrderStatus" ADD VALUE 'CONFIRMED';
ALTER TYPE "public"."PurchaseOrderStatus" ADD VALUE 'PREPARING';
ALTER TYPE "public"."PurchaseOrderStatus" ADD VALUE 'SHIPPED';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "public"."TodoSrc" ADD VALUE 'PURCHASE_REQUEST';
ALTER TYPE "public"."TodoSrc" ADD VALUE 'PURCHASE_ORDER';
ALTER TYPE "public"."TodoSrc" ADD VALUE 'PURCHASE_RECEIPT';

-- DropForeignKey
ALTER TABLE "public"."SupplierRequest" DROP CONSTRAINT "SupplierRequest_supplierId_fkey";

-- AlterTable
ALTER TABLE "public"."GoodsArrival" ADD COLUMN     "confirmedAt" TIMESTAMP(3),
ADD COLUMN     "confirmedById" TEXT,
ADD COLUMN     "deliveryType" "public"."DeliveryType" NOT NULL DEFAULT 'TO_COMPANY',
ADD COLUMN     "proofNote" TEXT,
ADD COLUMN     "receiverId" TEXT,
ADD COLUMN     "shippingAddress" TEXT;

-- AlterTable
ALTER TABLE "public"."PurchaseOrder" ADD COLUMN     "deliveryAddress" TEXT,
ADD COLUMN     "deliveryContact" TEXT,
ADD COLUMN     "deliveryType" "public"."DeliveryType" NOT NULL DEFAULT 'TO_COMPANY',
ADD COLUMN     "paidAmount" DECIMAL(14,2) DEFAULT 0,
ADD COLUMN     "receiverId" TEXT,
ADD COLUMN     "shippedAt" TIMESTAMP(3),
ADD COLUMN     "shippingNote" TEXT;

-- AlterTable
ALTER TABLE "public"."PurchaseRequestItem" ADD COLUMN     "param" TEXT;

-- AlterTable
ALTER TABLE "public"."SupplierRequest" ADD COLUMN     "brand" TEXT,
ALTER COLUMN "supplierId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "public"."SupplierRequestItem" ADD COLUMN     "param" TEXT;

-- AlterTable
ALTER TABLE "public"."User" ADD COLUMN     "purchaseFinanceGranted" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "public"."PurchaseContract" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "contractNo" TEXT,
    "supplierContractNo" TEXT,
    "contractAmount" DECIMAL(14,2),
    "deliveryTerms" TEXT,
    "paymentTerms" TEXT,
    "fileId" TEXT,
    "status" "public"."ContractStatus" NOT NULL DEFAULT 'PENDING',
    "confirmedAt" TIMESTAMP(3),
    "confirmedById" TEXT,
    "voidReason" TEXT,
    "remark" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PurchaseContract_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."PurchasePayment" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "type" "public"."PaymentType" NOT NULL DEFAULT 'PREPAYMENT',
    "amount" DECIMAL(14,2) NOT NULL,
    "status" "public"."PaymentStatus" NOT NULL DEFAULT 'PAID',
    "paidAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "method" TEXT,
    "voucherNo" TEXT,
    "invoiceNo" TEXT,
    "createdById" TEXT NOT NULL,
    "remark" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PurchasePayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."PurchaseScopeGrant" (
    "id" TEXT NOT NULL,
    "scopeType" TEXT NOT NULL,
    "scopeId" TEXT,
    "userId" TEXT NOT NULL,
    "canViewAmount" BOOLEAN NOT NULL DEFAULT false,
    "grantedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PurchaseScopeGrant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseContract_orderId_key" ON "public"."PurchaseContract"("orderId");

-- CreateIndex
CREATE INDEX "PurchaseContract_orderId_idx" ON "public"."PurchaseContract"("orderId");

-- CreateIndex
CREATE INDEX "PurchasePayment_orderId_idx" ON "public"."PurchasePayment"("orderId");

-- CreateIndex
CREATE INDEX "PurchaseScopeGrant_userId_idx" ON "public"."PurchaseScopeGrant"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseScopeGrant_scopeType_scopeId_userId_key" ON "public"."PurchaseScopeGrant"("scopeType", "scopeId", "userId");

-- CreateIndex
CREATE INDEX "GoodsArrival_receiverId_confirmedAt_idx" ON "public"."GoodsArrival"("receiverId", "confirmedAt");

-- CreateIndex
CREATE INDEX "SupplierRequest_brand_idx" ON "public"."SupplierRequest"("brand");

-- AddForeignKey
ALTER TABLE "public"."SupplierRequest" ADD CONSTRAINT "SupplierRequest_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "public"."ExternalOrg"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_receiverId_fkey" FOREIGN KEY ("receiverId") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PurchaseContract" ADD CONSTRAINT "PurchaseContract_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "public"."PurchaseOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PurchaseContract" ADD CONSTRAINT "PurchaseContract_confirmedById_fkey" FOREIGN KEY ("confirmedById") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PurchasePayment" ADD CONSTRAINT "PurchasePayment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "public"."PurchaseOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PurchasePayment" ADD CONSTRAINT "PurchasePayment_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PurchaseScopeGrant" ADD CONSTRAINT "PurchaseScopeGrant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PurchaseScopeGrant" ADD CONSTRAINT "PurchaseScopeGrant_grantedById_fkey" FOREIGN KEY ("grantedById") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."GoodsArrival" ADD CONSTRAINT "GoodsArrival_receiverId_fkey" FOREIGN KEY ("receiverId") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."GoodsArrival" ADD CONSTRAINT "GoodsArrival_confirmedById_fkey" FOREIGN KEY ("confirmedById") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
