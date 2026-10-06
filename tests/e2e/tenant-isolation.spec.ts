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
 * Requires: a running FarmOps server (BASE_URL) and DATABASE_URL for fixture
 * setup. Runs automatically in CI's E2E job.
 */
import { test, expect, type APIRequestContext } from "@playwright/test";
import ExcelJS from "exceljs";
import {
  EMAIL,
  ensureTenantFixtures,
  apiFor,
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
    const endpoints: { path: string; mustContain?: string }[] = [
      { path: "/api/warehouses", mustContain: "E2E-A Warehouse" },
      { path: "/api/transactions?limit=100", mustContain: "E2E-A-BATCH-1" },
      { path: "/api/requests", mustContain: "E2E-A-REQ-1" },
      { path: "/api/purchase-orders", mustContain: "E2E-A-PO-1" },
      { path: "/api/seasons", mustContain: "E2E-A Season" },
      { path: "/api/waste", mustContain: "E2E-A waste" },
      { path: "/api/stock-count", mustContain: "E2E-A count" },
      { path: "/api/batches", mustContain: "E2E-A-BATCH-1" },
      { path: "/api/farms", mustContain: "E2E Farm Alpha" },
      { path: "/api/alerts?type=all" },
      { path: "/api/notifications" },
      { path: "/api/dashboard/overview" },
      { path: "/api/reports?type=dashboard" },
      { path: "/api/reports?type=suppliers" },
    ];

    for (const { path, mustContain } of endpoints) {
      const res = await ctxA.get(path);
      expect(res.status(), `${path} should be 200`).toBe(200);
      const body = await res.text();
      expect(body, `${path} must not leak Farm B data`).not.toContain(MARK_B);
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
      `/api/requests?farmId=${F.farmB}`,
      `/api/reports?type=dashboard&farmId=${F.farmB}`,
      `/api/batches?farmId=${F.farmB}`,
    ];
    for (const path of paths) {
      const res = await ctxA.get(path);
      expect(res.status(), `${path} should be 200`).toBe(200);
      const body = await res.text();
      expect(body, `${path} must ignore the requested foreign farmId`).not.toContain(MARK_B);
    }
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
});
