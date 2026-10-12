import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  checkRateLimit,
  resetRateLimits,
  resetLoginFailures,
  isLoginThrottled,
  recordLoginFailure,
  clearLoginFailures,
  parseForwardedIp,
  rateLimitStoreSizes,
} from "@/lib/rate-limit";

describe("Rate limiting", () => {
  beforeEach(() => resetRateLimits());

  it("allows requests under the limit and blocks the one after", () => {
    for (let i = 0; i < 5; i++) {
      expect(checkRateLimit("ip:1", 5, 60_000).allowed).toBe(true);
    }
    expect(checkRateLimit("ip:1", 5, 60_000).allowed).toBe(false);
  });

  it("keys are independent", () => {
    expect(checkRateLimit("ip:1", 1, 60_000).allowed).toBe(true);
    expect(checkRateLimit("ip:2", 1, 60_000).allowed).toBe(true);
    expect(checkRateLimit("ip:1", 1, 60_000).allowed).toBe(false);
  });

  it("resets after the window elapses", () => {
    vi.useFakeTimers();
    try {
      expect(checkRateLimit("ip:w", 1, 1000).allowed).toBe(true);
      expect(checkRateLimit("ip:w", 1, 1000).allowed).toBe(false);
      vi.advanceTimersByTime(1001);
      expect(checkRateLimit("ip:w", 1, 1000).allowed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Login throttling (brute force, no lockout DoS)", () => {
  beforeEach(() => {
    resetRateLimits();
    resetLoginFailures();
  });

  it("blocks after 5 failed attempts from the same IP+account", () => {
    for (let i = 0; i < 5; i++) {
      recordLoginFailure("ip1:victim@farm.com");
    }
    expect(isLoginThrottled("ip1:victim@farm.com")).toBe(true);
  });

  it("does not throttle the same account from a different IP (no lockout DoS)", () => {
    for (let i = 0; i < 5; i++) {
      recordLoginFailure("ip1:victim@farm.com");
    }
    expect(isLoginThrottled("ip2:victim@farm.com")).toBe(false);
    expect(isLoginThrottled("ip1:other@farm.com")).toBe(false);
  });

  it("clears failures after a successful login", () => {
    for (let i = 0; i < 4; i++) recordLoginFailure("ip1:user@farm.com");
    expect(isLoginThrottled("ip1:user@farm.com")).toBe(false);
    clearLoginFailures("ip1:user@farm.com");
    recordLoginFailure("ip1:user@farm.com");
    expect(isLoginThrottled("ip1:user@farm.com")).toBe(false);
  });

  it("throttle expires with the failure window", () => {
    vi.useFakeTimers();
    try {
      for (let i = 0; i < 5; i++) recordLoginFailure("ip3:user@farm.com");
      expect(isLoginThrottled("ip3:user@farm.com")).toBe(true);
      vi.advanceTimersByTime(15 * 60 * 1000 + 1);
      expect(isLoginThrottled("ip3:user@farm.com")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Store eviction (memory-exhaustion guard)", () => {
  // A fixed-window entry expires logically but a Map never evicts on its
  // own: an attacker rotating source IPs could otherwise grow the stores
  // without bound. These assert keys actually leave memory after expiry.
  beforeEach(() => {
    resetRateLimits();
    resetLoginFailures();
  });

  it("removes expired fixed-window keys from memory", () => {
    vi.useFakeTimers();
    try {
      for (let i = 0; i < 500; i++) checkRateLimit(`rotate:${i}`, 1, 10);
      expect(rateLimitStoreSizes().windows).toBeGreaterThanOrEqual(500);
      vi.advanceTimersByTime(61_000);
      // Any subsequent write may trigger the sweep.
      checkRateLimit("sweep:trigger", 5, 60_000);
      expect(rateLimitStoreSizes().windows).toBeLessThanOrEqual(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("removes stale login-failure keys from memory", () => {
    vi.useFakeTimers();
    try {
      for (let i = 0; i < 100; i++) recordLoginFailure(`old:${i}`);
      expect(rateLimitStoreSizes().logins).toBe(100);
      vi.advanceTimersByTime(15 * 60 * 1000 + 61_000);
      recordLoginFailure("fresh:key");
      expect(rateLimitStoreSizes().logins).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("parseForwardedIp (rightmost trusted hop)", () => {
  it("ignores client-supplied entries left of the proxy-added hop", () => {
    expect(parseForwardedIp("6.6.6.6, 10.44.55.66", null)).toBe("10.44.55.66");
    expect(parseForwardedIp("1.1.1.1, 2.2.2.2, 3.3.3.3", null)).toBe("3.3.3.3");
  });

  it("handles single hop, real-ip fallback and blank headers", () => {
    expect(parseForwardedIp("9.9.9.9", null)).toBe("9.9.9.9");
    expect(parseForwardedIp(null, "5.5.5.5")).toBe("5.5.5.5");
    expect(parseForwardedIp(" , ", null)).toBe("unknown");
    expect(parseForwardedIp(null, null)).toBe("unknown");
    expect(parseForwardedIp("", "  ")).toBe("unknown");
  });
});
