-- AddForeignKey
ALTER TABLE "public"."ProjectExpense" ADD CONSTRAINT "ProjectExpense_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ProjectExpense" ADD CONSTRAINT "ProjectExpense_paidById_fkey" FOREIGN KEY ("paidById") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
