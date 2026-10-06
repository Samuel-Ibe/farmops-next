/**
 * Tenant-isolation E2E fixtures (roadmap Phase 1).
 *
 * Creates two fully independent tenants — Farm A ("E2E Farm Alpha") and Farm B
 * ("E2E Farm Beta") — each with users, a warehouse, items, batches,
 * transactions, requests, purchase orders, seasons, waste records, stock
 * counts and notifications, plus an unassigned user and an admin.
 *
 * Everything is idempotent (find-first-or-create) and marked with the
 * `E2E-A` / `E2E-B` prefixes so the spec can detect ANY cross-tenant byte in a
 * response body.
 *
 * Authentication goes through the real NextAuth credentials callback over
 * HTTP, exactly like the login page — no session shortcuts.
 */
import path from "path";
import bcrypt from "bcryptjs";
import { PrismaClient, type UserRole } from "@prisma/client";
import { request as pwRequest, type APIRequestContext } from "@playwright/test";

/** Test-only password for pre-provisioned E2E accounts (never a real user). */
export const E2E_PASSWORD = "TenantIsolation!A1";

export const EMAIL = {
  managerA: "e2e-farma@farmops.test",
  managerB: "e2e-farmb@farmops.test",
  workerA: "e2e-farma-worker@farmops.test",
  unassigned: "e2e-unassigned@farmops.test",
  admin: "e2e-admin@farmops.test",
} as const;

export interface FixtureIds {
  farmA: string;
  farmB: string;
  warehouseA: string;
  warehouseB: string;
  itemA: string;
  itemB: string;
  batchA: string;
  batchB: string;
  txA: string;
  txB: string;
  requestA: string;
  requestB: string;
  poA: string;
  poB: string;
  seasonA: string;
  seasonB: string;
  wasteA: string;
  wasteB: string;
  stockCountA: string;
  stockCountB: string;
  notificationA: string;
  notificationB: string;
  managerA: string;
  managerB: string;
}

/** Load DATABASE_URL from .env when the process doesn't already have it. */
function ensureDatabaseUrl(): void {
  if (process.env.DATABASE_URL) return;
  try {
    const loadEnvFile = (process as unknown as {
      loadEnvFile?: (p: string) => void;
    }).loadEnvFile;
    loadEnvFile?.call(process, path.join(process.cwd(), ".env"));
  } catch {
    /* fall through to the error below */
  }
  if (!process.env.DATABASE_URL) {
    throw new Error(
      "DATABASE_URL is not set. Export it or provide a .env file — the " +
        "tenant-isolation fixtures need database access."
    );
  }
}

let cachedIds: FixtureIds | null = null;

export async function ensureTenantFixtures(): Promise<FixtureIds> {
  if (cachedIds) return cachedIds;
  ensureDatabaseUrl();

  const prisma = new PrismaClient();

  // ─── find-first-or-create helpers (idempotent, self-healing) ───
  const upsertFarm = async (name: string, location: string) => {
    const existing = await prisma.farm.findFirst({ where: { name } });
    return existing ?? prisma.farm.create({ data: { name, location } });
  };

  const upsertWarehouse = async (name: string, farmId: string) => {
    const existing = await prisma.warehouse.findFirst({ where: { name } });
    return existing ?? prisma.warehouse.create({ data: { name, farmId } });
  };

  const upsertUser = async (
    email: string,
    data: { name: string; role: UserRole; farmId?: string | null }
  ) => {
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      // Re-link on every run so a partial previous run self-heals.
      return prisma.user.update({
        where: { email },
        data: { isActive: true, farmId: data.farmId ?? null, role: data.role },
      });
    }
    return prisma.user.create({
      data: {
        email,
        name: data.name,
        password: await bcrypt.hash(E2E_PASSWORD, 10),
        role: data.role,
        isActive: true,
        farmId: data.farmId ?? undefined,
      },
    });
  };

  const upsertSupplier = async (name: string) => {
    const existing = await prisma.supplier.findFirst({ where: { name } });
    return existing ?? prisma.supplier.create({ data: { name } });
  };

  const upsertItem = async (name: string, categoryId: string, supplierId: string) => {
    const existing = await prisma.inventoryItem.findFirst({ where: { name } });
    return (
      existing ??
      prisma.inventoryItem.create({
        data: { name, categoryId, unitOfMeasure: "bags", defaultSupplierId: supplierId },
      })
    );
  };

  const upsertBatch = async (batchNumber: string, itemId: string, warehouseId: string) => {
    const existing = await prisma.inventoryBatch.findUnique({ where: { batchNumber } });
    return (
      existing ??
      prisma.inventoryBatch.create({
        data: {
          itemId,
          batchNumber,
          warehouseId,
          purchasePrice: 10,
          quantity: 100,
          quantityRemaining: 100,
          status: "ACTIVE",
        },
      })
    );
  };

  const upsertTx = async (args: {
    batchId: string;
    warehouseId: string;
    farmId: string;
    performedById: string;
    reason: string;
  }) => {
    const existing = await prisma.stockTransaction.findFirst({
      where: { batchId: args.batchId, reason: args.reason },
    });
    if (existing) return existing;
    return prisma.stockTransaction.create({
      data: {
        type: "RECEIVED",
        batchId: args.batchId,
        toWarehouseId: args.warehouseId,
        quantity: 100,
        unitCost: 10,
        totalValue: 1000,
        reason: args.reason,
        performedById: args.performedById,
        farmId: args.farmId,
      },
    });
  };

  const upsertRequest = async (
    requestNumber: string,
    args: {
      requestedById: string;
      farmId: string;
      warehouseId: string;
      itemId: string;
      purpose: string;
    }
  ) => {
    const existing = await prisma.resourceRequest.findUnique({ where: { requestNumber } });
    if (existing) return existing;
    return prisma.resourceRequest.create({
      data: {
        requestNumber,
        requestedById: args.requestedById,
        farmId: args.farmId,
        warehouseId: args.warehouseId,
        itemId: args.itemId,
        quantity: 5,
        unitOfMeasure: "bags",
        purpose: args.purpose,
        priority: "MEDIUM",
        status: "PENDING",
      },
    });
  };

  const upsertPo = async (
    orderNumber: string,
    args: { supplierId: string; farmId: string; createdById: string }
  ) => {
    const existing = await prisma.purchaseOrder.findUnique({ where: { orderNumber } });
    if (existing) return existing;
    return prisma.purchaseOrder.create({
      data: {
        orderNumber,
        supplierId: args.supplierId,
        farmId: args.farmId,
        createdById: args.createdById,
        status: "DRAFT",
        totalAmount: 100,
      },
    });
  };

  const upsertSeason = async (name: string, farmId: string) => {
    const existing = await prisma.season.findFirst({ where: { name } });
    if (existing) return existing;
    return prisma.season.create({
      data: {
        name,
        farmId,
        cropType: "Test Crop",
        startDate: new Date("2026-01-01"),
        endDate: new Date("2026-12-31"),
        status: "PLANNING",
      },
    });
  };

  const upsertWaste = async (
    batchId: string,
    farmId: string,
    reportedById: string,
    reason: string
  ) => {
    const existing = await prisma.wasteRecord.findFirst({ where: { batchId, reason } });
    if (existing) return existing;
    return prisma.wasteRecord.create({
      data: {
        batchId,
        quantity: 1,
        wasteType: "DAMAGED",
        reason,
        reportedById,
        farmId,
        estimatedValue: 10,
      },
    });
  };

  const upsertStockCount = async (notes: string, warehouseId: string, countedById: string) => {
    const existing = await prisma.stockCount.findFirst({ where: { notes } });
    if (existing) return existing;
    return prisma.stockCount.create({
      data: { notes, warehouseId, countedById, status: "COMPLETED" },
    });
  };

  const upsertNotification = async (userId: string, title: string) => {
    const existing = await prisma.notification.findFirst({ where: { userId, title } });
    if (existing) return existing;
    return prisma.notification.create({
      data: { userId, type: "LOW_STOCK", title, message: title },
    });
  };

  try {
    const farmA = await upsertFarm("E2E Farm Alpha", "Test Tenant A");
    const farmB = await upsertFarm("E2E Farm Beta", "Test Tenant B");
    const warehouseA = await upsertWarehouse("E2E-A Warehouse", farmA.id);
    const warehouseB = await upsertWarehouse("E2E-B Warehouse", farmB.id);

    const managerA = await upsertUser(EMAIL.managerA, {
      name: "E2E Farm A Manager",
      role: "FARM_MANAGER",
      farmId: farmA.id,
    });
    const managerB = await upsertUser(EMAIL.managerB, {
      name: "E2E Farm B Manager",
      role: "FARM_MANAGER",
      farmId: farmB.id,
    });
    await upsertUser(EMAIL.workerA, {
      name: "E2E Farm A Worker",
      role: "FIELD_WORKER",
      farmId: farmA.id,
    });
    await upsertUser(EMAIL.unassigned, {
      name: "E2E Unassigned User",
      role: "WAREHOUSE_MANAGER",
      farmId: null,
    });
    await upsertUser(EMAIL.admin, {
      name: "E2E Admin",
      role: "ADMIN",
      farmId: null,
    });

    const category = await prisma.category.upsert({
      where: { name: "E2E Test Category" },
      update: {},
      create: { name: "E2E Test Category" },
    });
    const supplier = await upsertSupplier("E2E Test Supplier");

    const itemA = await upsertItem("E2E-A Maize Seed", category.id, supplier.id);
    const itemB = await upsertItem("E2E-B Cocoa Beans", category.id, supplier.id);

    const batchA = await upsertBatch("E2E-A-BATCH-1", itemA.id, warehouseA.id);
    const batchB = await upsertBatch("E2E-B-BATCH-1", itemB.id, warehouseB.id);

    const txA = await upsertTx({
      batchId: batchA.id,
      warehouseId: warehouseA.id,
      farmId: farmA.id,
      performedById: managerA.id,
      reason: "E2E-A restock",
    });
    const txB = await upsertTx({
      batchId: batchB.id,
      warehouseId: warehouseB.id,
      farmId: farmB.id,
      performedById: managerB.id,
      reason: "E2E-B restock",
    });

    const requestA = await upsertRequest("E2E-A-REQ-1", {
      requestedById: managerA.id,
      farmId: farmA.id,
      warehouseId: warehouseA.id,
      itemId: itemA.id,
      purpose: "E2E-A purpose",
    });
    const requestB = await upsertRequest("E2E-B-REQ-1", {
      requestedById: managerB.id,
      farmId: farmB.id,
      warehouseId: warehouseB.id,
      itemId: itemB.id,
      purpose: "E2E-B purpose",
    });

    const poA = await upsertPo("E2E-A-PO-1", {
      supplierId: supplier.id,
      farmId: farmA.id,
      createdById: managerA.id,
    });
    const poB = await upsertPo("E2E-B-PO-1", {
      supplierId: supplier.id,
      farmId: farmB.id,
      createdById: managerB.id,
    });

    const seasonA = await upsertSeason("E2E-A Season", farmA.id);
    const seasonB = await upsertSeason("E2E-B Season", farmB.id);

    const wasteA = await upsertWaste(batchA.id, farmA.id, managerA.id, "E2E-A waste");
    const wasteB = await upsertWaste(batchB.id, farmB.id, managerB.id, "E2E-B waste");

    const stockCountA = await upsertStockCount("E2E-A count", warehouseA.id, managerA.id);
    const stockCountB = await upsertStockCount("E2E-B count", warehouseB.id, managerB.id);

    const notificationA = await upsertNotification(managerA.id, "E2E-A private notice");
    const notificationB = await upsertNotification(managerB.id, "E2E-B private notice");

    cachedIds = {
      farmA: farmA.id,
      farmB: farmB.id,
      warehouseA: warehouseA.id,
      warehouseB: warehouseB.id,
      itemA: itemA.id,
      itemB: itemB.id,
      batchA: batchA.id,
      batchB: batchB.id,
      txA: txA.id,
      txB: txB.id,
      requestA: requestA.id,
      requestB: requestB.id,
      poA: poA.id,
      poB: poB.id,
      seasonA: seasonA.id,
      seasonB: seasonB.id,
      wasteA: wasteA.id,
      wasteB: wasteB.id,
      stockCountA: stockCountA.id,
      stockCountB: stockCountB.id,
      notificationA: notificationA.id,
      notificationB: notificationB.id,
      managerA: managerA.id,
      managerB: managerB.id,
    };
    return cachedIds;
  } finally {
    await prisma.$disconnect();
  }
}

// ─── Real-HTTP authentication ────────────────────────────────────────

type StorageState = Awaited<ReturnType<APIRequestContext["storageState"]>>;

const storageStates = new Map<string, StorageState>();

/**
 * Sign in through the real NextAuth credentials callback and cache the
 * resulting cookie jar per email (so the suite stays well inside the login
 * rate limit). Throws when authentication fails.
 */
export async function loginStorageState(baseURL: string, email: string): Promise<StorageState> {
  const cached = storageStates.get(email);
  if (cached) return cached;

  const ctx = await pwRequest.newContext({ baseURL });
  try {
    const csrfRes = await ctx.get("/api/auth/csrf");
    if (!csrfRes.ok()) {
      throw new Error(`csrf endpoint failed (${csrfRes.status()}) for ${email}`);
    }
    const { csrfToken } = await csrfRes.json();

    await ctx.post("/api/auth/callback/credentials", {
      form: {
        csrfToken,
        email,
        password: E2E_PASSWORD,
        callbackUrl: `${baseURL}/`,
        redirect: "false",
        json: "true",
      },
      headers: { Origin: baseURL, Referer: `${baseURL}/login` },
    });

    const sessionRes = await ctx.get("/api/auth/session");
    const session = sessionRes.ok() ? await sessionRes.json() : null;
    const sessionEmail = session?.user?.email?.toLowerCase();
    if (sessionEmail !== email.toLowerCase()) {
      throw new Error(
        `E2E login failed for ${email} (session: ${sessionEmail ?? "none"}). ` +
          `Check that the fixture user exists, isActive=true and NEXTAUTH_SECRET is set.`
      );
    }

    const state = await ctx.storageState();
    storageStates.set(email, state);
    return state;
  } finally {
    await ctx.dispose();
  }
}

let ipCounter = 0;

/**
 * A unique-ish private IP per context. Randomized per process so repeated
 * local runs never share a rate-limit budget with the previous run's
 * requests (each context gets its own 30/min mutation allowance).
 */
function freshIp(prefix: "198.51" | "203.0"): string {
  ipCounter += 1;
  const a = Math.floor(Math.random() * 254) + 1;
  const b = ipCounter % 254;
  return `${prefix}.${a}.${b}`;
}

/**
 * An API request context authenticated as `email`, with:
 * - the Origin header every mutating route requires (CSRF check), and
 * - a unique X-Forwarded-For per context so rate-limit budgets are per-user
 *   instead of shared across the whole suite.
 */
export async function apiFor(baseURL: string, email: string): Promise<APIRequestContext> {
  const storageState = await loginStorageState(baseURL, email);
  return pwRequest.newContext({
    baseURL,
    storageState,
    extraHTTPHeaders: {
      Origin: baseURL,
      "X-Forwarded-For": freshIp("198.51"),
    },
  });
}

/** A signed-out request context (its own rate-limit budget). */
export async function anonApiFor(baseURL: string): Promise<APIRequestContext> {
  return pwRequest.newContext({
    baseURL,
    extraHTTPHeaders: { "X-Forwarded-For": freshIp("203.0") },
  });
}
