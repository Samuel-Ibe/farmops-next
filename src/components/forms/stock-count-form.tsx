"use client";

import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { FormSelect } from "@/components/ui/form-select";
import { useToast } from "@/components/ui/toast";
import { Loader2, AlertTriangle } from "lucide-react";
import type { InventoryBatch, Warehouse } from "@prisma/client";
import type { InventoryItemWithTotals } from "@/app/api/inventory/route";

type WarehouseWithFarm = Warehouse & { farm?: { name: string } | null };
type CountBatch = InventoryBatch & { itemName: string; unit: string };
type CountItem = {
  batchId: string;
  systemQuantity: number;
  countedQuantity: number;
  notes: string;
};

interface StockCountFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}

export function StockCountForm({ open, onOpenChange, onSuccess }: StockCountFormProps) {
  const [loading, setLoading] = useState(false);
  const [warehouses, setWarehouses] = useState<WarehouseWithFarm[]>([]);
  const [batches, setBatches] = useState<CountBatch[]>([]);
  const [selectedWarehouseId, setSelectedWarehouseId] = useState("");
  const [countItems, setCountItems] = useState<CountItem[]>([]);
  const [notes, setNotes] = useState("");
  const { toast } = useToast();

  useEffect(() => {
    if (open) {
      fetch("/api/warehouses")
        .then((r) => r.json())
        .then((data: WarehouseWithFarm[]) => setWarehouses(data))
        .catch(() => {});
    }
  }, [open]);

  // Clear the previous count when the dialog is (re)opened — state is
  // adjusted during render instead of in an effect
  // (react-hooks/set-state-in-effect).
  const [prevOpen, setPrevOpen] = useState(open);
  if (prevOpen !== open) {
    setPrevOpen(open);
    if (open) {
      setSelectedWarehouseId("");
      setCountItems([]);
      setNotes("");
    }
  }

  useEffect(() => {
    if (selectedWarehouseId) {
      fetch(`/api/inventory`)
        .then((r) => r.json())
        .then((items: InventoryItemWithTotals[]) => {
          const warehouseBatches = items.flatMap((item) =>
            (item.batches || [])
              .filter((b) => b.warehouseId === selectedWarehouseId && b.status === "ACTIVE")
              .map((b) => ({
                ...b,
                itemName: item.name,
                unit: item.unitOfMeasure,
              }))
          );
          setBatches(warehouseBatches);
          // Pre-fill with current system quantities
          setCountItems(
            warehouseBatches.map((b) => ({
              batchId: b.id,
              systemQuantity: b.quantityRemaining,
              countedQuantity: b.quantityRemaining,
              notes: "",
            }))
          );
        })
        .catch(() => {});
    }
  }, [selectedWarehouseId]);

  const updateCountItem = (
    index: number,
    field: keyof CountItem,
    value: string | number
  ) => {
    const newItems: CountItem[] = [...countItems];
    newItems[index] = { ...newItems[index], [field]: value } as CountItem;
    setCountItems(newItems);
  };

  const totalVariance = countItems.reduce(
    (sum, item) => sum + (item.countedQuantity - item.systemQuantity),
    0
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!selectedWarehouseId) {
      toast("Please select a warehouse", "error");
      return;
    }
    if (countItems.length === 0) {
      toast("No batches to count", "error");
      return;
    }

    setLoading(true);
    try {
      const res = await fetch("/api/stock-count", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          warehouseId: selectedWarehouseId,
          notes,
          items: countItems.map((item) => ({
            batchId: item.batchId,
            systemQuantity: item.systemQuantity,
            actualQuantity: item.countedQuantity,
            notes: item.notes,
          })),
        }),
      });

      if (res.ok) {
        toast("Stock count recorded successfully", "success");
        onSuccess();
      } else {
        const err = await res.json();
        toast(err.error || "Failed to record stock count", "error");
      }
    } catch {
      toast("Failed to record stock count", "error");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>New Physical Stock Count</DialogTitle>
          <DialogDescription>
            Record a physical count of inventory in a warehouse
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label>Warehouse *</Label>
            <FormSelect
              value={selectedWarehouseId}
              onChange={(e) => setSelectedWarehouseId(e.target.value)}
              options={warehouses.map((w) => ({
                value: w.id,
                label: `${w.name} (${w.farm?.name || "No farm"})`,
              }))}
              placeholder="Select warehouse to count"
            />
          </div>

          {countItems.length > 0 && (
            <>
              <div className="flex items-center justify-between">
                <Label>Batches to Count ({countItems.length})</Label>
                {totalVariance !== 0 && (
                  <div className={`flex items-center gap-1 text-sm font-medium ${totalVariance < 0 ? "text-red-600" : "text-amber-600"}`}>
                    <AlertTriangle className="h-4 w-4" />
                    Total variance: {totalVariance > 0 ? "+" : ""}{totalVariance}
                  </div>
                )}
              </div>
              <div className="space-y-2">
                {countItems.map((item, index) => {
                  const batch = batches.find((b) => b.id === item.batchId);
                  const variance = item.countedQuantity - item.systemQuantity;
                  return (
                    <div
                      key={item.batchId}
                      className={`rounded-lg border p-3 ${
                        variance !== 0 ? "border-amber-200 bg-amber-50/50" : ""
                      }`}
                    >
                      <div className="flex items-center justify-between mb-2">
                        <div>
                          <p className="text-sm font-medium">{batch?.itemName || "Unknown"}</p>
                          <p className="text-xs text-muted-foreground font-mono">
                            {batch?.batchNumber}
                          </p>
                        </div>
                        <div className="text-right">
                          <p className={`text-sm font-medium ${
                            variance > 0 ? "text-green-600" : variance < 0 ? "text-red-600" : "text-muted-foreground"
                          }`}>
                            Variance: {variance > 0 ? "+" : ""}{variance} {batch?.unit}
                          </p>
                        </div>
                      </div>
                      <div className="grid grid-cols-3 gap-2">
                        <div>
                          <p className="text-xs text-muted-foreground mb-1">System</p>
                          <p className="font-medium text-sm">{item.systemQuantity} {batch?.unit}</p>
                        </div>
                        <div>
                          <p className="text-xs text-muted-foreground mb-1">Counted *</p>
                          <Input
                            type="number"
                            min={0}
                            step={0.01}
                            value={item.countedQuantity}
                            onChange={(e) =>
                              updateCountItem(index, "countedQuantity", parseFloat(e.target.value) || 0)
                            }
                          />
                        </div>
                        <div>
                          <p className="text-xs text-muted-foreground mb-1">Notes</p>
                          <Input
                            placeholder="Optional..."
                            value={item.notes}
                            onChange={(e) => updateCountItem(index, "notes", e.target.value)}
                          />
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}

          <div className="space-y-2">
            <Label>Notes</Label>
            <Textarea
              placeholder="Optional notes about this count..."
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
            />
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={loading}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={loading}>
              {loading && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Submit Count
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
