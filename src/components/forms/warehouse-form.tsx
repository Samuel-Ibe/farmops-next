"use client";

import { useState, useEffect } from "react";
import { FormDialog } from "@/components/shared/form-dialog";
import { FormField } from "@/components/ui/form-field";
import { FormSelect } from "@/components/ui/form-select";
import type { Farm } from "@prisma/client";

interface WarehouseFormValues {
  id?: string;
  name?: string | null;
  farmId?: string | null;
  location?: string | null;
  type?: string | null;
  capacity?: number | null;
}

interface WarehouseFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
  initialData?: WarehouseFormValues | null;
}

function buildWarehouseForm(initialData?: WarehouseFormValues | null) {
  return {
    name: initialData?.name || "",
    farmId: initialData?.farmId || "",
    location: initialData?.location || "",
    type: initialData?.type || "PHYSICAL",
    capacity: initialData?.capacity?.toString() || "",
  };
}

export function WarehouseForm({
  open,
  onOpenChange,
  onSuccess,
  initialData,
}: WarehouseFormProps) {
  const [farms, setFarms] = useState<Farm[]>([]);
  const [form, setForm] = useState(() => buildWarehouseForm(initialData));

  useEffect(() => {
    if (open) {
      fetch("/api/farms")
        .then((r) => r.json())
        .then((data: Farm[]) => setFarms(data))
        .catch(() => {});
    }
  }, [open]);

  // Reset the form when the dialog opens or the edit target changes — state
  // is adjusted during render instead of in an effect
  // (react-hooks/set-state-in-effect).
  const [prevProps, setPrevProps] = useState<{
    initialData: WarehouseFormValues | null | undefined;
    open: boolean;
  } | null>(null);
  if (
    prevProps === null ||
    prevProps.initialData !== initialData ||
    prevProps.open !== open
  ) {
    setPrevProps({ initialData, open });
    setForm(buildWarehouseForm(initialData));
  }

  const handleSubmit = async () => {
    const url = initialData
      ? `/api/warehouses/${initialData.id}`
      : "/api/warehouses";
    const method = initialData ? "PATCH" : "POST";

    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...form,
        capacity: form.capacity ? parseInt(form.capacity) : null,
      }),
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || "Failed to save warehouse");
    }

    onSuccess();
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={initialData ? "Edit Warehouse" : "Add New Warehouse"}
      description="Configure a storage location"
      onSubmit={handleSubmit}
      submitLabel={initialData ? "Update Warehouse" : "Add Warehouse"}
      successMessage={initialData ? "Warehouse updated" : "Warehouse created"}
    >
      <div className="grid gap-4">
        <FormField
          label="Warehouse Name"
          placeholder="e.g. Main Warehouse"
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          required
        />

        <FormSelect
          label="Farm"
          value={form.farmId}
          onChange={(e) => setForm({ ...form, farmId: e.target.value })}
          options={farms.map((f) => ({ value: f.id, label: f.name }))}
          placeholder="Select farm"
          required
        />

        <FormField
          label="Location"
          placeholder="e.g. Building A, Kumasi"
          value={form.location}
          onChange={(e) => setForm({ ...form, location: e.target.value })}
        />

        <div className="grid grid-cols-2 gap-4">
          <FormSelect
            label="Warehouse Type"
            value={form.type}
            onChange={(e) => setForm({ ...form, type: e.target.value })}
            options={[
              { value: "PHYSICAL", label: "Physical" },
              { value: "COLD_STORAGE", label: "Cold Storage" },
              { value: "OPEN_YARD", label: "Open Yard" },
              { value: "SILO", label: "Silo" },
            ]}
          />
          <FormField
            label="Capacity (units)"
            type="number"
            placeholder="Optional"
            value={form.capacity}
            onChange={(e) => setForm({ ...form, capacity: e.target.value })}
            description="Maximum storage capacity"
          />
        </div>
      </div>
    </FormDialog>
  );
}
