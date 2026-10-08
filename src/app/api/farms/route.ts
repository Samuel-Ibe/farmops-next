import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { mutationGuard, requireAuth, resolveFarmScope } from "@/lib/api-auth";
import { validate, createFarmSchema, updateFarmWithIdSchema } from "@/lib/api-validations";

export async function GET(request: Request) {
  try {
    const user = await requireAuth();
    if (user instanceof NextResponse) return user;
    const { searchParams } = new URL(request.url);
    const farmId = resolveFarmScope(user, searchParams.get("farmId"));

    const farms = await prisma.farm.findMany({
      where: {
        isActive: true,
        ...(farmId && { id: farmId }),
      },
      include: {
        warehouses: {
          where: { isActive: true },
          include: {
            _count: { select: { batches: true } },
          },
        },
        _count: {
          select: { warehouses: true, resourceRequests: true },
        },
      },
      orderBy: { name: "asc" },
    });

    return NextResponse.json(farms);
  } catch (error) {
    console.error("Error fetching farms:", error);
    return NextResponse.json(
      { error: "Failed to fetch farms" },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  try {
    // Creating a farm creates a new tenant — admin only
    const guard = await mutationGuard(request, { minRole: "ADMIN" });
    if (guard instanceof NextResponse) return guard;
    const body: unknown = await request.json();
    const validation = validate(createFarmSchema, body);
    if (!validation.success) {
      return NextResponse.json({ error: validation.error, details: validation.details }, { status: 400 });
    }
    const { name, location, description, acreage } = validation.data;

    const farm = await prisma.farm.create({
      data: { name, location, description, acreage },
    });

    return NextResponse.json(farm, { status: 201 });
  } catch (error) {
    console.error("Error creating farm:", error);
    return NextResponse.json(
      { error: "Failed to create farm" },
      { status: 500 }
    );
  }
}

export async function PUT(request: Request) {
  try {
    const guard = await mutationGuard(request, { minRole: "FARM_MANAGER" });
    if (guard instanceof NextResponse) return guard;
    const body: unknown = await request.json();
    const validation = validate(updateFarmWithIdSchema, body);
    if (!validation.success) {
      return NextResponse.json({ error: validation.error, details: validation.details }, { status: 400 });
    }
    const { id, name, location, description, acreage } = validation.data;

    // Non-admins may only edit their own farm
    if (guard.role !== "ADMIN" && (!id || guard.farmId !== id)) {
      return NextResponse.json({ error: "Not authorized to edit this farm" }, { status: 403 });
    }

    const farm = await prisma.farm.update({
      where: { id },
      data: { name, location, description, acreage },
    });

    return NextResponse.json(farm);
  } catch (error) {
    console.error("Error updating farm:", error);
    return NextResponse.json(
      { error: "Failed to update farm" },
      { status: 500 }
    );
  }
}
