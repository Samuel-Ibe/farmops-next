"use client";

import { useState, useEffect } from "react";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FormSelect } from "@/components/ui/form-select";
import { useToast } from "@/components/ui/toast";
import { Loader2 } from "lucide-react";
import type { Farm } from "@prisma/client";

interface SeasonFormValues {
  id?: string;
  name?: string | null;
  farmId?: string | null;
  startDate?: Date | string | null;
  endDate?: Date | string | null;
  cropType?: string | null;
  status?: string | null;
}

interface SeasonFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialData?: SeasonFormValues | null;
  onSuccess: () => void;
}

function buildSeasonForm(initialData?: SeasonFormValues | null) {
  return {
    name: initialData?.name || "",
    farmId: initialData?.farmId || "",
    startDate: initialData?.startDate
      ? new Date(initialData.startDate).toISOString().split("T")[0]
      : "",
    endDate: initialData?.endDate
      ? new Date(initialData.endDate).toISOString().split("T")[0]
      : "",
    cropType: initialData?.cropType || "",
    status: initialData?.status || "PLANNING",
  };
}

export function SeasonForm({ open, onOpenChange, initialData, onSuccess }: SeasonFormProps) {
  const [loading, setLoading] = useState(false);
  const [farms, setFarms] = useState<Farm[]>([]);
  const { toast } = useToast();

  const [form, setForm] = useState(() => buildSeasonForm(initialData));

  useEffect(() => {
    if (open) {
      fetch("/api/farms").then((r) => r.json()).then((data: Farm[]) => setFarms(data)).catch(() => {});
    }
  }, [open]);

  // Reset the form when the dialog opens or the edit target changes — state
  // is adjusted during render instead of in an effect
  // (react-hooks/set-state-in-effect).
  const [prevProps, setPrevProps] = useState<{
    initialData: SeasonFormValues | null | undefined;
    open: boolean;
  } | null>(null);
  if (
    prevProps === null ||
    prevProps.initialData !== initialData ||
    prevProps.open !== open
  ) {
    setPrevProps({ initialData, open });
    setForm(buildSeasonForm(initialData));
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name || !form.farmId || !form.startDate || !form.endDate) {
      toast("Please fill in all required fields", "error");
      return;
    }

    setLoading(true);
    try {
      const url = initialData ? `/api/seasons/${initialData.id}` : "/api/seasons";
      const method = initialData ? "PUT" : "POST";
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });

      if (res.ok) {
        toast(initialData ? "Season updated" : "Season created", "success");
        onSuccess();
      } else {
        const err = await res.json();
        toast(err.error || "Failed to save season", "error");
      }
    } catch {
      toast("Failed to save season", "error");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{initialData ? "Edit Season" : "New Season"}</DialogTitle>
          <DialogDescription>
            {initialData ? "Update season details" : "Create a new farming season"}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label>Season Name *</Label>
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g., Major Season 2026" />
          </div>
          <div className="space-y-2">
            <Label>Farm *</Label>
            <FormSelect
              value={form.farmId}
              onChange={(e) => setForm({ ...form, farmId: e.target.value })}
              options={farms.map((f) => ({ value: f.id, label: f.name }))}
              placeholder="Select farm"
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>Start Date *</Label>
              <Input type="date" value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label>End Date *</Label>
              <Input type="date" value={form.endDate} onChange={(e) => setForm({ ...form, endDate: e.target.value })} />
            </div>
          </div>
          <div className="space-y-2">
            <Label>Crop Type</Label>
            <Input value={form.cropType} onChange={(e) => setForm({ ...form, cropType: e.target.value })} placeholder="e.g., Maize & Cassava" />
          </div>
          <div className="space-y-2">
            <Label>Status</Label>
            <FormSelect
              value={form.status}
              onChange={(e) => setForm({ ...form, status: e.target.value })}
              options={[
                { value: "PLANNING", label: "Planning" },
                { value: "ACTIVE", label: "Active" },
                { value: "COMPLETED", label: "Completed" },
              ]}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>Cancel</Button>
            <Button type="submit" disabled={loading}>
              {loading && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {initialData ? "Update" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
