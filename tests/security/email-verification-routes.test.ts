// @vitest-environment node
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

import { POST as verifyEmail } from "@/app/api/auth/verify-email/route";
import { POST as resendVerification } from "@/app/api/auth/resend-verification/route";
import { prisma } from "@/lib/prisma";
import { sendEmail, verificationEmail } from "@/lib/email";
import * as apiAuth from "@/lib/api-auth";
import {
  VERIFICATION_MAX_ATTEMPTS,
  hashVerificationCode,
  verificationMessage,
} from "@/lib/email-verification";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { findUnique: vi.fn(), update: vi.fn() },
    notification: { findFirst: vi.fn(), create: vi.fn(), deleteMany: vi.fn() },
  },
}));

vi.mock("@/lib/email", () => ({
  sendEmail: vi.fn(async () => true),
  verificationEmail: vi.fn(() => ({
    subject: "Verify your FarmOps email",
    html: "<p>code</p>",
    text: "code",
  })),
}));

vi.mock("@/lib/api-auth", () => {
  const counts = new Map<string, number>();
  return {
    __reset: () => counts.clear(),
    checkRateLimit: (key: string, max: number) => {
      const n = (counts.get(key) ?? 0) + 1;
      counts.set(key, n);
      return { allowed: n <= max, remaining: 0, resetAt: Date.now() + 60_000 };
    },
    rateLimitResponse: () =>
      new Response(JSON.stringify({ error: "Rate limit exceeded." }), {
        status: 429,
        headers: { "content-type": "application/json" },
      }),
    getClientIp: () => "203.0.113.7",
    writeAuditLog: vi.fn(async () => undefined),
  };
});

type MockFn = ReturnType<typeof vi.fn>;

const db = prisma as unknown as {
  user: { findUnique: MockFn; update: MockFn };
  notification: { findFirst: MockFn; create: MockFn; deleteMany: MockFn };
};
const apiAuthMock = apiAuth as unknown as { __reset: () => void };

const ROUTE_SECRET = "route-test-secret";
const ORIGINAL_SECRET = process.env.NEXTAUTH_SECRET;
const EMAIL = "ana@farmops.com";

function post(
  handler: (request: Request) => Promise<Response>,
  body: Record<string, unknown>
): Promise<Response> {
  return handler(
    new Request("http://localhost/api/auth/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

/** Give the mocked user a live pending code, as register/resend would leave it. */
function seedPendingCode(code: string, issuedAt = new Date()) {
  db.notification.findFirst.mockResolvedValue({
    id: "notif_1",
    userId: "user_1",
    message: verificationMessage(hashVerificationCode(code, "user_1")),
    createdAt: issuedAt,
  });
}

beforeEach(() => {
  process.env.NEXTAUTH_SECRET = ROUTE_SECRET;
  apiAuthMock.__reset();

  db.user.findUnique.mockReset();
  db.user.update.mockReset();
  db.user.update.mockResolvedValue({});
  db.notification.findFirst.mockReset();
  db.notification.create.mockReset();
  db.notification.create.mockResolvedValue({});
  db.notification.deleteMany.mockReset();
  db.notification.deleteMany.mockResolvedValue({ count: 0 });

  vi.mocked(sendEmail).mockReset();
  vi.mocked(sendEmail).mockResolvedValue(true);
  vi.mocked(verificationEmail).mockClear();
});

afterAll(() => {
  if (ORIGINAL_SECRET === undefined) delete process.env.NEXTAUTH_SECRET;
  else process.env.NEXTAUTH_SECRET = ORIGINAL_SECRET;
});

describe("POST /api/auth/verify-email", () => {
  beforeEach(() => {
    db.user.findUnique.mockResolvedValue({
      id: "user_1",
      name: "Ana",
      email: EMAIL,
      isActive: false,
    });
  });

  it("activates the account on the right code", async () => {
    seedPendingCode("123456");

    const res = await post(verifyEmail, { email: EMAIL, code: "123456" });

    expect(res.status).toBe(200);
    expect(db.user.update).toHaveBeenCalledWith({
      where: { id: "user_1" },
      data: { isActive: true },
    });
    // Single-use: the outstanding code is cleared alongside activation.
    expect(db.notification.deleteMany).toHaveBeenCalledTimes(1);
  });

  it("leaves the account dormant on a wrong code", async () => {
    seedPendingCode("123456");

    const res = await post(verifyEmail, { email: EMAIL, code: "654321" });

    expect(res.status).toBe(400);
    expect(db.user.update).not.toHaveBeenCalled();
    expect(db.notification.deleteMany).not.toHaveBeenCalled();
  });

  it("keeps the stored row when a code has expired, so a resend can still find it", async () => {
    const stale = new Date(Date.now() - 16 * 60 * 1000);
    seedPendingCode("123456", stale);

    const res = await post(verifyEmail, { email: EMAIL, code: "123456" });

    expect(res.status).toBe(400);
    // Deleting here would strand the account with nothing to refresh.
    expect(db.notification.deleteMany).not.toHaveBeenCalled();
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it("rejects a malformed code before any lookup", async () => {
    const res = await post(verifyEmail, { email: EMAIL, code: "12ab56" });

    expect(res.status).toBe(400);
    expect(db.user.findUnique).not.toHaveBeenCalled();
  });

  it("answers plainly when the address is already verified", async () => {
    db.user.findUnique.mockResolvedValue({
      id: "user_1",
      name: "Ana",
      email: EMAIL,
      isActive: true,
    });

    const res = await post(verifyEmail, { email: EMAIL, code: "123456" });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ verified: true });
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it("does not distinguish an unknown address from a bad code", async () => {
    db.user.findUnique.mockResolvedValue(null);
    const unknown = await post(verifyEmail, { email: EMAIL, code: "123456" });
    expect(unknown.status).toBe(400);
    const unknownBody = await unknown.json();
    expect(unknownBody).toMatchObject({ error: expect.any(String) });

    db.user.findUnique.mockResolvedValue({
      id: "user_1",
      name: "Ana",
      email: EMAIL,
      isActive: false,
    });
    seedPendingCode("123456");
    const wrong = await post(verifyEmail, { email: EMAIL, code: "000000" });
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toEqual(unknownBody);
  });

  it("stops taking guesses once the per-account budget is spent", async () => {
    seedPendingCode("123456");

    for (let i = 0; i < VERIFICATION_MAX_ATTEMPTS; i++) {
      const res = await post(verifyEmail, { email: EMAIL, code: "000000" });
      expect(res.status).toBe(400);
    }

    const blocked = await post(verifyEmail, { email: EMAIL, code: "123456" });
    expect(blocked.status).toBe(429);
    expect(db.user.update).not.toHaveBeenCalled();
  });
});

describe("POST /api/auth/resend-verification", () => {
  it("re-issues a code for an account still awaiting its first verification", async () => {
    db.user.findUnique.mockResolvedValue({
      id: "user_1",
      name: "Ana",
      email: EMAIL,
      isActive: false,
    });
    db.notification.findFirst.mockResolvedValue({
      id: "notif_1",
      userId: "user_1",
      message: verificationMessage(hashVerificationCode("111111", "user_1")),
      createdAt: new Date(),
    });

    const res = await post(resendVerification, { email: EMAIL });

    expect(res.status).toBe(200);
    expect(db.notification.deleteMany).toHaveBeenCalledTimes(1);
    expect(db.notification.create).toHaveBeenCalledTimes(1);
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it("the code it emails is the code that verifies", async () => {
    db.user.findUnique.mockResolvedValue({
      id: "user_1",
      name: "Ana",
      email: EMAIL,
      isActive: false,
    });
    db.notification.findFirst.mockResolvedValue({
      id: "notif_1",
      userId: "user_1",
      message: verificationMessage(hashVerificationCode("111111", "user_1")),
      createdAt: new Date(),
    });

    await post(resendVerification, { email: EMAIL });
    const [name, code] = vi.mocked(verificationEmail).mock.calls[0];
    expect(name).toBe("Ana");
    expect(code).toMatch(/^[0-9]{6}$/);

    seedPendingCode(code);
    const res = await post(verifyEmail, { email: EMAIL, code });

    expect(res.status).toBe(200);
    expect(db.user.update).toHaveBeenCalledWith({
      where: { id: "user_1" },
      data: { isActive: true },
    });
  });

  it("will not re-issue to an account an administrator deactivated", async () => {
    // The account holds no pending token, because verification already
    // deleted every one. Refreshing here would hand a deactivated user a
    // working code and a way back in.
    db.user.findUnique.mockResolvedValue({
      id: "user_1",
      name: "Ana",
      email: EMAIL,
      isActive: false,
    });
    db.notification.findFirst.mockResolvedValue(null);

    const res = await post(resendVerification, { email: EMAIL });

    expect(res.status).toBe(200);
    expect(db.notification.create).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("will not re-issue to a verified account even if a stray token exists", async () => {
    db.user.findUnique.mockResolvedValue({
      id: "user_1",
      name: "Ana",
      email: EMAIL,
      isActive: true,
    });
    db.notification.findFirst.mockResolvedValue({
      id: "notif_1",
      userId: "user_1",
      message: verificationMessage(hashVerificationCode("111111", "user_1")),
      createdAt: new Date(),
    });

    const res = await post(resendVerification, { email: EMAIL });

    expect(res.status).toBe(200);
    expect(db.notification.create).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("says the same thing for an address with no account", async () => {
    db.user.findUnique.mockResolvedValue(null);

    const res = await post(resendVerification, { email: EMAIL });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ message: expect.any(String) });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("rejects an empty address", async () => {
    const res = await post(resendVerification, { email: "  " });

    expect(res.status).toBe(400);
    expect(db.user.findUnique).not.toHaveBeenCalled();
  });
});
