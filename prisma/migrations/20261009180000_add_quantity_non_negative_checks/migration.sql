-- Phase 3 invariants: non-negative checks for quantity- and amount-shaped
-- fields, aligned with the validation layer (src/lib/api-validations.ts
-- enforces z.number().positive() / z.number().min(0) on every write path).
--
-- Deliberately NOT constrained (negatives are meaningful there):
--   * StockCountItem.variance            - counted - system, signed
--   * StockAdjustment.variance           - signed by definition
-- Any CHECK violation here therefore indicates a bug, never a business case.
--
-- All checks are >= 0 (not > 0) so zero remains a legal "none received /
-- nothing counted" value, matching the @default(0) columns.

ALTER TABLE "StockTransaction" ADD CONSTRAINT "StockTransaction_quantity_non_negative" CHECK ("quantity" >= 0);

ALTER TABLE "ResourceRequest" ADD CONSTRAINT "ResourceRequest_quantity_non_negative" CHECK ("quantity" >= 0);
ALTER TABLE "ResourceRequest" ADD CONSTRAINT "ResourceRequest_approvedQuantity_non_negative" CHECK ("approvedQuantity" IS NULL OR "approvedQuantity" >= 0);

ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_totalAmount_non_negative" CHECK ("totalAmount" >= 0);

ALTER TABLE "PurchaseOrderItem" ADD CONSTRAINT "PurchaseOrderItem_quantity_non_negative" CHECK ("quantity" >= 0);
ALTER TABLE "PurchaseOrderItem" ADD CONSTRAINT "PurchaseOrderItem_quantityReceived_non_negative" CHECK ("quantityReceived" >= 0);
ALTER TABLE "PurchaseOrderItem" ADD CONSTRAINT "PurchaseOrderItem_totalPrice_non_negative" CHECK ("totalPrice" >= 0);

ALTER TABLE "WasteRecord" ADD CONSTRAINT "WasteRecord_quantity_non_negative" CHECK ("quantity" >= 0);

ALTER TABLE "StockCountItem" ADD CONSTRAINT "StockCountItem_systemQuantity_non_negative" CHECK ("systemQuantity" >= 0);
ALTER TABLE "StockCountItem" ADD CONSTRAINT "StockCountItem_countedQuantity_non_negative" CHECK ("countedQuantity" IS NULL OR "countedQuantity" >= 0);

ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_minimumStockLevel_non_negative" CHECK ("minimumStockLevel" >= 0);
ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_maximumStockLevel_non_negative" CHECK ("maximumStockLevel" IS NULL OR "maximumStockLevel" >= 0);
ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_reorderPoint_non_negative" CHECK ("reorderPoint" IS NULL OR "reorderPoint" >= 0);
ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_reorderQuantity_non_negative" CHECK ("reorderQuantity" IS NULL OR "reorderQuantity" >= 0);
