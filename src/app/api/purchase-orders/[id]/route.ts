import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { mutationGuard, writeAuditLog } from "@/lib/api-auth";
import { validate, updatePurchaseOrderSchema } from "@/lib/api-validations";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await mutationGuard(request, { minRole: "FARM_MANAGER" });
    if (user instanceof NextResponse) return user;

    const { id } = await params;
    const body: unknown = await request.json();

    const po = await prisma.purchaseOrder.findUnique({ where: { id } });
    if (!po) {
      return NextResponse.json({ error: "Purchase order not found" }, { status: 404 });
    }

    // Ownership: non-admins may only touch POs belonging to their own farm
    if (user.role !== "ADMIN" && po.farmId !== user.farmId) {
      return NextResponse.json({ error: "Purchase order belongs to another farm" }, { status: 403 });
    }

    const validation = validate(updatePurchaseOrderSchema, body);
    if (!validation.success) {
      return NextResponse.json({ error: validation.error, details: validation.details }, { status: 400 });
    }
    const { status, notes, actualDeliveryDate } = validation.data;

    const updateData: Prisma.PurchaseOrderUpdateInput = {};
    if (status) updateData.status = status;
    if (notes !== undefined) updateData.notes = notes;
    if (actualDeliveryDate) updateData.actualDeliveryDate = new Date(actualDeliveryDate);

    // Receipt is one atomic unit: every per-item stock credit, the PO-item
    // received quantities and the status flip must succeed or roll back
    // together. A mid-loop failure previously left credited batches and
    // half-received items on a PO that stayed DRAFT — and a retry then
    // double-credited the items that had succeeded (Phase 2 regression:
    // tests/e2e/concurrency.spec.ts S10).
    const updated = await prisma.$transaction(async (tx) => {
      if (status === "RECEIVED" && po.status !== "RECEIVED") {
        updateData.actualDeliveryDate = updateData.actualDeliveryDate || new Date();

        // Atomic claim: the stale `po` read above cannot serialize two
        // concurrent RECEIVED patches, so re-check status under a row lock
        // BEFORE crediting. The loser's updateMany matches 0 rows (Postgres
        // re-evaluates the predicate after the winner commits) and must not
        // credit a single batch. (Phase 2 review: concurrency.spec.ts S11.)
        const claimed = await tx.purchaseOrder.updateMany({
          where: { id, status: { not: "RECEIVED" } },
          data: {
            status: "RECEIVED",
            actualDeliveryDate: updateData.actualDeliveryDate,
          },
        });
        if (claimed.count === 0) return null;

        const poItems = await tx.purchaseOrderItem.findMany({
          where: { purchaseOrderId: id },
        });

        for (const poItem of poItems) {
          // Find existing batch for this item in any warehouse for this farm
          // (warehouse scope is required: items are a shared cross-farm catalog,
          // so an unscoped lookup could credit another farm's batch on receipt)
          const existingBatch = await tx.inventoryBatch.findFirst({
            where: {
              itemId: poItem.itemId,
              status: "ACTIVE",
              warehouse: { farmId: po.farmId },
            },
          });

          if (existingBatch) {
            // Update existing batch
            await tx.inventoryBatch.update({
              where: { id: existingBatch.id },
              data: {
                quantity: existingBatch.quantity + poItem.quantity,
                quantityRemaining: existingBatch.quantityRemaining + poItem.quantity,
              },
            });
          } else {
            // Create new batch — the receiving farm must have a warehouse;
            // throwing inside the transaction rolls the whole receipt back
            // instead of attempting an invalid empty warehouseId.
            const receivingWarehouse = await tx.warehouse.findFirst({
              where: { farmId: po.farmId },
            });
            if (!receivingWarehouse) {
              throw new Error(
                `Cannot receive PO ${po.orderNumber}: farm ${po.farmId} has no warehouse`
              );
            }
            await tx.inventoryBatch.create({
              data: {
                itemId: poItem.itemId,
                batchNumber: `PO-${po.orderNumber}-${poItem.id.slice(-6)}`,
                supplierId: po.supplierId,
                purchasePrice: poItem.unitPrice,
                quantity: poItem.quantity,
                quantityRemaining: poItem.quantity,
                warehouseId: receivingWarehouse.id,
                status: "ACTIVE",
                purchaseDate: new Date(),
                notes: `Received from PO ${po.orderNumber}`,
              },
            });
          }

          // Mark PO item as fully received
          await tx.purchaseOrderItem.update({
            where: { id: poItem.id },
            data: { quantityReceived: poItem.quantity },
          });
        }
      }

      return tx.purchaseOrder.update({
        where: { id },
        data: updateData,
        include: { items: { include: { item: true } }, supplier: true, farm: true },
      });
    });

    // A null result means another request won the receipt race — nothing was
    // credited (the transaction rolled the no-op claim back harmlessly).
    if (!updated) {
      return NextResponse.json(
        { error: "Purchase order has already been received" },
        { status: 409 }
      );
    }

    // Audit log
    await writeAuditLog({
      userId: user?.id,
      action: status ? `STATUS_${status}` : "UPDATE",
      entity: "PurchaseOrder",
      entityId: id,
      oldValues: { status: po.status },
      newValues: { status: status || po.status },
    });

    return NextResponse.json(updated);
  } catch (error) {
    console.error("Error updating purchase order:", error);
    return NextResponse.json({ error: "Failed to update purchase order" }, { status: 500 });
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

    const po = await prisma.purchaseOrder.findUnique({ where: { id } });
    if (!po) {
      return NextResponse.json({ error: "Purchase order not found" }, { status: 404 });
    }

    if (po.status !== "DRAFT" && po.status !== "CANCELLED") {
      return NextResponse.json(
        { error: "Only draft or cancelled POs can be deleted" },
        { status: 400 }
      );
    }

    // Delete PO items first
    await prisma.purchaseOrderItem.deleteMany({ where: { purchaseOrderId: id } });
    await prisma.purchaseOrder.delete({ where: { id } });

    return NextResponse.json({ message: "Purchase order deleted" });
  } catch (error) {
    console.error("Error deleting purchase order:", error);
    return NextResponse.json({ error: "Failed to delete purchase order" }, { status: 500 });
  }
}
