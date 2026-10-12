// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: { user: { findUnique: vi.fn() } } }));
vi.mock("bcryptjs", () => ({ default: { compare: vi.fn() } }));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({
    get: (key: string) =>
      key === "x-forwarded-for" ? "198.18.77.1, 10.44.55.66" : null,
  })),
}));

import { authorizeWithCredentials } from "@/lib/credentials";
import { prisma } from "@/lib/prisma";
import bcrypt from "bcryptjs";
import {
  isLoginThrottled,
  resetLoginFailures,
  resetRateLimits,
} from "@/lib/rate-limit";

type MockFn = ReturnType<typeof vi.fn>;
const db = prisma as unknown as { user: { findUnique: MockFn } };
const bcryptMock = bcrypt as unknown as { compare: MockFn };

const CREDS = { email: "Victim@Farm.COM", password: "wrong-password" };
const USER = {
  id: "u1",
  name: "Victim",
  email: "victim@farm.com",
  password: "$2b$10$fake",
  role: "FIELD_WORKER",
  avatar: null,
  isActive: true,
  farmId: null,
};

// The mock X-Forwarded-For has a spoofable client entry left of the
// proxy-added hop; the throttle must key off the RIGHTMOST one.
const RIGHT_HOP = "10.44.55.66";
const SPOOFED_HOP = "198.18.77.1";

describe("Login throttle under parallel load (TOCTOU regression)", () => {
  beforeEach(() => {
    resetRateLimits();
    resetLoginFailures();
    db.user.findUnique.mockReset();
    bcryptMock.compare.mockReset();
    db.user.findUnique.mockResolvedValue(USER);
    bcryptMock.compare.mockResolvedValue(false);
  });

  it("a parallel burst gets at most 5 credential checks, not one per request", async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, () => authorizeWithCredentials(CREDS))
    );

    // All ten are rejected as bad credentials (throttled is indistinguishable)
    expect(results.every((r) => r === null)).toBe(true);
    // …but only the first five did any credential work. Before the fix all
    // ten passed the check-then-record gap and reached bcrypt.
    expect(bcryptMock.compare).toHaveBeenCalledTimes(5);
    expect(db.user.findUnique).toHaveBeenCalledTimes(5);
  });

  it("keys the throttle off the rightmost X-Forwarded-For hop", async () => {
    await Promise.all(
      Array.from({ length: 6 }, () => authorizeWithCredentials(CREDS))
    );
    expect(isLoginThrottled(`${RIGHT_HOP}:victim@farm.com`)).toBe(true);
    expect(isLoginThrottled(`${SPOOFED_HOP}:victim@farm.com`)).toBe(false);
  });

  it("a sixth sequential attempt gets no credential work at all", async () => {
    for (let i = 0; i < 5; i++) {
      await authorizeWithCredentials(CREDS);
    }
    db.user.findUnique.mockClear();
    bcryptMock.compare.mockClear();

    expect(await authorizeWithCredentials(CREDS)).toBeNull();
    expect(db.user.findUnique).not.toHaveBeenCalled();
    expect(bcryptMock.compare).not.toHaveBeenCalled();
  });

  it("a successful login clears the reserved attempt slot", async () => {
    bcryptMock.compare.mockResolvedValue(true);
    const user = await authorizeWithCredentials({
      email: "victim@farm.com",
      password: "correct-password",
    });
    expect(user).not.toBeNull();
    expect(user?.id).toBe("u1");
    expect(isLoginThrottled(`${RIGHT_HOP}:victim@farm.com`)).toBe(false);
  });
});
