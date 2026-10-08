import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";

interface AuditLogParams {
  userId?: string;
  action: "CREATE" | "UPDATE" | "DELETE" | "LOGIN" | "LOGOUT";
  entity: string;
  entityId?: string;
  oldValues?: Prisma.InputJsonObject;
  newValues?: Prisma.InputJsonObject;
  ipAddress?: string;
  userAgent?: string;
}

export async function logAudit({
  userId,
  action,
  entity,
  entityId,
  oldValues,
  newValues,
  ipAddress,
  userAgent,
}: AuditLogParams) {
  return prisma.auditLog.create({
    data: {
      userId,
      action,
      entity,
      entityId,
      oldValues: oldValues || undefined,
      newValues: newValues || undefined,
      ipAddress,
      userAgent,
    },
  });
}

export async function logCreate(
  userId: string,
  entity: string,
  entityId: string,
  newValues: Prisma.InputJsonObject
) {
  return logAudit({
    userId,
    action: "CREATE",
    entity,
    entityId,
    newValues,
  });
}

export async function logUpdate(
  userId: string,
  entity: string,
  entityId: string,
  oldValues: Prisma.InputJsonObject,
  newValues: Prisma.InputJsonObject
) {
  return logAudit({
    userId,
    action: "UPDATE",
    entity,
    entityId,
    oldValues,
    newValues,
  });
}

export async function logDelete(
  userId: string,
  entity: string,
  entityId: string,
  oldValues: Prisma.InputJsonObject
) {
  return logAudit({
    userId,
    action: "DELETE",
    entity,
    entityId,
    oldValues,
  });
}
