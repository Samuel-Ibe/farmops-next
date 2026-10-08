"use client";

import { useState, useEffect } from "react";
import { FormDialog } from "@/components/shared/form-dialog";
import { FormField } from "@/components/ui/form-field";
import { FormSelect } from "@/components/ui/form-select";
import type { InventoryItem, Supplier, Warehouse } from "@prisma/client";

type WarehouseWithFarm = Warehouse & { farm: { name: string } | null };

interface BatchFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
  itemId?: string;
}

export function BatchForm({
  open,
  onOpenChange,
  onSuccess,
  itemId,
}: BatchFormProps) {
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [warehouses, setWarehouses] = useState<WarehouseWithFarm[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);

  const [form, setForm] = useState({
    itemId: "",
    batchNumber: "",
    warehouseId: "",
    supplierId: "",
    quantityReceived: "",
    purchasePrice: "",
    manufactureDate: "",
    expiryDate: "",
    purchaseDate: "",
    notes: "",
  });

  useEffect(() => {
    if (open) {
      Promise.all([
        fetch("/api/inventory").then((r) => r.json()),
        fetch("/api/warehouses").then((r) => r.json()),
        fetch("/api/suppliers").then((r) => r.json()),
      ])
        .then(([itemData, whData, supData]: [InventoryItem[], WarehouseWithFarm[], Supplier[]]) => {
          setItems(itemData);
          setWarehouses(whData);
          setSuppliers(supData);
        })
        .catch(() => {});
    }
  }, [open]);

  // Pre-select the item when `itemId` (or the dialog's open state) changes —
  // state is adjusted during render instead of in an effect
  // (react-hooks/set-state-in-effect).
  const [prevSync, setPrevSync] = useState<{
    itemId: string | undefined;
    open: boolean;
  } | null>(null);
  if (prevSync === null || prevSync.itemId !== itemId || prevSync.open !== open) {
    setPrevSync({ itemId, open });
    if (itemId) {
      setForm((prev) => ({ ...prev, itemId }));
    }
  }

  const handleSubmit = async () => {
    const res = await fetch("/api/batches", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...form,
        quantityReceived: parseInt(form.quantityReceived),
        purchasePrice: parseFloat(form.purchasePrice),
      }),
    });

    if (!res.ok) {
      const err: { error?: string } = await res.json();
      throw new Error(err.error || "Failed to create batch");
    }

    onSuccess();
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Add New Batch (Stock In)"
      description="Receive new inventory stock into a warehouse"
      onSubmit={handleSubmit}
      submitLabel="Receive Stock"
      successMessage="Stock received and batch created"
    >
      <div className="grid gap-4">
        {!itemId && (
          <FormSelect
            label="Inventory Item"
            value={form.itemId}
            onChange={(e) => setForm({ ...form, itemId: e.target.value })}
            options={items.map((i) => ({
              value: i.id,
              label: `${i.name} (${i.unitOfMeasure})`,
            }))}
            placeholder="Select item"
            required
          />
        )}

        <FormField
          label="Batch Number"
          placeholder="e.g. NPK-0826-003"
          value={form.batchNumber}
          onChange={(e) =>
            setForm({ ...form, batchNumber: e.target.value })
          }
          required
        />

        <FormSelect
          label="Warehouse"
          value={form.warehouseId}
          onChange={(e) =>
            setForm({ ...form, warehouseId: e.target.value })
          }
          options={warehouses.map((w) => ({
            value: w.id,
            label: `${w.name} (${w.farm?.name || "Unknown"})`,
          }))}
          placeholder="Select warehouse"
          required
        />

        <div className="grid grid-cols-2 gap-4">
          <FormField
            label="Quantity Received"
            type="number"
            placeholder="0"
            value={form.quantityReceived}
            onChange={(e) =>
              setForm({ ...form, quantityReceived: e.target.value })
            }
            required
          />
          <FormField
            label="Purchase Price (per unit)"
            type="number"
            placeholder="GH₵ 0.00"
            value={form.purchasePrice}
            onChange={(e) =>
              setForm({ ...form, purchasePrice: e.target.value })
            }
            required
          />
        </div>

        <FormSelect
          label="Supplier"
          value={form.supplierId}
          onChange={(e) =>
            setForm({ ...form, supplierId: e.target.value })
          }
          options={suppliers.map((s) => ({ value: s.id, label: s.name }))}
          placeholder="Select supplier (optional)"
        />

        <div className="grid grid-cols-2 gap-4">
          <FormField
            label="Purchase Date"
            type="date"
            value={form.purchaseDate}
            onChange={(e) =>
              setForm({ ...form, purchaseDate: e.target.value })
            }
          />
          <FormField
            label="Expiry Date"
            type="date"
            value={form.expiryDate}
            onChange={(e) =>
              setForm({ ...form, expiryDate: e.target.value })
            }
            description="If applicable"
          />
        </div>

        <FormField
          label="Manufacture Date"
          type="date"
          value={form.manufactureDate}
          onChange={(e) =>
            setForm({ ...form, manufactureDate: e.target.value })
          }
        />
      </div>
    </FormDialog>
  );
}
