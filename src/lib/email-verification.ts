import crypto from "crypto";

/**
 * Email verification for self-registered accounts.
 *
 * A sign-up creates the user with `isActive = false`. The NextAuth
 * `authorize` callback already refuses to issue a session for an inactive
 * user, so that flag is what actually blocks the first sign-in until the
 * owner proves control of the mailbox with a 6-digit code.
 *
 * Why `isActive` and not a second column: every pre-existing row in the
 * database already has `isActive = true`, so turning this on cannot lock out
 * anyone who signed up before the feature existed, and no migration is
 * required. `GET /api/users` does not filter on the flag, so an operator can
 * see a dormant account and switch it on deliberately — an admin vouching
 * for the person, no different from the role changes they already make. What
 * the account holder cannot do is un-dormant their own account, and that is
 * what keeps the invariant this module relies on:
 *
 *   a pending verification token exists  ⇔  the account is awaiting its
 *   first verification, never one that an admin deactivated later.
 *
 * Pure module: no Prisma, no Next.js, no framework imports. Route handlers
 * own storage and delivery; this owns the parts worth unit-testing.
 */

/** Stored as `<PREFIX><hmac>` in `Notification.message`, mirroring reset tokens. */
export const VERIFICATION_PREFIX = "VERIFY_EMAIL:";

/** How long a freshly issued code stays valid. */
export const VERIFICATION_TTL_MS = 15 * 60 * 1000;

/** Codes are this many digits. Six gives 1e6 combinations. */
export const VERIFICATION_CODE_DIGITS = 6;

/** Rate-limit window shared by the verify and resend budgets below. */
export const VERIFICATION_WINDOW_MS = 15 * 60 * 1000;

/**
 * Wrong-code guesses accepted per email per window. With a 1e6 code space,
 * 8 tries per 15 minutes leaves an attacker ~125,000 windows of odds — and
 * every attempt is also counted per-IP in the route.
 */
export const VERIFICATION_MAX_ATTEMPTS = 8;

/** New-code requests accepted per email per window (stops mailbox flooding). */
export const VERIFICATION_MAX_RESENDS = 3;

/**
 * The HMAC key. Reusing `NEXTAUTH_SECRET` means the digest is unreadable to
 * anyone holding only a database dump — a plain SHA-256 of a 6-digit code
 * would be precomputable in milliseconds — and it rotates with the app's
 * existing secret rather than adding another one to manage.
 *
 * Deliberately throws when unset: auth is already non-functional without it,
 * and a silently weak fallback key would turn this into decoration.
 */
function verificationSecret(): string {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) {
    throw new Error(
      "NEXTAUTH_SECRET must be set before email verification codes can be issued."
    );
  }
  return secret;
}

/**
 * A uniform 6-digit code. `crypto.randomInt` is rejection-sampled, so unlike
 * `randomBytes` modulo-reduction there is no modulo bias, and leading zeros
 * survive padding (`"004217"`).
 */
export function generateVerificationCode(): string {
  return crypto
    .randomInt(0, 10 ** VERIFICATION_CODE_DIGITS)
    .toString()
    .padStart(VERIFICATION_CODE_DIGITS, "0");
}

/**
 * Keyed digest of a code for one specific user.
 *
 * Binding the user id stops a digest from being replayed against a different
 * account, and the HMAC key means possession of the row alone is not enough
 * to brute-force the code offline.
 */
export function hashVerificationCode(code: string, userId: string): string {
  return crypto
    .createHmac("sha256", verificationSecret())
    .update(`${userId}:${code}`)
    .digest("hex");
}

/** `true` for a string that is exactly six ASCII digits. */
export function isWellFormedCode(code: unknown): code is string {
  return (
    typeof code === "string" &&
    new RegExp(`^[0-9]{${VERIFICATION_CODE_DIGITS}}$`).test(code)
  );
}

/** `true` once the code is older than {@link VERIFICATION_TTL_MS}. */
export function isVerificationExpired(
  createdAt: Date | string | number,
  now: number = Date.now()
): boolean {
  return now - new Date(createdAt).getTime() > VERIFICATION_TTL_MS;
}

/**
 * Constant-time equality between a submitted code and the stored digest.
 *
 * Length is checked first because `crypto.timingSafeEqual` throws on a length
 * mismatch, and that check reveals only the digest's own length — public
 * information for SHA-256.
 */
export function matchesVerificationCode(
  code: string,
  userId: string,
  storedDigest: string
): boolean {
  const candidate = Buffer.from(hashVerificationCode(code, userId), "hex");
  const stored = Buffer.from(storedDigest, "hex");
  if (candidate.length !== stored.length) return false;
  return crypto.timingSafeEqual(candidate, stored);
}

/** The value persisted in `Notification.message`. */
export function verificationMessage(digest: string): string {
  return `${VERIFICATION_PREFIX}${digest}`;
}

/** Inverse of {@link verificationMessage}; `null` if the row is not a code. */
export function digestFromMessage(message: string): string | null {
  if (!message.startsWith(VERIFICATION_PREFIX)) return null;
  return message.slice(VERIFICATION_PREFIX.length);
}
