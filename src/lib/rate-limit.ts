/**
 * Fixed-window rate limiting and login-failure throttling.
 *
 * Pure in-memory implementation with no framework imports so it can be used
 * from both route guards and the NextAuth authorize callback (importing the
 * route-guard module there would create an import cycle), and unit-tested in
 * isolation. State survives only for the lifetime of a single process —
 * before horizontal scaling, move to shared infrastructure (see
 * docs/SECURITY_AUDIT.md SEC-18).
 */

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

const rateLimitStore = new Map<string, { count: number; resetAt: number }>();

// ─── Expiry sweep ──────────────────────────────────────────────────────
// Entries expire logically (fixed window) but a Map never evicts on its
// own: a key that is written once and never touched again would live
// forever. An attacker rotating source IPs — trivially, by rotating the
// spoofable X-Forwarded-For header — could otherwise grow these stores
// without bound and exhaust memory. Both stores are therefore swept
// opportunistically on every write path at most once per interval; the
// cost is one O(n) pass per minute regardless of request rate.

const SWEEP_INTERVAL_MS = 60_000;
let lastSweepAt = 0;

function maybeSweep(now: number): void {
  if (now - lastSweepAt < SWEEP_INTERVAL_MS) return;
  lastSweepAt = now;
  for (const [key, rec] of rateLimitStore) {
    if (now > rec.resetAt) rateLimitStore.delete(key);
  }
  for (const key of Array.from(loginFailures.keys())) {
    const kept = (loginFailures.get(key) ?? []).filter(
      (t) => now - t < LOGIN_FAILURE_WINDOW_MS
    );
    if (kept.length === 0) loginFailures.delete(key);
    else loginFailures.set(key, kept);
  }
}

export function checkRateLimit(
  key: string,
  maxRequests: number = 60,
  windowMs: number = 60000
): RateLimitResult {
  const now = Date.now();
  maybeSweep(now);
  const record = rateLimitStore.get(key);

  if (!record || now > record.resetAt) {
    rateLimitStore.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: maxRequests - 1, resetAt: now + windowMs };
  }

  if (record.count >= maxRequests) {
    return { allowed: false, remaining: 0, resetAt: record.resetAt };
  }

  record.count++;
  return { allowed: true, remaining: maxRequests - record.count, resetAt: record.resetAt };
}

export function resetRateLimits(): void {
  rateLimitStore.clear();
  lastSweepAt = 0;
}

/**
 * Current size of both stores. Test-only observability: the eviction tests
 * assert that expired keys actually leave memory, which the public API
 * alone cannot show.
 */
export function rateLimitStoreSizes(): { windows: number; logins: number } {
  return { windows: rateLimitStore.size, logins: loginFailures.size };
}

// ─── Client IP resolution ──────────────────────────────────────────────
//
// Deployment assumes ONE trusted reverse proxy in front (docs/deployment.md):
// it appends the real peer address to any incoming X-Forwarded-For. That
// makes the RIGHTMOST entry the only trustworthy one — entries to its left
// are client-supplied, so keying rate limits off the leftmost hop would let
// an attacker pick any budget key at will: rotate it to evade limits, or
// replay a victim's IP to exhaust their budget (login/register DoS).
// Pure function so the route guard and the NextAuth authorize callback
// share exactly one implementation and it can be unit-tested directly.

export function parseForwardedIp(
  forwardedFor: string | null | undefined,
  realIp: string | null | undefined
): string {
  if (forwardedFor) {
    const hops = forwardedFor.split(",");
    const rightmost = hops[hops.length - 1].trim();
    if (rightmost) return rightmost;
  }
  const fallback = realIp?.trim();
  if (fallback) return fallback;
  return "unknown";
}

// ─── Login Throttling ──────────────────────────────────────
//
// Counts *failed* login attempts only, keyed by client-IP + account so an
// attacker cannot lock a victim out of their own account from elsewhere
// (no easy account-lockout DoS). Successful logins clear the counter.

const LOGIN_FAILURE_LIMIT = 5;
const LOGIN_FAILURE_WINDOW_MS = 15 * 60 * 1000;

const loginFailures = new Map<string, number[]>(); // key -> failed-attempt timestamps

function pruneFailures(key: string, now: number): number[] {
  const attempts = (loginFailures.get(key) || []).filter(
    (t) => now - t < LOGIN_FAILURE_WINDOW_MS
  );
  if (attempts.length === 0) loginFailures.delete(key);
  else loginFailures.set(key, attempts);
  return attempts;
}

/**
 * Returns true when this login attempt must be rejected before doing any
 * credential work (too many recent failures for this IP+account pair).
 */
export function isLoginThrottled(key: string): boolean {
  const attempts = pruneFailures(key, Date.now());
  return attempts.length >= LOGIN_FAILURE_LIMIT;
}

/** Records a failed credential check. Returns true if the key is now throttled. */
export function recordLoginFailure(key: string): boolean {
  const now = Date.now();
  maybeSweep(now);
  const attempts = pruneFailures(key, now);
  attempts.push(now);
  loginFailures.set(key, attempts);
  return attempts.length >= LOGIN_FAILURE_LIMIT;
}

/** Clears failures for a key — called after a successful login. */
export function clearLoginFailures(key: string): void {
  loginFailures.delete(key);
}

export function resetLoginFailures(): void {
  loginFailures.clear();
}
