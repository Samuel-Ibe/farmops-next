"use client";

import { useState } from "react";
import { FormDialog } from "@/components/shared/form-dialog";
import { FormField } from "@/components/ui/form-field";
import { Textarea } from "@/components/ui/textarea";

interface FarmFormValues {
  id?: string;
  name?: string | null;
  location?: string | null;
  acreage?: number | null;
  description?: string | null;
}

interface FarmFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
  initialData?: FarmFormValues | null;
}

function buildFarmForm(initialData?: FarmFormValues | null) {
  return {
    name: initialData?.name || "",
    location: initialData?.location || "",
    acreage: initialData?.acreage?.toString() || "",
    description: initialData?.description || "",
  };
}

export function FarmForm({
  open,
  onOpenChange,
  onSuccess,
  initialData,
}: FarmFormProps) {
  const [form, setForm] = useState(() => buildFarmForm(initialData));

  // Reset the form when the dialog opens or the edit target changes — state
  // is adjusted during render instead of in an effect
  // (react-hooks/set-state-in-effect).
  const [prevProps, setPrevProps] = useState<{
    initialData: FarmFormValues | null | undefined;
    open: boolean;
  } | null>(null);
  if (
    prevProps === null ||
    prevProps.initialData !== initialData ||
    prevProps.open !== open
  ) {
    setPrevProps({ initialData, open });
    setForm(buildFarmForm(initialData));
  }

  const handleSubmit = async () => {
    const url = initialData ? `/api/farms/${initialData.id}` : "/api/farms";
    const method = initialData ? "PATCH" : "POST";

    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...form,
        acreage: form.acreage ? parseFloat(form.acreage) : null,
      }),
    });

    if (!res.ok) {
      const err: { error?: string } = await res.json();
      throw new Error(err.error || "Failed to save farm");
    }

    onSuccess();
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={initialData ? "Edit Farm" : "Add New Farm"}
      description="Configure a farm location"
      onSubmit={handleSubmit}
      submitLabel={initialData ? "Update Farm" : "Add Farm"}
      successMessage={initialData ? "Farm updated" : "Farm created"}
    >
      <div className="grid gap-4">
        <FormField
          label="Farm Name"
          placeholder="e.g. Kumasi Farm"
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          required
        />

        <FormField
          label="Location"
          placeholder="e.g. Kumasi, Ashanti Region"
          value={form.location}
          onChange={(e) => setForm({ ...form, location: e.target.value })}
          required
        />

        <FormField
          label="Acreage"
          type="number"
          placeholder="e.g. 50"
          value={form.acreage}
          onChange={(e) => setForm({ ...form, acreage: e.target.value })}
          description="Farm size in acres"
        />

        <div className="space-y-1.5">
          <label className="text-sm font-medium">Description</label>
          <Textarea
            placeholder="Optional description"
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
          />
        </div>
      </div>
    </FormDialog>
  );
}
