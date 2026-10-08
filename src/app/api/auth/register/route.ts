import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { validate, createUserSchema } from "@/lib/api-validations";
import { checkRateLimit, rateLimitResponse, getClientIp, writeAuditLog } from "@/lib/api-auth";
import { sendEmail, verificationEmail } from "@/lib/email";
import {
  VERIFICATION_PREFIX,
  generateVerificationCode,
  hashVerificationCode,
  verificationMessage,
} from "@/lib/email-verification";

export async function POST(request: Request) {
  try {
    // Rate limit: 5 registration attempts per IP per 15 minutes
    const ip = getClientIp(request);
    const { allowed, resetAt } = checkRateLimit(`register:${ip}`, 5, 15 * 60 * 1000);
    if (!allowed) {
      return rateLimitResponse(resetAt);
    }

    const body: unknown = await request.json();

    const validation = validate(createUserSchema, body);
    if (!validation.success) {
      return NextResponse.json(
        { error: validation.error, details: validation.details },
        { status: 400 }
      );
    }

    // Mailbox addresses are matched case-insensitively everywhere else in the
    // app (login lowercases before its lookup), so normalise once here too.
    // Without this a mixed-case sign-up would create a row no one can ever
    // sign in to, and the verify form could miss the account it created.
    const email = validation.data.email.toLowerCase().trim();
    const { name, password } = validation.data;

    // Check if email already exists
    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      return NextResponse.json(
        { error: "An account with this email already exists" },
        { status: 409 }
      );
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 12);

    // Create the account dormant: `authorize()` refuses to issue a session for
    // an inactive user, so this flag is what holds the first sign-in back
    // until the mailbox is proven. See src/lib/email-verification.ts.
    const user = await prisma.user.create({
      data: {
        name,
        email,
        password: hashedPassword,
        role: "FIELD_WORKER",
        isActive: false,
      },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
      },
    });

    await writeAuditLog({
      userId: user.id,
      action: "CREATE",
      entity: "User",
      entityId: user.id,
      newValues: { name, email, role: user.role, isActive: false },
      ipAddress: ip,
    });

    // ─── Issue the verification code ─────────────────────
    const code = generateVerificationCode();
    const digest = hashVerificationCode(code, user.id);

    // Only the digest is persisted: a database reader cannot redeem it.
    await prisma.notification.deleteMany({
      where: { userId: user.id, message: { startsWith: VERIFICATION_PREFIX } },
    });
    await prisma.notification.create({
      data: {
        userId: user.id,
        title: "Email Verification",
        message: verificationMessage(digest),
        // Same enum value the password-reset flow abuses, so no migration.
        type: "STOCK_ADJUSTED",
      },
    });

    const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
    const verifyUrl = `${baseUrl}/verify-email?email=${encodeURIComponent(email)}`;
    // The template interpolates this into HTML, so escape it here rather than
    // trusting every caller of the template to remember to.
    const safeName = name
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
        `Verification email could not be sent to ${email}. The code is stored and can be re-sent from /verify-email.`
      );
    }

    // The dev fallback exists because `npm run dev` has no SMTP unless
    // docker-compose MailHog is running. It is compiled out of production:
    // `next start` and the Dockerfile both set NODE_ENV=production, so a
    // live deployment can never echo a code to its own caller.
    const devCode =
      !emailSent && process.env.NODE_ENV !== "production" ? code : undefined;

    return NextResponse.json(
      {
        message: emailSent
          ? "Account created. Check your email for a 6-digit verification code."
          : "Account created, but the verification email could not be sent. Request a new code.",
        requiresVerification: true,
        emailSent,
        ...(devCode ? { devCode } : {}),
        user,
      },
      { status: 201 }
    );
  } catch (error) {
    console.error("Registration error:", error);
    return NextResponse.json({ error: "Failed to create account" }, { status: 500 });
  }
}
