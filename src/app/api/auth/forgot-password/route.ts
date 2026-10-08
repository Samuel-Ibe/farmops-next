import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { checkRateLimit, rateLimitResponse, getClientIp } from "@/lib/api-auth";
import crypto from "crypto";
import { sendEmail } from "@/lib/email";
import { validate, forgotPasswordSchema } from "@/lib/api-validations";

// Only the SHA-256 digest of a reset token is ever persisted or logged.
// The raw token exists only in the email we send to the token's owner.
function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export async function POST(request: Request) {
  try {
    const ip = getClientIp(request);
    const { allowed, resetAt } = checkRateLimit(`forgot-pw:${ip}`, 3, 15 * 60 * 1000);
    if (!allowed) {
      return rateLimitResponse(resetAt);
    }

    const body: unknown = await request.json();
    const validation = validate(forgotPasswordSchema, body);
    if (!validation.success) {
      return NextResponse.json({ error: validation.error, details: validation.details }, { status: 400 });
    }
    const { email } = validation.data;

    // Always return success to prevent email enumeration
    const user = await prisma.user.findUnique({
      where: { email },
    });

    if (user) {
      // Generate a secure token
      const token = crypto.randomBytes(32).toString("hex");
      const tokenHash = hashToken(token);

      // Invalidate any outstanding reset tokens for this account
      await prisma.notification.deleteMany({
        where: { userId: user.id, message: { startsWith: "RESET_TOKEN:" } },
      });

      // Store only the digest; a DB reader can't redeem it
      await prisma.notification.create({
        data: {
          userId: user.id,
          title: "Password Reset",
          message: `RESET_TOKEN:${tokenHash}`,
          type: "STOCK_ADJUSTED",
        },
      });

      const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
      await sendEmail({
        to: user.email,
        subject: "Reset your FarmOps password",
        html: `<p>Use the link below to reset your password (valid for 1 hour):</p>
               <p><a href="${baseUrl}/reset-password?token=${token}">${baseUrl}/reset-password?token=${token}</a></p>
               <p>If you didn't request this, you can safely ignore this email.</p>`,
        text: `Reset your password: ${baseUrl}/reset-password?token=${token} (valid 1 hour)`,
      });
    }

    return NextResponse.json({
      message: "If an account exists with that email, you'll receive a reset link shortly.",
    });
  } catch (error) {
    console.error("Forgot password error:", error);
    return NextResponse.json({ error: "Failed to process request" }, { status: 500 });
  }
}
