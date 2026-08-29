-- ★ 2026-08-25 采购模块重构：SupplierRequest.orderId 放开 1:1 → 1:N
-- （按供应商归单：同供应商多品牌任务合并到一张订单；orderId 可重复出现）
-- DropIndex
DROP INDEX "public"."SupplierRequest_orderId_key";

-- Readme
-- 不新建反向索引：按 orderId 查询走现有 PurchaseOrder 关联，负载低。
