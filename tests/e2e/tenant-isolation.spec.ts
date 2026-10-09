/**
 * Route-level tenant security E2E (roadmap Phase 1).
 *
 * Two isolated tenants (Farm A / Farm B) with real users, data and real
 * authenticated HTTP sessions. Farm A attempts cross-tenant reads, writes,
 * deletes, transfers, splits and exports against valid Farm B IDs; an
 * unassigned user and a role-restricted user are probed; admin behaviour is
 * verified separately as the positive control.
 *
 * Invariant under test: **no response body that Farm A can elicit may contain
 * an `E2E-B` marker**, except the global item catalog row for Farm B's item
 * (inventory *items* are a shared catalog by design; their batches, stock and
 * warehouse relationships are not).
 *
 * Beyond the original attack set, the suite walks the full ID-addressable
 * route matrix (GET/PATCH/DELETE), foreign IDs smuggled into create-bodies,
 * a poisoned cross-farm request row (approval must not drain Farm B stock),
 * QR/CSV-import boundaries, the webhook registry's auth floor, farm-pinned
 * external API keys, and positive same-tenant controls that prove the guards
 * deny attackers without breaking legitimate workflows.
 *
 * Requires: a running FarmOps server (BASE_URL) and DATABASE_URL for fixture
 * setup. Runs automatically in CI's E2E job.
 */
import { test, expect, type APIRequestContext } from "@playwright/test";
import ExcelJS from "exceljs";
import {
  EMAIL,
  ensureTenantFixtures,
  apiFor,
  anonApiFor,
  type FixtureIds,
} from "./tenant-fixtures";

const baseURL = process.env.BASE_URL || "http://localhost:3000";

/** Parse an xlsx response body (exceljs typings and the repo's @types/node
 * disagree on Buffer's generic default; the runtime value is a Buffer). */
async function loadWorkbook(body: Buffer): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(
    body as unknown as Parameters<typeof workbook.xlsx.load>[0]
  );
  return workbook;
}

const MARK_B = "E2E-B";
const MARK_A = "E2E-A";

let F: FixtureIds;
let ctxA: APIRequestContext;
let ctxB: APIRequestContext;
let ctxWorker: APIRequestContext;
let ctxUnassigned: APIRequestContext;
let ctxAdmin: APIRequestContext;

test.describe.serial("Tenant isolation — Farm A vs Farm B", () => {
  test.beforeAll(async () => {
    F = await ensureTenantFixtures();
    [ctxA, ctxB, ctxWorker, ctxUnassigned, ctxAdmin] = await Promise.all([
      apiFor(baseURL, EMAIL.managerA),
      apiFor(baseURL, EMAIL.managerB),
      apiFor(baseURL, EMAIL.workerA),
      apiFor(baseURL, EMAIL.unassigned),
      apiFor(baseURL, EMAIL.admin),
    ]);
  });

  test.afterAll(async () => {
    await Promise.all(
      [ctxA, ctxB, ctxWorker, ctxUnassigned, ctxAdmin].map(
        (c) => c && c.dispose().catch(() => undefined)
      )
    );
  });

  // ─── Reads ────────────────────────────────────────────────────────

  test("Farm A list endpoints never contain Farm B records", async () => {
    // `allowSharedCatalogName`: Farm A's own request list may carry the
    // poisoned regression row, whose *item* is the shared catalog entry for
    // Farm B's item (the one documented exception — /api/inventory shows it
    // too). Batch numbers and warehouse names stay banned everywhere.
    // Paginated lists are fetched with an explicit limit so repeated local
    // runs (which accumulate probe rows) can never push a fixture marker
    // off page 1 and turn this scan into a false alarm.
    const endpoints: { path: string; mustContain?: string; allowSharedCatalogName?: boolean }[] = [
      { path: "/api/warehouses", mustContain: "E2E-A Warehouse" },
      { path: "/api/transactions?limit=100", mustContain: "E2E-A-BATCH-1" },
      { path: "/api/requests?limit=100", mustContain: "E2E-A-REQ-1", allowSharedCatalogName: true },
      { path: "/api/purchase-orders?limit=100", mustContain: "E2E-A-PO-1" },
      { path: "/api/seasons", mustContain: "E2E-A Season" },
      { path: "/api/waste?limit=100", mustContain: "E2E-A waste" },
      { path: "/api/stock-count?limit=100", mustContain: "E2E-A count" },
      { path: "/api/batches", mustContain: "E2E-A-BATCH-1" },
      { path: "/api/farms", mustContain: "E2E Farm Alpha" },
      { path: "/api/alerts?type=all" },
      { path: "/api/notifications" },
      { path: "/api/dashboard/overview" },
      { path: "/api/reports?type=dashboard" },
      { path: "/api/reports?type=suppliers" },
    ];

    for (const { path, mustContain, allowSharedCatalogName } of endpoints) {
      const res = await ctxA.get(path);
      expect(res.status(), `${path} should be 200`).toBe(200);
      const body = await res.text();
      if (allowSharedCatalogName) {
        expect(body, `${path} must not leak Farm B batch numbers`).not.toContain("E2E-B-BATCH-1");
        expect(body, `${path} must not leak Farm B warehouses`).not.toContain("E2E-B Warehouse");
      } else {
        expect(body, `${path} must not leak Farm B data`).not.toContain(MARK_B);
      }
      expect(body, `${path} must not leak Farm B data`).not.toContain("Farm Beta");
      if (mustContain) {
        expect(body, `${path} should contain Farm A's own ${mustContain}`).toContain(mustContain);
      }
    }
  });

  test("a client-supplied farmId cannot widen Farm A's scope", async () => {
    const paths = [
      `/api/transactions?farmId=${F.farmB}&limit=100`,
      `/api/purchase-orders?farmId=${F.farmB}`,
      `/api/warehouses?farmId=${F.farmB}`,
      `/api/seasons?farmId=${F.farmB}`,
      `/api/waste?farmId=${F.farmB}`,
      `/api/reports?type=dashboard&farmId=${F.farmB}`,
      `/api/batches?farmId=${F.farmB}`,
    ];
    for (const path of paths) {
      const res = await ctxA.get(path);
      expect(res.status(), `${path} should be 200`).toBe(200);
      const body = await res.text();
      expect(body, `${path} must ignore the requested foreign farmId`).not.toContain(MARK_B);
    }

    // /api/requests: Farm A still sees only its own rows (the poisoned
    // regression row carries the shared catalog item name — the documented
    // exception), never Farm B's batches or warehouses.
    const reqRes = await ctxA.get(`/api/requests?farmId=${F.farmB}`);
    expect(reqRes.status()).toBe(200);
    const reqBody = await reqRes.text();
    expect(reqBody, "requests must not leak Farm B batch numbers").not.toContain("E2E-B-BATCH-1");
    expect(reqBody, "requests must not leak Farm B warehouses").not.toContain("E2E-B Warehouse");
    expect(reqBody).not.toContain("Farm Beta");
  });

  test("cross-tenant reads by ID are denied", async () => {
    const txRes = await ctxA.get(`/api/transactions/${F.txB}`);
    expect(txRes.status()).toBe(403);

    const scRes = await ctxA.get(`/api/stock-count/${F.stockCountB}`);
    expect(scRes.status()).toBe(404);

    const notifRes = await ctxA.get(`/api/notifications/${F.notificationB}`);
    expect([403, 404]).toContain(notifRes.status());

    // Control: Farm A reads its own transaction fine.
    const own = await ctxA.get(`/api/transactions/${F.txA}`);
    expect(own.status()).toBe(200);
    expect(await own.text()).toContain(MARK_A);
  });

  test("the inventory catalog exposes no Farm B stock", async () => {
    const res = await ctxA.get("/api/inventory");
    expect(res.status()).toBe(200);
    const body = await res.text();
    // Batches/stock/warehouses are tenant data — the shared *catalog* row is not.
    expect(body).not.toContain("E2E-B-BATCH-1");
    expect(body).not.toContain("E2E-B Warehouse");
  });

  // ─── Writes ───────────────────────────────────────────────────────

  test("cross-tenant writes, deletes, transfers and splits are rejected", async () => {
    // Stock transactions against Farm B resources
    const foreignBatch = await ctxA.post("/api/transactions", {
      data: { type: "ISSUED", batchId: F.batchB, quantity: 5, fromWarehouseId: F.warehouseB },
    });
    expect(foreignBatch.status()).toBe(403);
    expect((await foreignBatch.json()).error).toContain("another farm");

    // Own batch, but a Farm B warehouse smuggled in as source
    const foreignSource = await ctxA.post("/api/transactions", {
      data: { type: "ISSUED", batchId: F.batchA, quantity: 5, fromWarehouseId: F.warehouseB },
    });
    expect(foreignSource.status()).toBe(403);

    // Own batch, Farm B warehouse as destination (inbound must not credit B)
    const foreignDest = await ctxA.post("/api/transactions", {
      data: { type: "RECEIVED", batchId: F.batchA, quantity: 5, toWarehouseId: F.warehouseB },
    });
    expect(foreignDest.status()).toBe(403);

    // Transfers: foreign source and foreign destination both look "not found"
    const transferForeignSource = await ctxA.post("/api/batches/transfer", {
      data: { batchId: F.batchB, toWarehouseId: F.warehouseA, quantity: 5 },
    });
    expect(transferForeignSource.status()).toBe(404);

    const transferForeignDest = await ctxA.post("/api/batches/transfer", {
      data: { batchId: F.batchA, toWarehouseId: F.warehouseB, quantity: 5 },
    });
    expect(transferForeignDest.status()).toBe(404);

    // Splits: foreign source and foreign target warehouse both rejected
    const splitForeignSource = await ctxA.post("/api/batches/split", {
      data: { batchId: F.batchB, splitQuantity: 5 },
    });
    expect(splitForeignSource.status()).toBe(404);

    const splitForeignTarget = await ctxA.post("/api/batches/split", {
      data: { batchId: F.batchA, splitQuantity: 5, targetWarehouseId: F.warehouseB },
    });
    expect(splitForeignTarget.status()).toBe(404);

    // Direct entity mutations by ID
    const patchWarehouse = await ctxA.patch(`/api/warehouses/${F.warehouseB}`, {
      data: { name: "pwned by farm A" },
    });
    expect(patchWarehouse.status()).toBe(403);
    expect((await patchWarehouse.json()).error).toContain("another farm");

    const patchRequest = await ctxA.patch(`/api/requests/${F.requestB}`, {
      data: { status: "APPROVED" },
    });
    expect(patchRequest.status()).toBe(403);

    const patchPo = await ctxA.patch(`/api/purchase-orders/${F.poB}`, {
      data: { notes: "pwned by farm A" },
    });
    expect(patchPo.status()).toBe(403);

    const patchSeason = await ctxA.patch(`/api/seasons/${F.seasonB}`, {
      data: { name: "pwned by farm A" },
    });
    expect(patchSeason.status()).toBe(403);

    const deleteWaste = await ctxA.delete(`/api/waste/${F.wasteB}`);
    expect(deleteWaste.status()).toBe(403);

    const patchTransaction = await ctxA.patch(`/api/transactions/${F.txB}`, {
      data: { reason: "pwned by farm A" },
    });
    expect(patchTransaction.status()).toBe(403);

    // Admin-only operations must fail at the role gate for a farm manager
    const deleteWarehouse = await ctxA.delete(`/api/warehouses/${F.warehouseB}`);
    expect(deleteWarehouse.status()).toBe(403);
    const listUsers = await ctxA.get("/api/users");
    expect(listUsers.status()).toBe(403);
    const auditLog = await ctxA.get("/api/audit-log");
    expect(auditLog.status()).toBe(403);
  });

  test("Farm B's data is untouched after Farm A's attack", async () => {
    const wh = await ctxB.get("/api/warehouses");
    expect(wh.status()).toBe(200);
    const whBody = await wh.text();
    expect(whBody).toContain("E2E-B Warehouse");
    expect(whBody).not.toContain("pwned by farm A");

    const season = await ctxB.get("/api/seasons");
    expect((await season.text())).not.toContain("pwned by farm A");

    const requests = await ctxB.get("/api/requests");
    const requestsBody = await requests.text();
    expect(requestsBody).toContain("E2E-B-REQ-1");

    // Farm B still sees only Farm A's mirror image of nothing: Farm A marker
    // must never appear in Farm B's lists either.
    expect(requestsBody).not.toContain(MARK_A);
  });

  // ─── Exports ──────────────────────────────────────────────────────

  test("Excel exports stay inside the caller's tenant", async () => {
    const res = await ctxA.get("/api/export/excel?type=all");
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("spreadsheetml");

    const workbook = await loadWorkbook(await res.body());

    let text = "";
    workbook.eachSheet((sheet) => {
      sheet.eachRow({ includeEmpty: false }, (row) => {
        text += String(row.values) + "\n";
      });
    });

    expect(text).toContain(MARK_A);
    expect(text, "Excel export must not contain Farm B markers").not.toContain(MARK_B);
    expect(text).not.toContain("Farm Beta");
  });

  test("CSV exports stay inside the caller's tenant", async () => {
    for (const type of ["transactions", "inventory"]) {
      const res = await ctxA.get(`/api/export?type=${type}`);
      expect(res.status(), `/api/export?type=${type}`).toBe(200);
      const body = await res.text();
      expect(body, `CSV ${type} must not contain Farm B markers`).not.toContain(MARK_B);
    }

    // Mirror: Farm B's export must not contain Farm A markers.
    const bRes = await ctxB.get("/api/export?type=transactions");
    expect(await bRes.text()).not.toContain(MARK_A);
  });

  test("exporting with a foreign warehouseId yields no Farm B rows", async () => {
    const res = await ctxA.get(
      `/api/export/excel?type=inventory&warehouseId=${F.warehouseB}`
    );
    expect(res.status()).toBe(200);
    const workbook = await loadWorkbook(await res.body());
    let text = "";
    workbook.eachSheet((sheet) => {
      sheet.eachRow({ includeEmpty: false }, (row) => {
        text += String(row.values) + "\n";
      });
    });
    expect(text).not.toContain("E2E-B-BATCH-1");
    expect(text).not.toContain("E2E-B Warehouse");
  });

  // ─── Unassigned & role-restricted users ───────────────────────────

  test("an unassigned user receives no tenant data at all", async () => {
    const paths = [
      "/api/warehouses",
      "/api/transactions?limit=100",
      "/api/requests",
      "/api/seasons",
      "/api/batches",
      "/api/farms",
      "/api/purchase-orders",
      "/api/dashboard/overview",
      "/api/stock-count",
    ];
    for (const path of paths) {
      const res = await ctxUnassigned.get(path);
      expect(res.status(), `${path}`).toBe(200);
      const body = await res.text();
      expect(body, `${path} must return no tenant data`).not.toContain(MARK_A);
      expect(body, `${path} must return no tenant data`).not.toContain(MARK_B);
    }

    // Writes are rejected before any data can be touched.
    const write = await ctxUnassigned.post("/api/transactions", {
      data: { type: "ISSUED", batchId: F.batchA, quantity: 1, fromWarehouseId: F.warehouseA },
    });
    expect(write.status()).toBe(403);
  });

  test("a role-restricted user cannot perform stock mutations", async () => {
    const res = await ctxWorker.post("/api/transactions", {
      data: { type: "ISSUED", batchId: F.batchA, quantity: 1, fromWarehouseId: F.warehouseA },
    });
    expect(res.status()).toBe(403);
    expect((await res.json()).error).toContain("permissions");
  });

  // ─── Admin positive control ───────────────────────────────────────

  test("administrators can work across farms where explicitly intended", async () => {
    const users = await ctxAdmin.get("/api/users");
    expect(users.status()).toBe(200);
    const usersBody = await users.text();
    expect(usersBody).toContain(EMAIL.managerA);
    expect(usersBody).toContain(EMAIL.managerB);

    const seasons = await ctxAdmin.get("/api/seasons");
    expect((await seasons.text())).toContain("E2E-A Season");
    expect((await seasons.text())).toContain("E2E-B Season");

    const bTx = await ctxAdmin.get(`/api/transactions?farmId=${F.farmB}&limit=100`);
    expect((await bTx.text())).toContain("E2E-B-BATCH-1");

    // Cross-farm write (no-op rename) succeeds for an admin.
    const rename = await ctxAdmin.patch(`/api/warehouses/${F.warehouseB}`, {
      data: { name: "E2E-B Warehouse" },
    });
    expect(rename.status()).toBe(200);
  });

  // ─── Idempotency under concurrency (Phase 2) ──────────────────────

  test("duplicate Idempotency-Keys produce exactly one business outcome", async () => {
    // Unique per run: the server's idempotency store is in-memory (cleared on
    // restart) while rows persist, so a fixed key/reference would make the
    // count below depend on server history.
    const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const referenceNumber = `E2E-IDEM-${runId}`;
    const payload = {
      type: "ISSUED",
      batchId: F.batchA,
      quantity: 3,
      fromWarehouseId: F.warehouseA,
      referenceNumber,
    };
    const headers = { "Idempotency-Key": `e2e-idem-${runId}` };

    const [r1, r2] = await Promise.all([
      ctxA.post("/api/transactions", { data: payload, headers }),
      ctxA.post("/api/transactions", { data: payload, headers }),
    ]);

    const statuses = [r1.status(), r2.status()];
    expect(statuses, `statuses were ${statuses.join(",")}`).toContain(201);
    for (const s of statuses) {
      expect([201, 409]).toContain(s);
    }

    // Exactly one transaction row exists for the duplicate-key requests.
    const list = await ctxA.get("/api/transactions?type=ISSUED&limit=100");
    expect(list.status()).toBe(200);
    const rows = (await list.json()) as { referenceNumber?: string }[];
    const effective = rows.filter((t) => t.referenceNumber === referenceNumber);
    expect(effective).toHaveLength(1);
  });

  // ─── Full ID-route attack matrix (Phase: hardening sweep) ─────────

  test("every remaining ID-addressable route denies Farm A access to Farm B", async () => {
    // A dedicated context: this test alone spends a large slice of the
    // per-IP mutation budget.
    const ctxAx = await apiFor(baseURL, EMAIL.managerA);
    try {
      // PATCH probes on routes the original suite did not cover
      const patchProbes: { path: string; body: object; expect: number[] }[] = [
        { path: `/api/farms/${F.farmB}`, body: { name: "pwned farm B" }, expect: [403] },
        { path: `/api/stock-count/${F.stockCountB}`, body: { notes: "pwned count" }, expect: [404] },
        { path: `/api/notifications/${F.notificationB}`, body: { isRead: true }, expect: [403] },
        { path: `/api/users/${F.managerB}`, body: { name: "pwned user B" }, expect: [403] },
      ];
      for (const probe of patchProbes) {
        const res = await ctxAx.patch(probe.path, { data: probe.body });
        expect(probe.expect, `${probe.path} returned ${res.status()}`).toContain(res.status());
      }

      // DELETE probes: admin-only routes deny at the role gate; the
      // notification route denies at the owner gate.
      const deletePaths = [
        `/api/seasons/${F.seasonB}`,
        `/api/transactions/${F.txB}`,
        `/api/purchase-orders/${F.poB}`,
        `/api/stock-count/${F.stockCountB}`,
        `/api/farms/${F.farmB}`,
        `/api/inventory/${F.itemB}`,
        `/api/suppliers/${F.supplierId}`,
        `/api/webhooks/nonexistent-probe`,
      ];
      for (const path of deletePaths) {
        const res = await ctxAx.delete(path);
        expect(res.status(), `${path} returned ${res.status()}`).toBe(403);
      }

      const delNotif = await ctxAx.delete(`/api/notifications/${F.notificationB}`);
      expect(delNotif.status(), "notification DELETE must be owner-gated").toBe(403);

      // Farm B's world is fully intact after the whole matrix
      const ownerSees = await ctxB.get(`/api/notifications/${F.notificationB}`);
      expect(ownerSees.status(), "Farm B's notification must survive").toBe(200);
      const seasons = await ctxB.get("/api/seasons");
      expect(await seasons.text()).toContain("E2E-B Season");
      const pos = await ctxB.get("/api/purchase-orders");
      expect(await pos.text()).toContain("E2E-B-PO-1");
    } finally {
      await ctxAx.dispose().catch(() => undefined);
    }
  });

  test("foreign IDs smuggled into create-bodies are rejected or re-scoped", async () => {
    const ctxAx = await apiFor(baseURL, EMAIL.managerA);
    try {
      // 1) Request pointing at Farm B's warehouse → rejected.
      //    Regression: previously accepted; approving it would drain Farm B.
      const reqForeignWh = await ctxAx.post("/api/requests", {
        data: { farmId: F.farmA, warehouseId: F.warehouseB, itemId: F.itemB, quantity: 5, unitOfMeasure: "bags" },
      });
      expect(reqForeignWh.status()).toBe(404);

      // 2) Batch created in Farm B's warehouse → rejected.
      //    Regression: previously credited Farm B stock with a phantom batch.
      const batchForeignWh = await ctxAx.post("/api/batches", {
        data: {
          itemId: F.itemA,
          batchNumber: `E2E-A-POISON-BATCH-${Date.now()}`,
          warehouseId: F.warehouseB,
          quantityReceived: 5,
          purchasePrice: 1,
        },
      });
      expect(batchForeignWh.status()).toBe(404);

      // 3) Stock count whose items reference Farm B's batch → rejected.
      //    Regression: a RECONCILED variance used to apply to the foreign batch.
      const countForeignBatch = await ctxAx.post("/api/stock-count", {
        data: {
          warehouseId: F.warehouseA,
          notes: "E2E poison count",
          items: [{ batchId: F.batchB, systemQuantity: 100, countedQuantity: 1 }],
        },
      });
      expect(countForeignBatch.status()).toBe(400);

      // 4) QR generation for Farm B's batch → not found, no metadata leak.
      //    Regression: previously leaked batch details and wrote onto the row.
      const qrForeign = await ctxAx.post("/api/qr", { data: { batchId: F.batchB } });
      expect(qrForeign.status()).toBe(404);
      const qrBody = await qrForeign.text();
      expect(qrBody).not.toContain("E2E-B-BATCH-1");
      expect(qrBody).not.toContain(MARK_B);

      // 5) Waste against Farm B's batch → denied by the batch ownership check
      const wasteForeign = await ctxAx.post("/api/waste", {
        data: { batchId: F.batchB, farmId: F.farmA, wasteType: "DAMAGED", quantity: 1, reason: "E2E poison waste" },
      });
      expect(wasteForeign.status()).toBe(403);

      // 6) Client-supplied farmId is always re-stamped to the caller's farm
      const poSmuggle = await ctxAx.post("/api/purchase-orders", {
        data: {
          supplierId: F.supplierId,
          farmId: F.farmB,
          items: [{ itemId: F.itemA, quantity: 1, unitPrice: 1 }],
          notes: "E2E farmid smuggle probe",
        },
      });
      expect(poSmuggle.status()).toBe(201);
      expect((await poSmuggle.json()).farmId).toBe(F.farmA);

      const reqSmuggle = await ctxAx.post("/api/requests", {
        data: { farmId: F.farmB, itemId: F.itemA, quantity: 1, unitOfMeasure: "bags", purpose: "E2E farmid smuggle probe" },
      });
      expect(reqSmuggle.status()).toBe(201);
      expect((await reqSmuggle.json()).farmId).toBe(F.farmA);

      const whSmuggle = await ctxAx.post("/api/warehouses", {
        data: { name: `E2E-A PROBE ${Date.now()}`, farmId: F.farmB, location: "smuggle probe" },
      });
      expect(whSmuggle.status()).toBe(201);
      expect((await whSmuggle.json()).farmId).toBe(F.farmA);
    } finally {
      await ctxAx.dispose().catch(() => undefined);
    }
  });

  test("a poisoned cross-farm request cannot drain Farm B stock on approval", async () => {
    // The fixture row is Farm A's own request (ownership check passes) but
    // points at Farm B's warehouse + item — the exact shape the create-route
    // used to accept. The fulfilment lookup must refuse to move Farm B stock.
    const before = await ctxB.get(`/api/batches?warehouseId=${F.warehouseB}`);
    expect(before.status()).toBe(200);
    const beforeRows = (await before.json()) as { id: string; quantityRemaining: number }[];
    const beforeQty = beforeRows.find((b) => b.id === F.batchB)?.quantityRemaining;
    expect(beforeQty, "Farm B batch fixture must exist").toBeGreaterThan(0);

    const approve = await ctxA.patch(`/api/requests/${F.poisonRequestA}`, {
      data: { status: "APPROVED" },
    });
    expect(approve.status()).toBe(200);

    const after = await ctxB.get(`/api/batches?warehouseId=${F.warehouseB}`);
    const afterRows = (await after.json()) as { id: string; quantityRemaining: number }[];
    const afterQty = afterRows.find((b) => b.id === F.batchB)?.quantityRemaining;
    expect(afterQty, "Farm B stock must be unchanged by Farm A's approval").toBe(beforeQty);
  });

  test("receiving a cross-farm purchase order cannot credit Farm B's batch", async () => {
    // Items are a shared catalog. Farm A orders the shared item whose only
    // ACTIVE batch belongs to Farm B; on RECEIVED the batch lookup must stay
    // inside Farm A's warehouses. Regression: the lookup was unscoped, so
    // receipt credited Farm B's ACTIVE batch. (Uses the marker-free shared
    // item so Farm A's own PO/batch lists stay free of E2E-B markers.)
    const before = await ctxB.get(`/api/batches?warehouseId=${F.warehouseB}`);
    expect(before.status()).toBe(200);
    const beforeRows = (await before.json()) as { id: string; quantityRemaining: number }[];
    const beforeQty = beforeRows.find((b) => b.id === F.sharedBatchB)?.quantityRemaining;
    expect(beforeQty, "Farm B shared batch fixture must exist").toBeGreaterThan(0);

    const ctxAx = await apiFor(baseURL, EMAIL.managerA);
    try {
      const created = await ctxAx.post("/api/purchase-orders", {
        data: {
          supplierId: F.supplierId,
          farmId: F.farmA,
          items: [{ itemId: F.sharedItem, quantity: 7, unitPrice: 1 }],
          notes: "E2E cross-farm receipt probe",
        },
      });
      expect(created.status()).toBe(201);
      const { id } = (await created.json()) as { id: string };

      type FarmBatchRow = { quantity: number; warehouse: { farmId: string } };
      const sumOwn = async () => {
        const res = await ctxAx.get(`/api/batches?itemId=${F.sharedItem}`);
        expect(res.status()).toBe(200);
        const rows = (await res.json()) as FarmBatchRow[];
        // Positive control part 1: every batch Farm A can see for this
        // item must live in Farm A's own scope.
        for (const row of rows) {
          expect(row.warehouse.farmId).toBe(F.farmA);
        }
        return rows.reduce((sum, row) => sum + row.quantity, 0);
      };
      const ownBefore = await sumOwn();

      const receive = await ctxAx.patch(`/api/purchase-orders/${id}`, {
        data: { status: "RECEIVED" },
      });
      expect(receive.status()).toBe(200);

      // Farm B's stock must be untouched by Farm A's receipt
      const after = await ctxB.get(`/api/batches?warehouseId=${F.warehouseB}`);
      const afterRows = (await after.json()) as { id: string; quantityRemaining: number }[];
      const afterQty = afterRows.find((b) => b.id === F.sharedBatchB)?.quantityRemaining;
      expect(afterQty, "Farm B stock must be unchanged by Farm A's receipt").toBe(beforeQty);

      // Positive control part 2: the received stock landed on Farm A's own
      // scope (a new batch, or an existing Farm A batch credited in place)
      // instead of silently vanishing or landing on Farm B.
      const ownAfter = await sumOwn();
      expect(ownAfter, "Farm A must receive its own stock on receipt").toBe(ownBefore + 7);
    } finally {
      await ctxAx.dispose().catch(() => undefined);
    }
  });

  test("QR lookup and CSV import cannot reach Farm B data", async () => {
    const ctxAx = await apiFor(baseURL, EMAIL.managerA);
    try {
      // QR scan by Farm B's batch number → not found, no metadata
      const scan = await ctxAx.get("/api/qr?code=E2E-B-BATCH-1");
      expect(scan.status()).toBe(404);
      expect(await scan.text()).not.toContain(MARK_B);

      // CSV import referencing Farm B's batch number → row skipped, nothing created
      const csv = [
        "Type,Batch Number,Quantity,Reason",
        "ISSUED,E2E-B-BATCH-1,5,E2E poison import",
      ].join("\n");
      const res = await ctxAx.post("/api/import", {
        multipart: {
          file: { name: "poison.csv", mimeType: "text/csv", buffer: Buffer.from(csv) },
          type: "transactions",
        },
      });
      expect(res.status()).toBe(200);
      const body = (await res.json()) as { created: number; skipped: number; errors: string[] };
      expect(body.created).toBe(0);
      expect(body.skipped).toBe(1);
      expect(JSON.stringify(body.errors)).toContain("not found");
    } finally {
      await ctxAx.dispose().catch(() => undefined);
    }
  });

  test("legitimate same-tenant workflows still succeed", async () => {
    const ctxAx = await apiFor(baseURL, EMAIL.managerA);
    try {
      // Reads by ID inside one's own farm
      const ownCount = await ctxAx.get(`/api/stock-count/${F.stockCountA}`);
      expect(ownCount.status()).toBe(200);
      expect(await ownCount.text()).toContain("E2E-A count");

      const ownTx = await ctxAx.get(`/api/transactions/${F.txA}`);
      expect(ownTx.status()).toBe(200);

      // Create flows still accept legitimate input after the new guards
      const ownReq = await ctxAx.post("/api/requests", {
        data: { farmId: F.farmA, warehouseId: F.warehouseA, itemId: F.itemA, quantity: 2, unitOfMeasure: "bags", purpose: "E2E same-tenant control" },
      });
      expect(ownReq.status()).toBe(201);
      expect((await ownReq.json()).farmId).toBe(F.farmA);

      const ownQr = await ctxAx.post("/api/qr", { data: { batchId: F.batchA } });
      expect(ownQr.status()).toBe(200);
      expect((await ownQr.json()).batchNumber).toBe("E2E-A-BATCH-1");

      // Owner-scoped notification update
      const ownNotif = await ctxAx.patch(`/api/notifications/${F.notificationA}`, {
        data: { isRead: true },
      });
      expect(ownNotif.status()).toBe(200);

      // Farm A may edit its own farm record
      const ownFarm = await ctxAx.patch(`/api/farms/${F.farmA}`, {
        data: { description: "E2E same-tenant control" },
      });
      expect(ownFarm.status()).toBe(200);
    } finally {
      await ctxAx.dispose().catch(() => undefined);
    }
  });

  test("the webhook registry is never readable without a session", async () => {
    const anon = await anonApiFor(baseURL);
    const ctxAdmin2 = await apiFor(baseURL, EMAIL.admin);
    const ctxWorker2 = await apiFor(baseURL, EMAIL.workerA);
    try {
      const created = await ctxAdmin2.post("/api/webhooks", {
        data: { url: "https://example.com/farmops-e2e", events: ["*"] },
      });
      expect(created.status()).toBe(201);
      const { id } = (await created.json()) as { id: string };

      // Regression: this GET previously had no authentication at all
      const unauth = await anon.get(`/api/webhooks/${id}`);
      expect(unauth.status()).toBe(401);

      // Authenticated users match the list route's floor
      const workerRead = await ctxWorker2.get(`/api/webhooks/${id}`);
      expect(workerRead.status()).toBe(200);

      // Non-admins still cannot modify or remove webhooks
      const workerPatch = await ctxWorker2.patch(`/api/webhooks/${id}`, {
        data: { isActive: false },
      });
      expect(workerPatch.status()).toBe(403);
      const workerDelete = await ctxWorker2.delete(`/api/webhooks/${id}`);
      expect(workerDelete.status()).toBe(403);

      // Cleanup (admin only)
      const removed = await ctxAdmin2.delete(`/api/webhooks/${id}`);
      expect(removed.status()).toBe(200);
    } finally {
      await Promise.all(
        [anon.dispose(), ctxAdmin2.dispose(), ctxWorker2.dispose()].map((p) =>
          p.catch(() => undefined)
        )
      );
    }
  });

  test("farm-pinned API keys can never read across tenants", async () => {
    const ctxAdmin2 = await apiFor(baseURL, EMAIL.admin);
    try {
      const created = await ctxAdmin2.post("/api/api-keys", {
        data: {
          name: `E2E pinned ${Date.now()}`,
          permissions: ["read:inventory", "read:transactions"],
          farmId: F.farmA,
        },
      });
      expect(created.status()).toBe(201);
      const { key } = (await created.json()) as { key: string };
      expect(key.startsWith("fops_")).toBe(true);

      // External API auth is key-only — no session, no Origin needed
      const external = await anonApiFor(baseURL);
      try {
        const inv = await external.get("/api/external/inventory?limit=100", {
          headers: { Authorization: `Bearer ${key}` },
        });
        expect(inv.status()).toBe(200);
        const invBody = await inv.text();
        expect(invBody, "pinned key must include Farm A stock").toContain("E2E-A-BATCH-1");
        expect(invBody).not.toContain("E2E-B-BATCH-1");
        expect(invBody).not.toContain("E2E-B Warehouse");

        // Requesting Farm B explicitly must be ignored — the key is pinned to A
        const tx = await external.get(`/api/external/transactions?farmId=${F.farmB}&limit=100`, {
          headers: { Authorization: `Bearer ${key}` },
        });
        expect(tx.status()).toBe(200);
        const txBody = await tx.text();
        expect(txBody).not.toContain(MARK_B);
        expect(txBody).not.toContain("E2E-B-BATCH-1");
      } finally {
        await external.dispose().catch(() => undefined);
      }
    } finally {
      await ctxAdmin2.dispose().catch(() => undefined);
    }
  });
});
