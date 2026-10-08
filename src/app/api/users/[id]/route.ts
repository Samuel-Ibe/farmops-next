import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireRole, writeAuditLog, getClientIp } from "@/lib/api-auth";
import { validate, updateUserSchema } from "@/lib/api-validations";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    // Only admins can update users
    const admin = await requireRole(["ADMIN"]);
    if (admin instanceof NextResponse) return admin;

    const { id } = await params;
    const body: unknown = await request.json();
    const validation = validate(updateUserSchema, body);
    if (!validation.success) {
      return NextResponse.json({ error: validation.error, details: validation.details }, { status: 400 });
    }
    const data = validation.data;

    // Prevent admins from demoting themselves
    if (id === admin.id && data.role && data.role !== "ADMIN") {
      return NextResponse.json(
        { error: "Admins cannot demote themselves" },
        { status: 400 }
      );
    }

    // Fetch old values for audit log
    const oldUser = await prisma.user.findUnique({ where: { id }, select: { name: true, role: true, isActive: true } });
    if (!oldUser) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const user = await prisma.user.update({
      where: { id },
      data: {
        ...(data.isActive !== undefined && { isActive: data.isActive }),
        ...(data.role && { role: data.role }),
        ...(data.name && { name: data.name }),
      },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        isActive: true,
      },
    });

    await writeAuditLog({
      userId: admin.id,
      action: "UPDATE",
      entity: "User",
      entityId: id,
      oldValues: { name: oldUser.name, role: oldUser.role, isActive: oldUser.isActive },
      newValues: { name: user.name, role: user.role, isActive: user.isActive },
      ipAddress: getClientIp(request),
    });

    return NextResponse.json(user);
  } catch (error) {
    console.error("Error updating user:", error);
    return NextResponse.json({ error: "Failed to update user" }, { status: 500 });
  }
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    // Only admins can update users
    const admin = await requireRole(["ADMIN"]);
    if (admin instanceof NextResponse) return admin;

    const { id } = await params;
    const body: unknown = await request.json();
    const validation = validate(updateUserSchema, body);
    if (!validation.success) {
      return NextResponse.json({ error: validation.error, details: validation.details }, { status: 400 });
    }
    const { name, role } = validation.data;

    // Only admins can change roles
    if (role && admin.role !== "ADMIN") {
      return NextResponse.json(
        { error: "Only administrators can change user roles" },
        { status: 403 }
      );
    }

    const user = await prisma.user.update({
      where: { id },
      data: { name, role },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        isActive: true,
      },
    });

    return NextResponse.json(user);
  } catch (error) {
    console.error("Error updating user:", error);
    return NextResponse.json({ error: "Failed to update user" }, { status: 500 });
  }
}
