/*
  Warnings:

  - You are about to drop the `ProjectExpense` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "public"."ProjectExpense" DROP CONSTRAINT "ProjectExpense_approvedById_fkey";

-- DropForeignKey
ALTER TABLE "public"."ProjectExpense" DROP CONSTRAINT "ProjectExpense_categoryId_fkey";

-- DropForeignKey
ALTER TABLE "public"."ProjectExpense" DROP CONSTRAINT "ProjectExpense_createdById_fkey";

-- DropForeignKey
ALTER TABLE "public"."ProjectExpense" DROP CONSTRAINT "ProjectExpense_paidById_fkey";

-- DropForeignKey
ALTER TABLE "public"."ProjectExpense" DROP CONSTRAINT "ProjectExpense_payeeId_fkey";

-- DropForeignKey
ALTER TABLE "public"."ProjectExpense" DROP CONSTRAINT "ProjectExpense_projectId_fkey";

-- DropTable
DROP TABLE "public"."ProjectExpense";

-- CreateTable
CREATE TABLE "public"."ExpenseClaim" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "payeeId" TEXT NOT NULL,
    "status" "public"."ExpenseStatus" NOT NULL DEFAULT 'DRAFT',
    "totalAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "rejectedReason" TEXT,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "paidById" TEXT,
    "paidAt" TIMESTAMP(3),
    "remark" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExpenseClaim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ExpenseItem" (
    "id" TEXT NOT NULL,
    "claimId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "expenseDate" TIMESTAMP(3) NOT NULL,
    "description" TEXT,

    CONSTRAINT "ExpenseItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ExpenseClaim_projectId_idx" ON "public"."ExpenseClaim"("projectId");

-- CreateIndex
CREATE INDEX "ExpenseClaim_payeeId_idx" ON "public"."ExpenseClaim"("payeeId");

-- CreateIndex
CREATE INDEX "ExpenseClaim_status_idx" ON "public"."ExpenseClaim"("status");

-- CreateIndex
CREATE INDEX "ExpenseItem_claimId_idx" ON "public"."ExpenseItem"("claimId");

-- CreateIndex
CREATE INDEX "ExpenseItem_categoryId_idx" ON "public"."ExpenseItem"("categoryId");

-- AddForeignKey
ALTER TABLE "public"."ExpenseClaim" ADD CONSTRAINT "ExpenseClaim_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "public"."Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ExpenseClaim" ADD CONSTRAINT "ExpenseClaim_payeeId_fkey" FOREIGN KEY ("payeeId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ExpenseClaim" ADD CONSTRAINT "ExpenseClaim_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ExpenseClaim" ADD CONSTRAINT "ExpenseClaim_paidById_fkey" FOREIGN KEY ("paidById") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ExpenseClaim" ADD CONSTRAINT "ExpenseClaim_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ExpenseItem" ADD CONSTRAINT "ExpenseItem_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "public"."ExpenseClaim"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ExpenseItem" ADD CONSTRAINT "ExpenseItem_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "public"."ExpenseCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
