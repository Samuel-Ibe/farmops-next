import { describe, it, expect, beforeEach } from "vitest";
import {
  beginIdempotency,
  completeIdempotency,
  isValidIdempotencyKey,
  releaseIdempotency,
  resetIdempotency,
} from "@/lib/idempotency";

/**
 * Duplicate-mutation safety: browser double-clicks, network retries and
 * client retry logic must produce exactly one effective operation, and a key
 * is bound to the payload fingerprint it first executed with.
 */
describe("Idempotency", () => {
  beforeEach(() => resetIdempotency());

  it("claims a fresh key exactly once", () => {
    expect(beginIdempotency("scope:abc", "h1")).toEqual({ outcome: "fresh" });
  });

  it("reports in-flight while the original request is running", () => {
    beginIdempotency("scope:abc", "h1");
    expect(beginIdempotency("scope:abc", "h1")).toEqual({ outcome: "inflight" });
  });

  it("replays the stored successful response for a duplicate", () => {
    beginIdempotency("scope:abc", "h1");
    completeIdempotency("scope:abc", 201, { id: "txn_1" });

    const replay = beginIdempotency("scope:abc", "h1");
    expect(replay.outcome).toBe("replay");
    if (replay.outcome === "replay") {
      expect(replay.record.status).toBe(201);
      expect(replay.record.body).toEqual({ id: "txn_1" });
    }
  });

  it("one effective operation: two attempts → one execution, one replay", () => {
    expect(beginIdempotency("scope:dup", "h1").outcome).toBe("fresh");
    completeIdempotency("scope:dup", 201, { count: 1 });
    expect(beginIdempotency("scope:dup", "h1").outcome).toBe("replay");
    expect(beginIdempotency("scope:dup", "h1").outcome).toBe("replay");
  });

  it("rejects reuse with a DIFFERENT payload while the original is in flight", () => {
    expect(beginIdempotency("scope:mis1", "h1")).toEqual({ outcome: "fresh" });
    expect(beginIdempotency("scope:mis1", "h2")).toEqual({ outcome: "mismatch" });
  });

  it("rejects reuse with a DIFFERENT payload after completion — never replays it", () => {
    beginIdempotency("scope:mis2", "h1");
    completeIdempotency("scope:mis2", 201, { id: "txn_1" });

    const other = beginIdempotency("scope:mis2", "h2");
    expect(other.outcome).toBe("mismatch");
    // The original binding is untouched: the correct payload still replays.
    expect(beginIdempotency("scope:mis2", "h1").outcome).toBe("replay");
  });

  it("does not store failed responses — a corrected retry may run", () => {
    beginIdempotency("scope:fail", "h1");
    completeIdempotency("scope:fail", 400, { error: "bad" });
    // The key was released, so the CORRECTED payload claims it freshly —
    // payload binding applies to successful executions, not to failures.
    expect(beginIdempotency("scope:fail", "h2").outcome).toBe("fresh");
  });

  it("releases a crashed request's claim", () => {
    beginIdempotency("scope:crash", "h1");
    releaseIdempotency("scope:crash");
    expect(beginIdempotency("scope:crash", "h1").outcome).toBe("fresh");
  });

  it("scopes keys independently", () => {
    beginIdempotency("user_a:POST /api/transactions:k1", "h1");
    completeIdempotency("user_a:POST /api/transactions:k1", 201, { a: true });
    // Same key from a different user must not replay another user's response
    expect(beginIdempotency("user_b:POST /api/transactions:k1", "h1").outcome).toBe("fresh");
  });

  it("validates key length bounds", () => {
    expect(isValidIdempotencyKey("")).toBe(false);
    expect(isValidIdempotencyKey("order-123")).toBe(true);
    expect(isValidIdempotencyKey("x".repeat(200))).toBe(true);
    expect(isValidIdempotencyKey("x".repeat(201))).toBe(false);
  });
});
