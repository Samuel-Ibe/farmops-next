/**
 * Phase 2 — Real-PostgreSQL concurrency & transaction integrity.
 *
 * Every scenario drives the REAL HTTP API with genuinely overlapping
 * requests (independent Playwright request contexts against the running
 * Next server, whose pooled Prisma client hands each request its own
 * database connection) and then verifies final state by querying
 * PostgreSQL DIRECTLY — an HTTP response alone never proves an invariant.
 *
 * Invariants under test:
 *  - `quantityRemaining` never goes negative and stock is never double-spent
 *    under racing withdrawals, transfers and adjustments (the Postgres
 *    CHECK constraint and the conditional-UPDATE guard must both hold).
 *  - A rejected/failed mutation leaves NO partial business state: no batch,
 *    no ledger row, no purchase-order item marked received, no status flip.
 *  - Idempotency: one key + one payload = exactly one logical mutation,
 *    replayable; a different payload on the same key is rejected; a failed
 *    attempt releases the key.
 *
 * Loser status codes follow the API's established contract: 400 when the
 * friendly pre-check sees the already-updated stock, 409 when the request
 * genuinely raced and lost the conditional UPDATE. Assertions accept the
 * contract's full range and pin the DATABASE outcome exactly.
 *
 * No arbitrary sleeps coordinate anything: overlap comes from Promise.all
 * and each request carries a 20s timeout so a deadlock or hung transaction
 * fails the test instead of hanging the suite.
 *
 * Requires: running FarmOps server (BASE_URL) and DATABASE_URL. Runs in
 * CI's E2E job after api/auth/concurrency ordering (alphabetical file
 * order, workers=1). All leftover rows use `E2E-CC` markers, which carry
 * no `E2E-B` tenant marker, so the tenant-isolation suite stays green.
 */
import { test, expect, type APIRequestContext } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import {
  EMAIL,
  ensureTenantFixtures,
  apiFor,
  type FixtureIds,
} from "./tenant-fixtures";

const baseURL = process.env.BASE_URL || "http://localhost:3000";
/** Per-request timeout: a deadlock or hung transaction fails fast. */
const REQ_TIMEOUT = 20_000;
const runId = Date.now().toString(36).toUpperCase();

let F: FixtureIds;
let prisma: PrismaClient;

/** DB helpers — final state is always verified directly against Postgres. */
async function batchRow(id: string) {
  const row = await prisma.inventoryBatch.findUnique({
    where: { id },
    select: { quantity: true, quantityRemaining: true, status: true, itemId: true, warehouseId: true },
  });
  expect(row, `batch ${id} must exist in the database`).not.toBeNull();
  return row!;
}

type LedgerType = "ISSUED" | "TRANSFERRED" | "ADJUSTED" | "RECEIVED";

async function ledgerCount(batchId: string, type?: LedgerType): Promise<number> {
  return prisma.stockTransaction.count({
    where: { batchId, ...(type ? { type } : {}) },
  });
}

async function systemStockOfItem(itemId: string): Promise<number> {
  const rows = await prisma.inventoryBatch.findMany({
    where: { itemId },
    select: { quantityRemaining: true },
  });
  return rows.reduce((sum, r) => sum + r.quantityRemaining, 0);
}

/** Create a dedicated batch with a known quantity through the real API. */
async function makeBatch(
  ctx: APIRequestContext,
  label: string,
  quantity: number
): Promise<string> {
  const res = await ctx.post("/api/batches", {
    timeout: REQ_TIMEOUT,
    data: {
      itemId: F.itemA,
      batchNumber: `E2E-CC-${label}-${runId}`,
      warehouseId: F.warehouseA,
      quantityReceived: quantity,
      purchasePrice: 1,
    },
  });
  expect(res.status(), `setup batch ${label}`).toBe(201);
  const { id } = (await res.json()) as { id: string };
  return id;
}

/** A loser of a stock race: contract allows 400 (pre-check) or 409 (race). */
function expectInsufficientStock(status: number, body: string, label: string): void {
  expect([400, 409], `${label}: loser must be 400 or 409, got ${status}`).toContain(status);
  expect(body.toLowerCase()).toContain("insufficient stock");
}

test.describe.serial("Phase 2 — concurrency & transaction integrity (real PostgreSQL)", () => {
  let ctxA: APIRequestContext;
  let ctxAdmin: APIRequestContext;
  let warehouseC: string;

  // Shared across S6→S8 (idempotency lifecycle)
  let s6Key: string;
  let s6BatchId: string;
  let s6TxId: string;

  test.beforeAll(async () => {
    F = await ensureTenantFixtures();
    prisma = new PrismaClient();
    [ctxA, ctxAdmin] = await Promise.all([
      apiFor(baseURL, EMAIL.managerA),
      apiFor(baseURL, EMAIL.admin),
    ]);
    // A third same-farm warehouse for transfer scenarios.
    const wh = await ctxA.post("/api/warehouses", {
      data: { name: `E2E-CC-WH-C-${runId}`, farmId: F.farmA, location: "phase-2 concurrency" },
    });
    expect(wh.status()).toBe(201);
    warehouseC = ((await wh.json()) as { id: string }).id;
  });

  test.afterAll(async () => {
    await Promise.all(
      [ctxA, ctxAdmin].map((c) => c && c.dispose().catch(() => undefined))
    );
    await prisma?.$disconnect();
  });

  test("S1: two concurrent 80-unit withdrawals from 100 — exactly one wins, 20 remain", async () => {
    const ctx = await apiFor(baseURL, EMAIL.managerA);
    try {
      const batchId = await makeBatch(ctx, "S1", 100);
      const stockBefore = await systemStockOfItem(F.itemA);

      const [r1, r2] = await Promise.all([
        ctx.post("/api/transactions", {
          timeout: REQ_TIMEOUT,
          data: { type: "ISSUED", batchId, quantity: 80, reason: "E2E-CC S1 draw" },
        }),
        ctx.post("/api/transactions", {
          timeout: REQ_TIMEOUT,
          data: { type: "ISSUED", batchId, quantity: 80, reason: "E2E-CC S1 draw" },
        }),
      ]);

      const statuses = [r1.status(), r2.status()].sort();
      expect(statuses, "exactly one withdrawal must succeed").toEqual([201, statuses[1]]);
      expect(statuses[1], "the loser must fail safely").not.toBe(201);
      const loser = r1.status() === 201 ? r2 : r1;
      expectInsufficientStock(loser.status(), await loser.text(), "S1 loser");

      // Database evidence, independent of HTTP responses:
      const row = await batchRow(batchId);
      expect(row.quantityRemaining, "100 - 80 = 20, never negative, never 160 issued").toBe(20);
      expect(row.status).toBe("ACTIVE");
      expect(await ledgerCount(batchId, "ISSUED"), "exactly one ledger row").toBe(1);
      expect(await systemStockOfItem(F.itemA)).toBe(stockBefore - 80);
    } finally {
      await ctx.dispose().catch(() => undefined);
    }
  });

  test("S2: six concurrent 25-unit draws against one batch — exactly four succeed", async () => {
    const ctx = await apiFor(baseURL, EMAIL.managerA);
    try {
      const batchId = await makeBatch(ctx, "S2", 100);

      const results = await Promise.all(
        Array.from({ length: 6 }, () =>
          ctx.post("/api/transactions", {
            timeout: REQ_TIMEOUT,
            data: { type: "ISSUED", batchId, quantity: 25, reason: "E2E-CC S2 draw" },
          })
        )
      );

      const wins = results.filter((r) => r.status() === 201);
      const losses = results.filter((r) => r.status() !== 201);
      expect(wins, "25 x 4 = 100 — exactly four draws fit").toHaveLength(4);
      expect(losses).toHaveLength(2);
      for (const loser of losses) {
        expectInsufficientStock(loser.status(), await loser.text(), "S2 loser");
      }

      const row = await batchRow(batchId);
      expect(row.quantityRemaining).toBe(0);
      expect(row.status, "a drained batch must be DEPLETED").toBe("DEPLETED");
      expect(await ledgerCount(batchId, "ISSUED")).toBe(4);
    } finally {
      await ctx.dispose().catch(() => undefined);
    }
  });

  test("S3: a transfer racing a withdrawal from the source warehouse", async () => {
    const ctx = await apiFor(baseURL, EMAIL.managerA);
    try {
      const batchId = await makeBatch(ctx, "S3", 100);
      const stockBefore = await systemStockOfItem(F.itemA);

      const [transfer, withdraw] = await Promise.all([
        ctx.post("/api/batches/transfer", {
          timeout: REQ_TIMEOUT,
          data: { batchId, toWarehouseId: warehouseC, quantity: 60, notes: "E2E-CC S3 transfer" },
        }),
        ctx.post("/api/transactions", {
          timeout: REQ_TIMEOUT,
          data: { type: "ISSUED", batchId, quantity: 60, reason: "E2E-CC S3 draw" },
        }),
      ]);

      const wins = [transfer.status(), withdraw.status()].filter((s) => s === 201);
      expect(wins, "exactly one of transfer/withdrawal may win").toHaveLength(1);
      const loser = transfer.status() === 201 ? withdraw : transfer;
      expectInsufficientStock(loser.status(), await loser.text(), "S3 loser");

      const row = await batchRow(batchId);
      expect(row.quantityRemaining, "source is drawn down exactly once").toBe(40);
      const stockAfter = await systemStockOfItem(F.itemA);
      const transferWon = transfer.status() === 201;
      if (transferWon) {
        // A transfer MOVES stock: system total unchanged, destination holds it.
        expect(stockAfter, "transfer must not change system-wide stock").toBe(stockBefore);
        expect(await ledgerCount(batchId, "TRANSFERRED")).toBe(1);
        const dest = await prisma.inventoryBatch.findMany({
          where: { warehouseId: warehouseC, itemId: F.itemA, status: "ACTIVE" },
          select: { quantityRemaining: true },
        });
        expect(dest.reduce((s, r) => s + r.quantityRemaining, 0)).toBe(60);
        expect(await ledgerCount(batchId, "ISSUED")).toBe(0);
      } else {
        // A withdrawal REMOVES stock: system total drops by 60, no destination.
        expect(stockAfter, "withdrawal must remove 60 from the system").toBe(stockBefore - 60);
        expect(await ledgerCount(batchId, "ISSUED")).toBe(1);
        expect(await ledgerCount(batchId, "TRANSFERRED")).toBe(0);
      }
    } finally {
      await ctx.dispose().catch(() => undefined);
    }
  });

  test("S4: concurrent 70-unit adjustments against 100 — exactly one wins", async () => {
    const ctx = await apiFor(baseURL, EMAIL.managerA);
    try {
      const batchId = await makeBatch(ctx, "S4", 100);

      const results = await Promise.all(
        Array.from({ length: 2 }, () =>
          ctx.post("/api/transactions", {
            timeout: REQ_TIMEOUT,
            data: { type: "ADJUSTED", batchId, quantity: 70, reason: "E2E-CC S4 adjustment" },
          })
        )
      );

      const wins = results.filter((r) => r.status() === 201);
      expect(wins).toHaveLength(1);
      const loser = results.find((r) => r.status() !== 201)!;
      expectInsufficientStock(loser.status(), await loser.text(), "S4 loser");

      const row = await batchRow(batchId);
      expect(row.quantityRemaining, "100 - 70 = 30").toBe(30);
      expect(await ledgerCount(batchId, "ADJUSTED")).toBe(1);
    } finally {
      await ctx.dispose().catch(() => undefined);
    }
  });

  test("S5: concurrent withdrawals on different batches — both succeed, no lost updates", async () => {
    const ctx = await apiFor(baseURL, EMAIL.managerA);
    try {
      const [batch1, batch2] = await Promise.all([
        makeBatch(ctx, "S5A", 50),
        makeBatch(ctx, "S5B", 50),
      ]);

      const [r1, r2] = await Promise.all([
        ctx.post("/api/transactions", {
          timeout: REQ_TIMEOUT,
          data: { type: "ISSUED", batchId: batch1, quantity: 30, reason: "E2E-CC S5 draw" },
        }),
        ctx.post("/api/transactions", {
          timeout: REQ_TIMEOUT,
          data: { type: "ISSUED", batchId: batch2, quantity: 30, reason: "E2E-CC S5 draw" },
        }),
      ]);

      // Different rows must not interfere: both succeed.
      expect([r1.status(), r2.status()]).toEqual([201, 201]);
      expect((await batchRow(batch1)).quantityRemaining).toBe(20);
      expect((await batchRow(batch2)).quantityRemaining).toBe(20);
      expect(await ledgerCount(batch1, "ISSUED")).toBe(1);
      expect(await ledgerCount(batch2, "ISSUED")).toBe(1);
    } finally {
      await ctx.dispose().catch(() => undefined);
    }
  });

  test("S6: concurrent duplicate idempotent requests — one logical mutation", async () => {
    const ctx = await apiFor(baseURL, EMAIL.managerA);
    try {
      s6BatchId = await makeBatch(ctx, "S6", 100);
      s6Key = `e2e-cc-s6-${runId}`;
      const payload = { type: "ISSUED", batchId: s6BatchId, quantity: 30, reason: "E2E-CC S6 idem" };

      const [r1, r2] = await Promise.all([
        ctx.post("/api/transactions", { timeout: REQ_TIMEOUT, data: payload, headers: { "Idempotency-Key": s6Key } }),
        ctx.post("/api/transactions", { timeout: REQ_TIMEOUT, data: payload, headers: { "Idempotency-Key": s6Key } }),
      ]);

      // Exactly one REAL execution; the other is an in-flight conflict or a replay.
      const real = [r1, r2].filter((r) => r.status() === 201 && r.headers()["idempotent-replay"] !== "true");
      expect(real, "exactly one non-replay success").toHaveLength(1);
      s6TxId = ((await real[0].json()) as { id: string }).id;
      const other = real[0] === r1 ? r2 : r1;
      const replayed = other.status() === 201 && other.headers()["idempotent-replay"] === "true";
      const inflight = other.status() === 409;
      expect(replayed || inflight, `unexpected loser shape: ${other.status()}`).toBe(true);

      // Database: exactly ONE logical mutation.
      expect(await ledgerCount(s6BatchId, "ISSUED"), "one key must produce one ledger row").toBe(1);
      expect((await batchRow(s6BatchId)).quantityRemaining).toBe(70);
    } finally {
      await ctx.dispose().catch(() => undefined);
    }
  });

  test("S7: a completed idempotent request replays consistently", async () => {
    const ctx = await apiFor(baseURL, EMAIL.managerA);
    try {
      const replay = await ctx.post("/api/transactions", {
        timeout: REQ_TIMEOUT,
        data: { type: "ISSUED", batchId: s6BatchId, quantity: 30, reason: "E2E-CC S6 idem" },
        headers: { "Idempotency-Key": s6Key },
      });
      expect(replay.status()).toBe(201);
      expect(replay.headers()["idempotent-replay"], "must be flagged as a replay").toBe("true");
      const body = (await replay.json()) as { id: string };
      expect(body.id, "replay must return the ORIGINAL transaction id").toBe(s6TxId);

      // Replay must not have mutated anything again.
      expect(await ledgerCount(s6BatchId, "ISSUED")).toBe(1);
      expect((await batchRow(s6BatchId)).quantityRemaining).toBe(70);
    } finally {
      await ctx.dispose().catch(() => undefined);
    }
  });

  test("S8: reusing an idempotency key with a DIFFERENT payload is rejected", async () => {
    const ctx = await apiFor(baseURL, EMAIL.managerA);
    try {
      const res = await ctx.post("/api/transactions", {
        timeout: REQ_TIMEOUT,
        data: { type: "ISSUED", batchId: s6BatchId, quantity: 10, reason: "E2E-CC S8 different payload" },
        headers: { "Idempotency-Key": s6Key },
      });
      // Contract: a key is bound to its first payload; a mismatch must not
      // execute and must not silently replay the other payload's success.
      expect(res.status(), "payload mismatch must be rejected").toBe(409);
      expect((await res.text()).toLowerCase()).toContain("payload");

      // Nothing changed in the database.
      expect(await ledgerCount(s6BatchId, "ISSUED")).toBe(1);
      expect((await batchRow(s6BatchId)).quantityRemaining).toBe(70);
    } finally {
      await ctx.dispose().catch(() => undefined);
    }
  });

  test("S9: a failed idempotent attempt releases the key for a corrected retry", async () => {
    const ctx = await apiFor(baseURL, EMAIL.managerA);
    try {
      const batchId = await makeBatch(ctx, "S9", 60);
      const key = `e2e-cc-s9-${runId}`;

      // Attempt 1: overdraw (fails) with the key attached.
      const failed = await ctx.post("/api/transactions", {
        timeout: REQ_TIMEOUT,
        data: { type: "ISSUED", batchId, quantity: 80, reason: "E2E-CC S9 overdraw" },
        headers: { "Idempotency-Key": key },
      });
      expectInsufficientStock(failed.status(), await failed.text(), "S9 failed attempt");

      // Attempt 2: same key, corrected payload — must EXECUTE, not replay a failure.
      const fixed = await ctx.post("/api/transactions", {
        timeout: REQ_TIMEOUT,
        data: { type: "ISSUED", batchId, quantity: 10, reason: "E2E-CC S9 corrected" },
        headers: { "Idempotency-Key": key },
      });
      expect(fixed.status(), "corrected retry must run").toBe(201);
      expect(fixed.headers()["idempotent-replay"], "must be a fresh execution").not.toBe("true");

      const row = await batchRow(batchId);
      expect(row.quantityRemaining, "60 - 10 = 50; the failed attempt moved nothing").toBe(50);
      expect(await ledgerCount(batchId, "ISSUED"), "only the corrected attempt wrote a row").toBe(1);
    } finally {
      await ctx.dispose().catch(() => undefined);
    }
  });

  test("S10: a purchase-order receipt that fails midway rolls back every partial mutation", async () => {
    // Forced mid-loop failure: the farm has a warehouse, PO has two items,
    // and a pre-seeded batch occupies the batchNumber the SECOND item's
    // receipt would INSERT — so item 1 succeeds and item 2 blows up on the
    // unique(batchNumber) constraint. Everything must roll back; then the
    // corrected retry must succeed exactly once (no double credit).
    try {
      const farm = await ctxAdmin.post("/api/farms", {
        data: { name: `E2E-CC-Farm-${runId}`, location: "phase-2 rollback" },
      });
      expect(farm.status()).toBe(201);
      const farmD = ((await farm.json()) as { id: string }).id;

      const wh = await ctxAdmin.post("/api/warehouses", {
        data: { name: `E2E-CC-WH-D-${runId}`, farmId: farmD, location: "phase-2 rollback" },
      });
      expect(wh.status()).toBe(201);
      const whD = ((await wh.json()) as { id: string }).id;

      const po = await ctxAdmin.post("/api/purchase-orders", {
        data: {
          supplierId: F.supplierId,
          farmId: farmD,
          items: [
            { itemId: F.itemA, quantity: 3, unitPrice: 2 },
            { itemId: F.sharedItem, quantity: 5, unitPrice: 2 },
          ],
          notes: "E2E-CC S10 rollback probe",
        },
      });
      expect(po.status()).toBe(201);
      const poBody = (await po.json()) as {
        id: string;
        orderNumber: string;
        items: { id: string; itemId: string }[];
      };
      const item2 = poBody.items.find((i) => i.itemId === F.sharedItem)!;

      // Occupy the batch number the second item's receipt will insert.
      const blockerNum = `PO-${poBody.orderNumber}-${item2.id.slice(-6)}`;
      const blocker = await ctxAdmin.post("/api/batches", {
        data: {
          itemId: F.itemA, // different item, so the receipt's per-item lookup won't absorb it
          batchNumber: blockerNum,
          warehouseId: whD,
          quantityReceived: 1,
          purchasePrice: 1,
        },
      });
      expect(blocker.status()).toBe(201);

      // Receive: item 1 would credit stock, then item 2 hits the duplicate
      // batch number. The whole receipt must fail atomically.
      const receive = await ctxAdmin.patch(`/api/purchase-orders/${poBody.id}`, {
        data: { status: "RECEIVED" },
      });
      expect(receive.status(), "forced mid-receipt failure must surface as 500").toBe(500);

      // Database evidence of a COMPLETE rollback:
      const poAfter = await prisma.purchaseOrder.findUnique({
        where: { id: poBody.id },
        select: {
          status: true,
          items: { select: { quantityReceived: true } },
        },
      });
      expect(poAfter?.status, "PO must stay DRAFT after a failed receipt").toBe("DRAFT");
      for (const item of poAfter?.items ?? []) {
        expect(item.quantityReceived, "no PO item may be marked received").toBe(0);
      }
      const whDBatches = await prisma.inventoryBatch.findMany({
        where: { warehouseId: whD },
        select: { quantity: true, itemId: true },
      });
      expect(
        whDBatches.filter((b) => b.quantity === 3 || b.quantity === 5),
        "no partially-credited batch may survive the rollback"
      ).toHaveLength(0);

      // Clear the deliberate blocker (batches have no DELETE API; these are
      // test-owned rows — ledger row first, then the batch) and prove the
      // corrected retry succeeds exactly once.
      const blockerRow = await prisma.inventoryBatch.findUnique({
        where: { batchNumber: blockerNum },
        select: { id: true },
      });
      await prisma.stockTransaction.deleteMany({ where: { batchId: blockerRow!.id } });
      await prisma.inventoryBatch.delete({ where: { batchNumber: blockerNum } });

      const retry = await ctxAdmin.patch(`/api/purchase-orders/${poBody.id}`, {
        data: { status: "RECEIVED" },
      });
      expect(retry.status(), "corrected receipt must succeed").toBe(200);

      const poFinal = await prisma.purchaseOrder.findUnique({
        where: { id: poBody.id },
        select: {
          status: true,
          items: { select: { itemId: true, quantityReceived: true } },
        },
      });
      expect(poFinal?.status).toBe("RECEIVED");
      expect(
        poFinal?.items.find((i) => i.itemId === F.itemA)?.quantityReceived,
        "item 1 received exactly 3 — not double-credited by the earlier failed attempt"
      ).toBe(3);
      expect(poFinal?.items.find((i) => i.itemId === F.sharedItem)?.quantityReceived).toBe(5);
      const credited = await prisma.inventoryBatch.findMany({
        where: { warehouseId: whD },
        select: { itemId: true, quantity: true, quantityRemaining: true },
      });
      expect(credited).toHaveLength(2);
      expect(credited.find((b) => b.itemId === F.itemA)?.quantity).toBe(3);
      expect(credited.find((b) => b.itemId === F.sharedItem)?.quantity).toBe(5);
    } finally {
      await ctxAdmin.dispose().catch(() => undefined);
      ctxAdmin = await apiFor(baseURL, EMAIL.admin);
    }
  });

  test("S11: two concurrent RECEIVED patches — the receipt claim is atomic, stock credited exactly once", async () => {
    // Review finding: the receipt branch's stale `po.status` read (fetched
    // outside the transaction) cannot serialize two simultaneous RECEIVED
    // patches — without the in-transaction row-locked claim, BOTH would run
    // the credit loop and stock would double. Race them for real and verify
    // the outcome in the database, not just the HTTP statuses.
    try {
      const farm = await ctxAdmin.post("/api/farms", {
        data: { name: `E2E-CC-Farm-S11-${runId}`, location: "phase-2 receipt race" },
      });
      expect(farm.status()).toBe(201);
      const farmE = ((await farm.json()) as { id: string }).id;

      const wh = await ctxAdmin.post("/api/warehouses", {
        data: { name: `E2E-CC-WH-E-${runId}`, farmId: farmE, location: "phase-2 receipt race" },
      });
      expect(wh.status()).toBe(201);
      const whE = ((await wh.json()) as { id: string }).id;

      const po = await ctxAdmin.post("/api/purchase-orders", {
        data: {
          supplierId: F.supplierId,
          farmId: farmE,
          items: [
            { itemId: F.itemA, quantity: 4, unitPrice: 2 },
            { itemId: F.sharedItem, quantity: 6, unitPrice: 2 },
          ],
          notes: "E2E-CC S11 receipt race",
        },
      });
      expect(po.status()).toBe(201);
      const poBody = (await po.json()) as { id: string };

      const [r1, r2] = await Promise.all([
        ctxAdmin.patch(`/api/purchase-orders/${poBody.id}`, {
          timeout: REQ_TIMEOUT,
          data: { status: "RECEIVED" },
        }),
        ctxAdmin.patch(`/api/purchase-orders/${poBody.id}`, {
          timeout: REQ_TIMEOUT,
          data: { status: "RECEIVED" },
        }),
      ]);

      const statuses = [r1.status(), r2.status()].sort();
      expect(statuses, "exactly one receipt must win, the other must fail safely").toEqual([200, 409]);
      const loser = r1.status() === 200 ? r2 : r1;
      expect((await loser.json()).error).toContain("already been received");

      // Database evidence of exactly-once crediting:
      const poAfter = await prisma.purchaseOrder.findUnique({
        where: { id: poBody.id },
        select: {
          status: true,
          items: { select: { itemId: true, quantityReceived: true } },
        },
      });
      expect(poAfter?.status).toBe("RECEIVED");
      expect(poAfter?.items.find((i) => i.itemId === F.itemA)?.quantityReceived).toBe(4);
      expect(poAfter?.items.find((i) => i.itemId === F.sharedItem)?.quantityReceived).toBe(6);

      const credited = await prisma.inventoryBatch.findMany({
        where: { warehouseId: whE },
        select: { itemId: true, quantity: true, quantityRemaining: true },
      });
      expect(credited, "one batch per item — the losing receipt credited nothing").toHaveLength(2);
      expect(credited.find((b) => b.itemId === F.itemA)?.quantity).toBe(4);
      expect(credited.find((b) => b.itemId === F.sharedItem)?.quantity).toBe(6);
    } finally {
      await ctxAdmin.dispose().catch(() => undefined);
      ctxAdmin = await apiFor(baseURL, EMAIL.admin);
    }
  });
});
