-- Database invariant: a batch's original quantity can never be negative.
--
-- quantityRemaining already has its own CHECK (see the earlier
-- quantityRemaining migration). `quantity` is written only as a positive
-- creation value or a positive increment (transfers/splits credit the
-- destination), so a negative value is always a bug — this constraint is
-- the last line of defence, alongside the conditional-UPDATE guards in
-- src/lib/stock.ts.
--
-- Deliberately NOT added: a `quantityRemaining <= quantity` constraint —
-- it does not hold by design (RECEIVED transactions via /api/transactions
-- increment quantityRemaining without touching quantity).
--
-- If this migration fails because existing rows violate the constraint,
-- investigate and correct them first (a real data-integrity incident);
-- do not drop the constraint to make the migration pass.
ALTER TABLE "InventoryBatch"
  ADD CONSTRAINT "InventoryBatch_quantity_non_negative"
  CHECK ("quantity" >= 0);
