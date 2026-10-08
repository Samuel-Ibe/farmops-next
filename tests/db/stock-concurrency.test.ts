// @vitest-environment node
/**
 * Real-PostgreSQL concurrency & integrity tests (roadmap Phase 2).
 *
 * Unlike tests/security/stock-race.test.ts — which proves the *logic* of the
 * conditional-UPDATE helper against an in-memory stub — this suite runs the
 * same helper against an actual PostgreSQL instance so the locking behaviour
 * is exercised for real: row locks, blocked writers, READ COMMITTED snapshot
 * re-evaluation, transaction rollback and CHECK constraints.
 *
 * Gating: requires DB_TEST_DATABASE_URL to point at a **disposable** database
 * with `prisma migrate deploy` applied. The suite — including its fixture
 * hooks — is skipped entirely without it, and never falls back to
 * DATABASE_URL, so it can never mutate a developer's working database.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { applyStockDelta } from "@/lib/stock";

const DB_URL = process.env.DB_TEST_DATABASE_URL;

if (!DB_URL) {
  console.warn(
    "[stock-concurrency] DB_TEST_DATABASE_URL not set — skipping real-PostgreSQL tests. " +
      "Point it at a disposable database (prisma migrate deploy) to run them."
  );
}

const prisma = DB_URL ? new PrismaClient({ datasourceUrl: DB_URL }) : new PrismaClient();

// Unique per-run markers so a stale run can never collide with real data.
const RUN = `dbtest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function makeBatch(itemId: string, warehouseId: string, batchNumber: string, qty: number) {
  const batch = await prisma.inventoryBatch.create({
    data: {
      itemId,
      batchNumber,
      purchasePrice: 10,
      quantity: qty,
      quantityRemaining: qty,
      warehouseId,
      status: "ACTIVE",
    },
  });
  return batch.id;
}

function remaining(batchId: string) {
  return prisma.inventoryBatch
    .findUnique({ where: { id: batchId }, select: { quantityRemaining: true, status: true } })
    .then((row) => row!.quantityRemaining);
}

/** Deduct `qty` units the way every route does: inside a transaction. */
function deduct(batchId: string, qty: number) {
  return prisma.$transaction((tx) => applyStockDelta(tx, batchId, -qty));
}

const suite = DB_URL ? describe : describe.skip;

suite("real PostgreSQL — stock concurrency, rollback and invariants", () => {
  let farmId = "";
  let warehouseId = "";
  let itemId = "";
  let userId = "";
  const batchIds: string[] = [];

  const mkBatch = (batchNumber: string, qty: number) => {
    const idPromise = makeBatch(itemId, warehouseId, batchNumber, qty);
    idPromise.then((id) => batchIds.push(id));
    return idPromise;
  };

  beforeAll(async () => {
    const category = await prisma.category.create({ data: { name: `${RUN}-category` } });
    const farm = await prisma.farm.create({ data: { name: `${RUN}-farm`, location: "test" } });
    const warehouse = await prisma.warehouse.create({
      data: { name: `${RUN}-warehouse`, farmId: farm.id },
    });
    const item = await prisma.inventoryItem.create({
      data: { name: `${RUN}-item`, categoryId: category.id, unitOfMeasure: "kg" },
    });
    const user = await prisma.user.create({
      data: {
        name: `${RUN}-user`,
        email: `${RUN}@example.test`,
        // Never a usable credential: this row exists only to satisfy the
        // performedById foreign key and can never authenticate.
        password: "__db_test_placeholder__",
        role: "ADMIN",
        farmId: farm.id,
      },
    });
    farmId = farm.id;
    warehouseId = warehouse.id;
    itemId = item.id;
    userId = user.id;
  });

  afterAll(async () => {
    // Teardown order respects FKs.
    await prisma.stockTransaction.deleteMany({ where: { batchId: { in: batchIds } } });
    await prisma.inventoryBatch.deleteMany({ where: { id: { in: batchIds } } });
    await prisma.user.deleteMany({ where: { email: { contains: RUN } } });
    await prisma.inventoryItem.deleteMany({ where: { id: itemId } });
    await prisma.category.deleteMany({ where: { name: `${RUN}-category` } });
    await prisma.warehouse.deleteMany({ where: { id: warehouseId } });
    await prisma.farm.deleteMany({ where: { id: farmId } });
    await prisma.$disconnect();
  });

  describe("concurrent stock deductions", () => {
    it("two simultaneous 80-unit deductions from 100 units: exactly one succeeds, final stock is 20", async () => {
      const batchId = await mkBatch(`${RUN}-race-80`, 100);

      const results = await Promise.all([deduct(batchId, 80), deduct(batchId, 80)]);

      const wins = results.filter((r) => r.ok);
      const losses = results.filter((r) => !r.ok);

      expect(wins).toHaveLength(1);
      expect(losses).toHaveLength(1);
      expect(losses[0]).toMatchObject({ ok: false, reason: "INSUFFICIENT_STOCK" });

      expect(await remaining(batchId)).toBe(20);
    });

    it("20 concurrent 10-unit deductions from 100 units: never negative, exactly 10 succeed", async () => {
      const batchId = await mkBatch(`${RUN}-race-storm`, 100);

      const results = await Promise.all(
        Array.from({ length: 20 }, () => deduct(batchId, 10))
      );

      const wins = results.filter((r) => r.ok);
      expect(wins).toHaveLength(10);

      const after = await remaining(batchId);
      expect(after).toBe(0);
      expect(after).toBeGreaterThanOrEqual(0);
    });

    it("concurrent inbound and outbound deltas never corrupt the row", async () => {
      const batchId = await mkBatch(`${RUN}-race-mixed`, 100);

      await Promise.all([
        deduct(batchId, 15),
        prisma.$transaction((tx) => applyStockDelta(tx, batchId, +25)),
        deduct(batchId, 15),
        prisma.$transaction((tx) => applyStockDelta(tx, batchId, +5)),
      ]);

      // 100 - 15 - 15 + 25 + 5 = 100; regardless of interleaving the final
      // value must equal start + sum(deltas) because each update is atomic.
      expect(await remaining(batchId)).toBe(100);
    });
  });

  describe("rollback / failure paths", () => {
    it("a failure AFTER a stock mutation rolls back inventory, status and the transaction record", async () => {
      const batchId = await mkBatch(`${RUN}-rollback-1`, 100);
      const txCountBefore = await prisma.stockTransaction.count({ where: { batchId } });

      await expect(
        prisma.$transaction(async (tx) => {
          const adjustment = await applyStockDelta(tx, batchId, -30);
          if (!adjustment.ok) throw new Error("unexpected adjustment failure");
          await tx.stockTransaction.create({
            data: {
              type: "ISSUED",
              batchId,
              quantity: 30,
              performedById: userId,
              farmId,
            },
          });
          // Simulated failure after the mutation (e.g. downstream service error).
          throw new Error("forced failure after stock mutation");
        })
      ).rejects.toThrow("forced failure after stock mutation");

      expect(await remaining(batchId)).toBe(100);
      expect(await prisma.stockTransaction.count({ where: { batchId } })).toBe(txCountBefore);
      const batch = await prisma.inventoryBatch.findUnique({
        where: { id: batchId },
        select: { status: true },
      });
      expect(batch!.status).toBe("ACTIVE");
    });

    it("a failure mid-transfer leaves both source and destination untouched", async () => {
      const sourceId = await mkBatch(`${RUN}-rollback-src`, 100);
      const destId = await mkBatch(`${RUN}-rollback-dest`, 40);

      await expect(
        prisma.$transaction(async (tx) => {
          const out = await applyStockDelta(tx, sourceId, -50);
          if (!out.ok) throw new Error("unexpected source failure");
          const inc = await applyStockDelta(tx, destId, +50);
          if (!inc.ok) throw new Error("unexpected dest failure");
          throw new Error("forced failure mid-transfer");
        })
      ).rejects.toThrow("forced failure mid-transfer");

      expect(await remaining(sourceId)).toBe(100);
      expect(await remaining(destId)).toBe(40);
    });
  });

  describe("database invariants", () => {
    it("CHECK constraint InventoryBatch_quantityRemaining_non_negative is deployed", async () => {
      const rows = await prisma.$queryRaw<{ conname: string }[]>`
        SELECT conname FROM pg_constraint
        WHERE conname = 'InventoryBatch_quantityRemaining_non_negative'
          AND conrelid = '"InventoryBatch"'::regclass
      `;
      expect(
        rows,
        "CHECK constraint missing — the migrations in prisma/migrations have not been " +
          "deployed to this database. Run `npx prisma migrate deploy` (never db push)."
      ).toHaveLength(1);
    });

    it("the database itself rejects negative remaining stock", async () => {
      const batchId = await mkBatch(`${RUN}-check`, 5);

      await expect(
        prisma.inventoryBatch.update({
          where: { id: batchId },
          data: { quantityRemaining: -1 },
        })
      ).rejects.toThrow();

      expect(await remaining(batchId)).toBe(5);
    });
  });
});
