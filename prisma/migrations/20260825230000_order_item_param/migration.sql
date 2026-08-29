-- ★ 2026-08-25 采购字段统一：订单明细补 param（参数）列
-- 与 PurchaseRequestItem / SupplierRequestItem 对齐（标准字段：名称/型号spec/参数param/单位/数量/品牌/备注），
-- 所有路径（AI工作台/Excel导入/手工表单/供应商归单）生成的明细字段结构一致，便于多批次清单合并汇总。
ALTER TABLE "PurchaseOrderItem" ADD COLUMN "param" TEXT;
