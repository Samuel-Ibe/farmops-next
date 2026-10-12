import bcrypt from "bcryptjs";
import { headers } from "next/headers";
import { prisma } from "@/lib/prisma";
import {
  checkRateLimit,
  clearLoginFailures,
  isLoginThrottled,
  parseForwardedIp,
  recordLoginFailure,
} from "@/lib/rate-limit";

/**
 * Credentials-provider authorization, extracted from the NextAuth config so
 * the brute-force throttling can be unit-tested directly (importing
 * src/lib/auth would initialize NextAuth itself).
 */
export interface CredentialsUser {
  id: string;
  name: string | null;
  email: string;
  role: string;
  farmId: string | null;
}

/** Best-effort client IP for login throttling (never trusted for authz). */
async function requestIp(): Promise<string> {
  try {
    const h = await headers();
    return parseForwardedIp(h.get("x-forwarded-for"), h.get("x-real-ip"));
  } catch {
    return "unknown";
  }
}

export async function authorizeWithCredentials(
  credentials: Record<string, unknown> | undefined
): Promise<CredentialsUser | null> {
  // Extract email and password directly — Zod schema can be strict with extra fields
  const email = credentials?.email as string | undefined;
  const password = credentials?.password as string | undefined;

  if (!email || !password || typeof email !== "string" || typeof password !== "string") {
    return null;
  }

  const ip = await requestIp();
  const normalizedEmail = email.toLowerCase().trim();
  // Failure counters are keyed by IP + account: an attacker cannot
  // exhaust a victim's allowance from another network (no lockout DoS),
  // while brute force from one origin is slowed to 5 attempts / 15 min.
  const failKey = `${ip}:${normalizedEmail}`;

  // Per-IP attempt budget (all attempts, generous: 30/min)
  const ipBudget = checkRateLimit(`login:ip:${ip}`, 30, 60_000);
  if (!ipBudget.allowed || isLoginThrottled(failKey)) {
    // Deliberately indistinguishable from bad credentials
    return null;
  }

  // Reserve this attempt's slot SYNCHRONOUSLY — there is no await between the
  // throttle check above and this recording, so a parallel burst of requests
  // cannot all pass the check while credential verification is still in
  // flight (the check-then-record race previously let one burst run up to
  // the full per-IP budget of bcrypt comparisons instead of 5). A successful
  // login clears the slot below, so honest users still get their full
  // allowance.
  recordLoginFailure(failKey);

  const user = await prisma.user.findUnique({
    where: { email: normalizedEmail },
  });

  // Deliberately non-specific: never reveal whether an account exists.
  // `isActive` also covers an account still awaiting email verification
  // — registration creates it with the flag off, so a fresh sign-up
  // cannot obtain a session until it has proven the mailbox. See
  // src/lib/email-verification.ts.
  if (!user || !user.isActive) {
    return null;
  }

  const isValid = await bcrypt.compare(password, user.password);
  if (!isValid) {
    return null;
  }

  clearLoginFailures(failKey);

  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    farmId: user.farmId || null,
  };
}
