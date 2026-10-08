import { NextResponse } from "next/server";
import { getWebhook, updateWebhook, unregisterWebhook, getDeliveryLogs } from "@/lib/webhooks";
import { mutationGuard } from "@/lib/api-auth";
import { validate, updateWebhookSchema } from "@/lib/api-validations";

/**
 * GET /api/webhooks/:id
 * Get webhook details and delivery logs
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const webhook = getWebhook(id);
    if (!webhook) {
      return NextResponse.json({ error: "Webhook not found" }, { status: 404 });
    }

    const logs = getDeliveryLogs(id);
    return NextResponse.json({ webhook, logs: logs.slice(-20) });
  } catch {
    return NextResponse.json({ error: "Failed to fetch webhook" }, { status: 500 });
  }
}

/**
 * PATCH /api/webhooks/:id
 * Update webhook (url, events, isActive)
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await mutationGuard(request, { minRole: "ADMIN" });
    if (user instanceof NextResponse) return user;

    const { id } = await params;
    const body: unknown = await request.json();
    const validation = validate(updateWebhookSchema, body);
    if (!validation.success) {
      return NextResponse.json({ error: validation.error, details: validation.details }, { status: 400 });
    }
    const webhook = updateWebhook(id, validation.data);

    if (!webhook) {
      return NextResponse.json({ error: "Webhook not found" }, { status: 404 });
    }

    return NextResponse.json(webhook);
  } catch {
    return NextResponse.json({ error: "Failed to update webhook" }, { status: 500 });
  }
}

/**
 * DELETE /api/webhooks/:id
 * Remove a webhook
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await mutationGuard(request, { minRole: "ADMIN" });
    if (user instanceof NextResponse) return user;

    const { id } = await params;
    const deleted = unregisterWebhook(id);

    if (!deleted) {
      return NextResponse.json({ error: "Webhook not found" }, { status: 404 });
    }

    return NextResponse.json({ message: "Webhook removed" });
  } catch {
    return NextResponse.json({ error: "Failed to delete webhook" }, { status: 500 });
  }
}
