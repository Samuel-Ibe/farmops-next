import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { checkRateLimit, rateLimitResponse, getClientIp } from "@/lib/api-auth";
import { sendEmail, verificationEmail } from "@/lib/email";
import {
  VERIFICATION_MAX_RESENDS,
  VERIFICATION_PREFIX,
  VERIFICATION_WINDOW_MS,
  generateVerificationCode,
  hashVerificationCode,
  verificationMessage,
} from "@/lib/email-verification";
import { validate, resendVerificationSchema } from "@/lib/api-validations";

/** Identical wording whether or not anything was sent — no enumeration oracle. */
const GENERIC_MESSAGE =
  "If that address is awaiting verification, a new code is on its way.";

/**
 * Re-issues the code for an account that is still waiting on its first
 * verification.
 *
 * It only ever re-issues when a pending token already exists. That is what
 * keeps this from becoming a way back in for a user an administrator
 * deactivated: deactivation clears nothing, but verification already deleted
 * every token, so a previously-verified account has no token to refresh and
 * stays locked out.
 */
export async function POST(request: Request) {
  try {
    const ip = getClientIp(request);
    const ipBudget = checkRateLimit(`resend:ip:${ip}`, 6, VERIFICATION_WINDOW_MS);
    if (!ipBudget.allowed) {
      return rateLimitResponse(ipBudget.resetAt);
    }

    const body: unknown = await request.json();
    const validation = validate(resendVerificationSchema, body);
    if (!validation.success) {
      return NextResponse.json({ error: validation.error, details: validation.details }, { status: 400 });
    }
    const { email } = validation.data;

    // Per-mailbox budget: an unverified account must not become a mail cannon.
    const mailboxBudget = checkRateLimit(
      `resend:account:${email}`,
      VERIFICATION_MAX_RESENDS,
      VERIFICATION_WINDOW_MS
    );
    if (!mailboxBudget.allowed) {
      return rateLimitResponse(mailboxBudget.resetAt);
    }

    const user = await prisma.user.findUnique({ where: { email } });
    const pending = user
      ? await prisma.notification.findFirst({
          where: { userId: user.id, message: { startsWith: VERIFICATION_PREFIX } },
          orderBy: { createdAt: "desc" },
        })
      : null;

    if (!user || user.isActive || !pending) {
      return NextResponse.json({ message: GENERIC_MESSAGE }, { status: 200 });
    }

    const code = generateVerificationCode();
    const digest = hashVerificationCode(code, user.id);

    // Replace rather than accumulate: exactly one live code per account.
    await prisma.notification.deleteMany({
      where: { userId: user.id, message: { startsWith: VERIFICATION_PREFIX } },
    });
    await prisma.notification.create({
      data: {
        userId: user.id,
        title: "Email Verification",
        message: verificationMessage(digest),
        type: "STOCK_ADJUSTED",
      },
    });

    const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
    const verifyUrl = `${baseUrl}/verify-email?email=${encodeURIComponent(email)}`;
    const safeName = user.name
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

    const emailSent = await sendEmail({
      to: email,
      ...verificationEmail(safeName, code, verifyUrl),
    });

    if (!emailSent) {
      console.error(
        `Verification email could not be re-sent to ${email}. The new code is stored and valid for 15 minutes.`
      );
    }

    // Dev-only escape hatch for the same reason as in the register route:
    // `next dev` has no SMTP unless docker-compose MailHog is up, and
    // NODE_ENV=production compiles it out of any real deployment.
    const devCode =
      !emailSent && process.env.NODE_ENV !== "production" ? code : undefined;

    return NextResponse.json(
      {
        message: GENERIC_MESSAGE,
        emailSent,
        ...(devCode ? { devCode } : {}),
      },
      { status: 200 }
    );
  } catch (error) {
    console.error("Resend verification error:", error);
    return NextResponse.json(
      { error: "Failed to resend verification code" },
      { status: 500 }
    );
  }
}
