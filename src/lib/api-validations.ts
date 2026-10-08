import { z } from "zod";

// ─── Inventory Item ─────────────────────────────────────────

export const createInventoryItemSchema = z.object({
  name: z.string().min(1, "Name is required").max(200),
  categoryId: z.string().min(1, "Category is required"),
  unitOfMeasure: z.string().min(1, "Unit of measure is required").max(20),
  description: z.string().max(1000).optional(),
  minimumStockLevel: z.number().min(0).default(0),
  maximumStockLevel: z.number().positive().optional(),
  reorderPoint: z.number().positive().optional(),
  reorderQuantity: z.number().positive().optional(),
  defaultSupplierId: z.string().optional(),
  shelfLifeDays: z.number().positive().int().optional(),
  requiresExpiryTracking: z.boolean().default(false),
});

export const updateInventoryItemSchema = createInventoryItemSchema.partial();

// ─── Stock Transaction ──────────────────────────────────────

export const createTransactionSchema = z.object({
  type: z.enum(["RECEIVED", "ISSUED", "TRANSFERRED", "ADJUSTED", "WASTED", "EXPIRED", "RETURNED"]),
  batchId: z.string().min(1, "Batch is required"),
  fromWarehouseId: z.string().optional(),
  toWarehouseId: z.string().optional(),
  quantity: z.number().positive("Quantity must be positive").max(1000000),
  reason: z.string().max(500).optional(),
  referenceNumber: z.string().max(100).optional(),
  farmId: z.string().optional(),
}).refine(
  (data) => {
    if (data.type === "TRANSFERRED") {
      return data.fromWarehouseId && data.toWarehouseId;
    }
    return true;
  },
  { message: "Transfer requires both source and destination warehouses" }
);

// ─── Resource Request ───────────────────────────────────────

export const createRequestSchema = z.object({
  farmId: z.string().min(1, "Farm is required"),
  warehouseId: z.string().optional(),
  itemId: z.string().min(1, "Item is required"),
  quantity: z.number().positive("Quantity must be positive").max(100000),
  unitOfMeasure: z.string().min(1, "Unit is required").max(20),
  purpose: z.string().max(500).optional(),
  priority: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]).default("MEDIUM"),
});

export const updateRequestSchema = z.object({
  status: z.enum(["APPROVED", "REJECTED", "FULFILLED", "CANCELLED"]),
  reviewNote: z.string().max(500).optional(),
  approvedQuantity: z.number().positive().optional(),
});

// ─── Purchase Order ─────────────────────────────────────────

export const createPurchaseOrderSchema = z.object({
  supplierId: z.string().min(1, "Supplier is required"),
  farmId: z.string().min(1, "Farm is required"),
  expectedDeliveryDate: z.string().optional(),
  notes: z.string().max(1000).optional(),
  items: z.array(z.object({
    itemId: z.string().min(1),
    quantity: z.number().positive().max(100000),
    unitPrice: z.number().min(0).max(1000000),
  })).min(1, "At least one item is required").max(50),
});

export const updatePurchaseOrderSchema = z.object({
  status: z.enum(["SUBMITTED", "CONFIRMED", "SHIPPED", "RECEIVED", "CANCELLED"]).optional(),
  notes: z.string().max(1000).optional(),
  actualDeliveryDate: z.string().optional(),
});

// ─── Waste Record ───────────────────────────────────────────

export const createWasteSchema = z.object({
  batchId: z.string().min(1, "Batch is required"),
  farmId: z.string().min(1, "Farm is required"),
  wasteType: z.enum(["EXPIRED", "DAMAGED", "SPOILED", "LOST", "STOLEN"]),
  quantity: z.number().positive("Quantity must be positive").max(100000),
  estimatedValue: z.number().min(0).optional(),
  reason: z.string().max(500).optional(),
});

// ─── Stock Count ────────────────────────────────────────────

export const createStockCountSchema = z.object({
  warehouseId: z.string().min(1, "Warehouse is required"),
  notes: z.string().max(500).optional(),
  items: z.array(z.object({
    batchId: z.string().min(1),
    systemQuantity: z.number().min(0),
    countedQuantity: z.number().min(0),
    notes: z.string().max(200).optional(),
  })).min(1, "At least one item is required").max(100),
});

// ─── Farm ───────────────────────────────────────────────────

export const createFarmSchema = z.object({
  name: z.string().min(1, "Name is required").max(200),
  location: z.string().min(1, "Location is required").max(500),
  description: z.string().max(1000).optional(),
  acreage: z.number().positive().optional(),
});

export const updateFarmSchema = createFarmSchema.partial();

/** PUT /api/farms — full update carries the target farm id in the body. */
export const updateFarmWithIdSchema = updateFarmSchema.extend({
  id: z.string().min(1, "Farm id is required"),
});

// ─── Warehouse ──────────────────────────────────────────────

export const createWarehouseSchema = z.object({
  name: z.string().min(1, "Name is required").max(200),
  // Optional: non-admin creators are scoped to their own farm server-side
  farmId: z.string().min(1, "Farm is required").optional(),
  location: z.string().max(500).optional(),
  type: z.enum(["PHYSICAL", "COLD_STORAGE", "VIRTUAL"]).default("PHYSICAL"),
  capacity: z.number().positive().optional(),
});

export const updateWarehouseSchema = createWarehouseSchema.partial();

// ─── Supplier ───────────────────────────────────────────────

export const createSupplierSchema = z.object({
  name: z.string().min(1, "Name is required").max(200),
  contactPerson: z.string().max(200).optional(),
  phone: z.string().max(30).optional(),
  email: z.string().email().optional().or(z.literal("")),
  address: z.string().max(500).optional(),
  rating: z.number().min(1).max(5).int().optional(),
});

export const updateSupplierSchema = createSupplierSchema.partial();

// ─── Category ───────────────────────────────────────────────

export const createCategorySchema = z.object({
  name: z.string().min(1, "Name is required").max(100),
  description: z.string().max(500).optional(),
  icon: z.string().max(10).optional(),
  color: z.string().max(20).optional(),
});

export const updateCategorySchema = createCategorySchema.partial();

// ─── Season ─────────────────────────────────────────────────

export const createSeasonSchema = z.object({
  name: z.string().min(1, "Name is required").max(200),
  farmId: z.string().min(1, "Farm is required").optional(),
  startDate: z.string().min(1, "Start date is required"),
  endDate: z.string().min(1, "End date is required"),
  cropType: z.string().max(200).optional(),
  status: z.enum(["PLANNING", "ACTIVE", "COMPLETED"]).default("PLANNING"),
});

export const updateSeasonSchema = createSeasonSchema.partial();

// ─── User ───────────────────────────────────────────────────

export const createUserSchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters").max(200),
  email: z.string().email("Invalid email address"),
  password: z
    .string()
    .min(8, "Password must be at least 8 characters")
    .max(128)
    .regex(/[A-Z]/, "Password must contain at least one uppercase letter")
    .regex(/[a-z]/, "Password must contain at least one lowercase letter")
    .regex(/[0-9]/, "Password must contain at least one number"),
  // NOTE: role is intentionally NOT client-settable. Self-registered accounts
  // always start as FIELD_WORKER; promotion requires an existing admin.
});

export const updateUserSchema = z.object({
  name: z.string().min(2).max(200).optional(),
  role: z.enum(["ADMIN", "FARM_MANAGER", "WAREHOUSE_MANAGER", "FIELD_WORKER", "ACCOUNTANT"]).optional(),
  isActive: z.boolean().optional(),
});

// ─── Login ──────────────────────────────────────────────────

export const loginSchema = z.object({
  email: z.string().email("Invalid email address"),
  password: z.string().min(1, "Password is required"),
});

// ─── Auth: email verification & password reset ───────────────

export const verifyEmailSchema = z.object({
  email: z.string().trim().toLowerCase().email("Invalid email address"),
  code: z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code from your email"),
});

export const resendVerificationSchema = z.object({
  email: z.string().trim().toLowerCase().email("Invalid email address"),
});

export const resetPasswordSchema = z.object({
  token: z.string().min(1, "Token is required"),
  password: z
    .string()
    .min(8, "Password must be at least 8 characters")
    .regex(/[A-Z]/, "Password must contain an uppercase letter")
    .regex(/[a-z]/, "Password must contain a lowercase letter")
    .regex(/[0-9]/, "Password must contain a number"),
});

export const forgotPasswordSchema = z.object({
  email: z.string().trim().toLowerCase().email("Invalid email address"),
});

// ─── Batch Lifecycle ────────────────────────────────────────

export const createBatchSchema = z.object({
  itemId: z.string().min(1, "Item is required"),
  batchNumber: z.string().min(1, "Batch number is required").max(100),
  warehouseId: z.string().min(1, "Warehouse is required"),
  supplierId: z.string().optional(),
  quantityReceived: z.number().positive("Quantity must be positive").max(1000000),
  purchasePrice: z.number().min(0).optional(),
  manufactureDate: z.string().optional(),
  expiryDate: z.string().optional(),
  purchaseDate: z.string().optional(),
});

export const splitBatchSchema = z.object({
  batchId: z.string().min(1, "Batch is required"),
  splitQuantity: z.number().positive("splitQuantity must be positive"),
  targetWarehouseId: z.string().optional(),
  newBatchNumber: z.string().max(100).optional(),
  notes: z.string().max(500).optional(),
});

export const transferBatchSchema = z.object({
  batchId: z.string().min(1, "Batch is required"),
  toWarehouseId: z.string().min(1, "Destination warehouse is required"),
  quantity: z.number().positive("Quantity must be positive"),
  notes: z.string().max(500).optional(),
});

// ─── Stock Count Patch ───────────────────────────────────────

export const updateStockCountSchema = z.object({
  status: z.enum(["IN_PROGRESS", "COMPLETED", "RECONCILED"]).optional(),
  notes: z.string().max(500).optional(),
  items: z.array(z.object({
    id: z.string().min(1),
    countedQuantity: z.number().min(0),
    notes: z.string().max(200).optional(),
  })).optional(),
});

// ─── Stock Transaction Patch ────────────────────────────────────────

export const updateTransactionSchema = z.object({
  reason: z.string().max(500).optional(),
  referenceNumber: z.string().max(100).optional(),
  farmId: z.string().min(1).optional(),
});

// ─── Alert Generation Run ───────────────────────────────

export const createAlertRunSchema = z.object({
  daysAhead: z.number().int().min(1).max(365).optional(),
});

// ─── Notification ───────────────────────────────────────

export const updateNotificationSchema = z.object({
  isRead: z.boolean().optional(),
});

// ─── Webhook ──────────────────────────────────────────────

export const createWebhookSchema = z.object({
  url: z.string().min(1, "URL is required"),
  events: z.array(z.string().min(1)).min(1, "At least one event is required"),
});

export const updateWebhookSchema = z.object({
  url: z.string().min(1).optional(),
  events: z.array(z.string().min(1)).min(1).optional(),
  isActive: z.boolean().optional(),
});

// ─── API Key ─────────────────────────────────────────────

export const createApiKeySchema = z.object({
  name: z.string().min(1, "Name is required").max(100),
  permissions: z.array(z.string().min(1)).min(1, "At least one permission is required"),
  farmId: z.string().min(1).optional(),
});

// ─── QR Code ─────────────────────────────────────────────

export const generateQrSchema = z.object({
  batchId: z.string().min(1, "Batch is required"),
});

// ─── Validation Helper ──────────────────────────────────────

export function validate<T>(schema: z.ZodSchema<T>, data: unknown): {
  success: true;
  data: T;
} | {
  success: false;
  error: string;
  details: string[];
} {
  const result = schema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return {
    success: false,
    error: "Validation failed",
    details: result.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`),
  };
}
