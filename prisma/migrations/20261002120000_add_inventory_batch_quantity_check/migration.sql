-- Database invariant: remaining stock can never go negative.
--
-- The application already guards this with conditional UPDATEs
-- (src/lib/stock.ts), but the constraint is the last line of defence: any
-- future code path — manual SQL, a buggy migration, a lost guard — is rejected
-- by Postgres itself.
--
-- If this migration fails because existing rows violate the constraint,
-- investigate and correct them first (that would be a real data-integrity
-- incident); do not drop the constraint to make the migration pass.
ALTER TABLE "InventoryBatch"
  ADD CONSTRAINT "InventoryBatch_quantityRemaining_non_negative"
  CHECK ("quantityRemaining" >= 0);
