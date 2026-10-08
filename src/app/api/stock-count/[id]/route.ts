import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { mutationGuard, writeAuditLog, getClientIp, requireAuth, resolveFarmScope } from "@/lib/api-auth";
import { applyStockDelta } from "@/lib/stock";
import { logRouteError } from "@/lib/logger";
import { validate, updateStockCountSchema } from "@/lib/api-validations";

// Stock counts are scoped to the warehouse's farm
function farmScopeWhere(user: { role: string; farmId?: string | null }) {
  const farmScope = resolveFarmScope(user);
  return farmScope !== null ? { warehouse: { farmId: farmScope } } : {};
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await requireAuth();
    if (user instanceof NextResponse) return user;
    const { id } = await params;

    const stockCount = await prisma.stockCount.findFirst({
      where: { id, ...farmScopeWhere(user) },
      include: {
        warehouse: true,
        countedBy: { select: { name: true, role: true } },
        items: {
          include: {
            batch: {
              include: { item: true },
            },
          },
        },
      },
    });

    if (!stockCount) {
      return NextResponse.json({ error: "Stock count not found" }, { status: 404 });
    }

    return NextResponse.json(stockCount);
  } catch (error) {
    logRouteError(request, "Error fetching stock count", error);
    return NextResponse.json({ error: "Failed to fetch stock count" }, { status: 500 });
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await mutationGuard(request, { minRole: "WAREHOUSE_MANAGER" });
    if (user instanceof NextResponse) return user;

    const { id } = await params;
    const body: unknown = await request.json();
    const validation = validate(updateStockCountSchema, body);
    if (!validation.success) {
      return NextResponse.json({ error: validation.error, details: validation.details }, { status: 400 });
    }
    const data = validation.data;

    const existing = await prisma.stockCount.findFirst({
      where: { id, ...farmScopeWhere(user) },
      include: { items: true },
    });

    if (!existing) {
      return NextResponse.json({ error: "Stock count not found" }, { status: 404 });
    }

    const allowedUpdates: Prisma.StockCountUpdateInput = {};

    // Status update: IN_PROGRESS -> COMPLETED -> RECONCILED
    if (data.status) {
      const validTransitions: Record<string, string[]> = {
        IN_PROGRESS: ["COMPLETED"],
        COMPLETED: ["RECONCILED"],
      };

      const allowed = validTransitions[existing.status] || [];
      if (!allowed.includes(data.status)) {
        return NextResponse.json(
          { error: `Cannot transition from ${existing.status} to ${data.status}` },
          { status: 400 }
        );
      }
      allowedUpdates.status = data.status;
    }

    if (data.notes !== undefined) {
      allowedUpdates.notes = data.notes;
    }

    if (Object.keys(allowedUpdates).length === 0 && !data.items) {
      return NextResponse.json({ error: "No valid fields to update" }, { status: 400 });
    }

    // Reconciliation (variance application), item bookkeeping and the count
    // status transition commit atomically — a lost race on any batch's
    // quantity aborts the whole reconciliation with 409 instead of clamping
    // to zero and recording a transaction for stock that was never moved.
    const outcome = await prisma.$transaction(async (tx) => {
    // Update item quantities if provided
    if (data.items) {
      for (const itemUpdate of data.items) {
        if (itemUpdate.id && itemUpdate.countedQuantity !== undefined) {
          const countItem = await tx.stockCountItem.findUnique({
            where: { id: itemUpdate.id },
          });
          if (countItem && countItem.stockCountId === id) {
            const variance = itemUpdate.countedQuantity - Number(countItem.systemQuantity);
            await tx.stockCountItem.update({
              where: { id: itemUpdate.id },
              data: {
                countedQuantity: itemUpdate.countedQuantity,
                variance,
                notes: itemUpdate.notes || countItem.notes,
              },
            });

            // If reconciling, apply variance to the actual batch
            if (data.status === "RECONCILED" && variance !== 0) {
              const batch = await tx.inventoryBatch.findUnique({
                where: { id: countItem.batchId },
              });
              if (batch) {
                const adjustment = await applyStockDelta(tx, batch.id, variance);
                if (!adjustment.ok) return { error: adjustment } as const;

                // Record the adjustment as a transaction
                await tx.stockTransaction.create({
                  data: {
                    type: variance > 0 ? "RECEIVED" : "ADJUSTED",
                    batchId: batch.id,
                    quantity: Math.abs(variance),
                    unitCost: Number(batch.purchasePrice),
                    totalValue: Math.abs(variance) * Number(batch.purchasePrice),
                    reason: `Stock count reconciliation - variance of ${variance > 0 ? "+" : ""}${variance}`,
                    performedById: user.id,
                  },
                });
              }
            }
          }
        }
      }
    }

    const updated = await tx.stockCount.update({
      where: { id },
      data: allowedUpdates,
      include: {
        warehouse: true,
        countedBy: { select: { name: true } },
        items: {
          include: {
            batch: { include: { item: true } },
          },
        },
      },
    });
    return { updated } as const;
    });

    if (outcome.error) {
      if (outcome.error.reason === "BATCH_NOT_FOUND") {
        return NextResponse.json({ error: "Batch no longer exists" }, { status: 409 });
      }
      return NextResponse.json(
        { error: "Insufficient stock to reconcile this variance", available: outcome.error.available ?? 0 },
        { status: 409 }
      );
    }

    const updated = outcome.updated;

    await writeAuditLog({
      userId: user.id,
      action: "UPDATE",
      entity: "StockCount",
      entityId: id,
      oldValues: { status: existing.status },
      newValues: { status: String(allowedUpdates.status || existing.status) },
      ipAddress: getClientIp(request),
    });

    return NextResponse.json(updated);
  } catch (error) {
    logRouteError(request, "Error updating stock count", error);
    return NextResponse.json({ error: "Failed to update stock count" }, { status: 500 });
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await mutationGuard(request, { minRole: "ADMIN" });
    if (user instanceof NextResponse) return user;

    const { id } = await params;

    const existing = await prisma.stockCount.findUnique({ where: { id } });
    if (!existing) {
      return NextResponse.json({ error: "Stock count not found" }, { status: 404 });
    }

    if (existing.status === "RECONCILED") {
      return NextResponse.json(
        { error: "Cannot delete a reconciled stock count" },
        { status: 400 }
      );
    }

    // Delete items first, then the stock count
    await prisma.stockCountItem.deleteMany({ where: { stockCountId: id } });
    await prisma.stockCount.delete({ where: { id } });

    await writeAuditLog({
      userId: user.id,
      action: "DELETE",
      entity: "StockCount",
      entityId: id,
      oldValues: { warehouseId: existing.warehouseId, status: existing.status },
      ipAddress: getClientIp(request),
    });

    return NextResponse.json({ message: "Stock count deleted" });
  } catch (error) {
    logRouteError(request, "Error deleting stock count", error);
    return NextResponse.json({ error: "Failed to delete stock count" }, { status: 500 });
  }
}
