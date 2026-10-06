import { describe, it, expect, beforeEach, afterAll } from "vitest";
import {
  VERIFICATION_CODE_DIGITS,
  VERIFICATION_PREFIX,
  VERIFICATION_TTL_MS,
  digestFromMessage,
  generateVerificationCode,
  hashVerificationCode,
  isVerificationExpired,
  isWellFormedCode,
  matchesVerificationCode,
  verificationMessage,
} from "@/lib/email-verification";

const ORIGINAL_SECRET = process.env.NEXTAUTH_SECRET;
const TEST_SECRET = "test-secret-for-email-verification-tests";

function restoreSecret() {
  if (ORIGINAL_SECRET === undefined) delete process.env.NEXTAUTH_SECRET;
  else process.env.NEXTAUTH_SECRET = ORIGINAL_SECRET;
}

describe("Verification codes", () => {
  beforeEach(() => {
    process.env.NEXTAUTH_SECRET = TEST_SECRET;
  });
  afterAll(restoreSecret);

  it("always emits exactly six digits", () => {
    for (let i = 0; i < 1000; i++) {
      expect(generateVerificationCode()).toMatch(/^[0-9]{6}$/);
    }
  });

  it("keeps leading zeros rather than shortening the code", () => {
    const codes = Array.from({ length: 1000 }, generateVerificationCode);
    // ~10% of uniform 6-digit values start with 0; padding is what saves them.
    expect(codes.some((c) => c.startsWith("0"))).toBe(true);
    expect(codes.every((c) => c.length === VERIFICATION_CODE_DIGITS)).toBe(true);
  });

  it("accepts only a well-formed 6-digit string", () => {
    expect(isWellFormedCode("000000")).toBe(true);
    expect(isWellFormedCode("123456")).toBe(true);
    expect(isWellFormedCode("12345")).toBe(false);
    expect(isWellFormedCode("1234567")).toBe(false);
    expect(isWellFormedCode("abcdef")).toBe(false);
    expect(isWellFormedCode("12 345")).toBe(false);
    expect(isWellFormedCode("123456\n")).toBe(false);
    expect(isWellFormedCode(123456)).toBe(false);
    expect(isWellFormedCode(undefined)).toBe(false);
  });
});

describe("Code hashing", () => {
  beforeEach(() => {
    process.env.NEXTAUTH_SECRET = TEST_SECRET;
  });
  afterAll(restoreSecret);

  it("is stable for the same code and user", () => {
    expect(hashVerificationCode("123456", "user_1")).toBe(
      hashVerificationCode("123456", "user_1")
    );
  });

  it("separates users, so one digest cannot be replayed against another", () => {
    expect(hashVerificationCode("123456", "user_1")).not.toBe(
      hashVerificationCode("123456", "user_2")
    );
  });

  it("separates codes for the same user", () => {
    expect(hashVerificationCode("123456", "user_1")).not.toBe(
      hashVerificationCode("123457", "user_1")
    );
  });

  it("is keyed by NEXTAUTH_SECRET, so a database dump alone is not enough", () => {
    const withOriginal = hashVerificationCode("123456", "user_1");
    process.env.NEXTAUTH_SECRET = "rotated-secret";
    const withRotated = hashVerificationCode("123456", "user_1");
    expect(withRotated).not.toBe(withOriginal);
  });

  it("refuses to produce a digest when the secret is missing", () => {
    delete process.env.NEXTAUTH_SECRET;
    expect(() => hashVerificationCode("123456", "user_1")).toThrow(
      /NEXTAUTH_SECRET/
    );
  });
});

describe("Code matching", () => {
  beforeEach(() => {
    process.env.NEXTAUTH_SECRET = TEST_SECRET;
  });
  afterAll(restoreSecret);

  it("matches the right code for the right user", () => {
    const digest = hashVerificationCode("042113", "user_1");
    expect(matchesVerificationCode("042113", "user_1", digest)).toBe(true);
  });

  it("rejects a wrong code", () => {
    const digest = hashVerificationCode("042113", "user_1");
    expect(matchesVerificationCode("042114", "user_1", digest)).toBe(false);
  });

  it("rejects the right code against a different user", () => {
    const digest = hashVerificationCode("042113", "user_2");
    expect(matchesVerificationCode("042113", "user_1", digest)).toBe(false);
  });

  it("rejects a malformed stored digest instead of throwing", () => {
    expect(matchesVerificationCode("042113", "user_1", "not-a-digest")).toBe(
      false
    );
    expect(matchesVerificationCode("042113", "user_1", "")).toBe(false);
  });
});

describe("Code expiry", () => {
  const issued = new Date("2026-01-01T00:00:00.000Z").getTime();

  it("is valid right up to the TTL boundary", () => {
    expect(isVerificationExpired(issued, issued)).toBe(false);
    expect(isVerificationExpired(issued, issued + VERIFICATION_TTL_MS - 1)).toBe(
      false
    );
    expect(isVerificationExpired(issued, issued + VERIFICATION_TTL_MS)).toBe(
      false
    );
  });

  it("expires one millisecond past the TTL", () => {
    expect(
      isVerificationExpired(issued, issued + VERIFICATION_TTL_MS + 1)
    ).toBe(true);
  });

  it("accepts Date and string timestamps too", () => {
    const after = issued + VERIFICATION_TTL_MS + 1;
    expect(isVerificationExpired(new Date(issued), after)).toBe(true);
    expect(isVerificationExpired(new Date(issued).toISOString(), after)).toBe(
      true
    );
  });

  it("has a 15 minute window", () => {
    expect(VERIFICATION_TTL_MS).toBe(15 * 60 * 1000);
  });
});

describe("Storage message round-trip", () => {
  beforeEach(() => {
    process.env.NEXTAUTH_SECRET = TEST_SECRET;
  });
  afterAll(restoreSecret);

  it("recovers the digest from the stored message", () => {
    const digest = hashVerificationCode("123456", "user_1");
    const stored = verificationMessage(digest);
    expect(stored.startsWith(VERIFICATION_PREFIX)).toBe(true);
    expect(digestFromMessage(stored)).toBe(digest);
  });

  it("ignores rows that are not verification codes", () => {
    expect(digestFromMessage("RESET_TOKEN:deadbeef")).toBeNull();
    expect(digestFromMessage("NPK stock is low")).toBeNull();
    expect(digestFromMessage(VERIFICATION_PREFIX)).toBe("");
  });
});
