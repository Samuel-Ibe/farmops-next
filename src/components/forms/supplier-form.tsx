"use client";

import { useState } from "react";
import { FormDialog } from "@/components/shared/form-dialog";
import { FormField } from "@/components/ui/form-field";

interface SupplierFormValues {
  id?: string;
  name?: string | null;
  contactPerson?: string | null;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  rating?: number | null;
  notes?: string | null;
}

interface SupplierFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
  initialData?: SupplierFormValues | null;
}

function buildSupplierForm(initialData?: SupplierFormValues | null) {
  return {
    name: initialData?.name || "",
    contactPerson: initialData?.contactPerson || "",
    email: initialData?.email || "",
    phone: initialData?.phone || "",
    address: initialData?.address || "",
    rating: initialData?.rating?.toString() || "",
    notes: initialData?.notes || "",
  };
}

export function SupplierForm({
  open,
  onOpenChange,
  onSuccess,
  initialData,
}: SupplierFormProps) {
  const [form, setForm] = useState(() => buildSupplierForm(initialData));

  // Reset the form when the dialog opens or the edit target changes — state
  // is adjusted during render instead of in an effect
  // (react-hooks/set-state-in-effect).
  const [prevProps, setPrevProps] = useState<{
    initialData: SupplierFormValues | null | undefined;
    open: boolean;
  } | null>(null);
  if (
    prevProps === null ||
    prevProps.initialData !== initialData ||
    prevProps.open !== open
  ) {
    setPrevProps({ initialData, open });
    setForm(buildSupplierForm(initialData));
  }

  const handleSubmit = async () => {
    const url = initialData
      ? `/api/suppliers/${initialData.id}`
      : "/api/suppliers";
    const method = initialData ? "PATCH" : "POST";

    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...form,
        rating: form.rating ? Math.round(parseFloat(form.rating)) : null,
      }),
    });

    if (!res.ok) {
      const err: { error?: string } = await res.json();
      throw new Error(err.error || "Failed to save supplier");
    }

    onSuccess();
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={initialData ? "Edit Supplier" : "Add New Supplier"}
      description="Add supplier contact details"
      onSubmit={handleSubmit}
      submitLabel={initialData ? "Update Supplier" : "Add Supplier"}
      successMessage={initialData ? "Supplier updated" : "Supplier created"}
    >
      <div className="grid gap-4">
        <FormField
          label="Supplier Name"
          placeholder="e.g. AgroChem Ghana Ltd."
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          required
        />

        <FormField
          label="Contact Person"
          placeholder="e.g. John Mensah"
          value={form.contactPerson}
          onChange={(e) =>
            setForm({ ...form, contactPerson: e.target.value })
          }
        />

        <div className="grid grid-cols-2 gap-4">
          <FormField
            label="Email"
            type="email"
            placeholder="info@supplier.com"
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
          />
          <FormField
            label="Phone"
            placeholder="+233 24 000 0000"
            value={form.phone}
            onChange={(e) => setForm({ ...form, phone: e.target.value })}
          />
        </div>

        <FormField
          label="Address"
          placeholder="e.g. Accra, Greater Accra Region"
          value={form.address}
          onChange={(e) => setForm({ ...form, address: e.target.value })}
        />

        <FormField
          label="Rating (1-5)"
          type="number"
          placeholder="e.g. 4.5"
          value={form.rating}
          onChange={(e) => setForm({ ...form, rating: e.target.value })}
          description="Supplier performance rating"
        />

        <FormField
          label="Notes"
          placeholder="Optional notes"
          value={form.notes}
          onChange={(e) => setForm({ ...form, notes: e.target.value })}
        />
      </div>
    </FormDialog>
  );
}
