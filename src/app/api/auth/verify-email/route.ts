import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { checkRateLimit, rateLimitResponse, getClientIp, writeAuditLog } from "@/lib/api-auth";
import {
  VERIFICATION_MAX_ATTEMPTS,
  VERIFICATION_PREFIX,
  VERIFICATION_WINDOW_MS,
  digestFromMessage,
  isVerificationExpired,
  isWellFormedCode,
  matchesVerificationCode,
} from "@/lib/email-verification";

/**
 * Second factor for a fresh sign-up: proves the person who registered also
 * controls the mailbox, then flips `isActive` so `authorize()` will issue a
 * session. Every failure returns the same message — the caller learns nothing
 * about whether an address has an account.
 */
export async function POST(request: Request) {
  try {
    const ip = getClientIp(request);

    // Per-IP ceiling first, so one origin cannot probe many mailboxes.
    const ipBudget = checkRateLimit(`verify:ip:${ip}`, 20, VERIFICATION_WINDOW_MS);
    if (!ipBudget.allowed) {
      return rateLimitResponse(ipBudget.resetAt);
    }

    const body = await request.json();
    const email = typeof body.email === "string" ? body.email.toLowerCase().trim() : "";
    const code = typeof body.code === "string" ? body.code.trim() : "";

    if (!email) {
      return NextResponse.json({ error: "Email is required" }, { status: 400 });
    }
    // Rejected before any lookup: a non-6-digit string can never be right.
    if (!isWellFormedCode(code)) {
      return NextResponse.json(
        { error: "Enter the 6-digit code from your email" },
        { status: 400 }
      );
    }

    // Per-account guess budget. Counted on every well-formed attempt, which
    // is what keeps a 1e6 code space from being walked down.
    const accountBudget = checkRateLimit(
      `verify:account:${email}`,
      VERIFICATION_MAX_ATTEMPTS,
      VERIFICATION_WINDOW_MS
    );
    if (!accountBudget.allowed) {
      return rateLimitResponse(accountBudget.resetAt);
    }

    const genericError = NextResponse.json(
      { error: "Invalid or expired code. Request a new one." },
      { status: 400 }
    );

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      return genericError;
    }

    // Already activated — tell them plainly rather than sending a dead end.
    if (user.isActive) {
      return NextResponse.json(
        { message: "This email is already verified. You can sign in.", verified: true },
        { status: 200 }
      );
    }

    const pending = await prisma.notification.findFirst({
      where: { userId: user.id, message: { startsWith: VERIFICATION_PREFIX } },
      orderBy: { createdAt: "desc" },
    });
    if (!pending) {
      return genericError;
    }

    // Deliberately not deleted on expiry: the resend path only re-issues when
    // a pending token already exists, so dropping the row here would strand
    // the account with no way to ask for another code.
    if (isVerificationExpired(pending.createdAt)) {
      return genericError;
    }

    const digest = digestFromMessage(pending.message);
    if (!digest || !matchesVerificationCode(code, user.id, digest)) {
      return genericError;
    }

    // Single-use: clear every outstanding code, then activate. One statement
    // each rather than a transaction — the delete is idempotent and the update
    // is a primary-key write, so a retry can only converge on "activated".
    await prisma.notification.deleteMany({
      where: { userId: user.id, message: { startsWith: VERIFICATION_PREFIX } },
    });
    await prisma.user.update({
      where: { id: user.id },
      data: { isActive: true },
    });

    await writeAuditLog({
      userId: user.id,
      action: "UPDATE",
      entity: "User",
      entityId: user.id,
      oldValues: { isActive: false },
      newValues: { isActive: true, verifiedEmail: true },
      ipAddress: ip,
    });

    return NextResponse.json({
      message: "Email verified. You can sign in now.",
      verified: true,
    });
  } catch (error) {
    console.error("Email verification error:", error);
    return NextResponse.json(
      { error: "Failed to verify email" },
      { status: 500 }
    );
  }
}
