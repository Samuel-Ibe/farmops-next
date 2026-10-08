import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { checkRateLimit, rateLimitResponse, getClientIp } from "@/lib/api-auth";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { validate, resetPasswordSchema } from "@/lib/api-validations";

// Matches how the token is stored by /api/auth/forgot-password
function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export async function POST(request: Request) {
  try {
    const ip = getClientIp(request);
    const { allowed, resetAt } = checkRateLimit(`reset-pw:${ip}`, 5, 15 * 60 * 1000);
    if (!allowed) {
      return rateLimitResponse(resetAt);
    }

    // Strength rules live in resetPasswordSchema — same messages, one pass.
    const body: unknown = await request.json();
    const validation = validate(resetPasswordSchema, body);
    if (!validation.success) {
      return NextResponse.json({ error: validation.error, details: validation.details }, { status: 400 });
    }
    const { token, password } = validation.data;

    // Find the notification storing the digest of this token
    const notification = await prisma.notification.findFirst({
      where: {
        type: "STOCK_ADJUSTED",
        message: `RESET_TOKEN:${hashToken(token)}`,
      },
      orderBy: { createdAt: "desc" },
    });

    if (!notification) {
      return NextResponse.json({ error: "Invalid or expired reset token" }, { status: 400 });
    }

    // Check if token is expired (1 hour)
    const tokenAge = Date.now() - new Date(notification.createdAt).getTime();
    if (tokenAge > 60 * 60 * 1000) {
      return NextResponse.json({ error: "Reset token has expired. Please request a new one." }, { status: 400 });
    }

    // Hash new password and update user
    const hashedPassword = await bcrypt.hash(password, 12);

    await prisma.user.update({
      where: { id: notification.userId },
      data: { password: hashedPassword },
    });

    // Single-use: drop every outstanding reset token for this account
    await prisma.notification.deleteMany({
      where: { userId: notification.userId, message: { startsWith: "RESET_TOKEN:" } },
    });

    return NextResponse.json({ message: "Password reset successful" });
  } catch (error) {
    console.error("Reset password error:", error);
    return NextResponse.json({ error: "Failed to reset password" }, { status: 500 });
  }
}
