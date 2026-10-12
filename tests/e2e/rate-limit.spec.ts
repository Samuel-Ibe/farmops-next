import { test, expect, request as pwRequest, type APIRequestContext } from "@playwright/test";

const baseURL = process.env.BASE_URL || "http://localhost:3000";

// Rate-limit behavior that only shows up over real HTTP: mutation budgets
// must key off the PROXY-ADDED (rightmost) X-Forwarded-For hop — a client
// spoofing entries to the left of it must still land in one budget — and
// password-reset requests must be capped per mailbox, not only per origin.
//
// A bare request context (no fixture-injected default X-Forwarded-For) so
// every hop we send is exactly the one the server sees. The rightmost IP is
// minted per run: the server keeps limiter state for the lifetime of the dev
// process, so a stale budget from a previous run must never leak in.
test.describe("Rate limiting (brute-force resistance)", () => {
  const runToken = Date.now() % 65_536;
  const uniqueIp = (a: number, b: number) =>
    `10.${a}.${b}.${(((runToken >> 4) & 127) + 1) & 255}`;

  test("mutation budget keys off the rightmost hop, not client-spoofed ones", async () => {
    const origin = baseURL;
    const anon: APIRequestContext = await pwRequest.newContext({ baseURL: origin });
    const rightmost = uniqueIp(77, 11);
    try {
      let saw429 = false;
      let early429 = false;
      for (let i = 0; i < 31; i++) {
        const spoofed = `198.18.${Math.floor(i / 250)}.${i % 250}`;
        const res = await anon.fetch(`${origin}/api/transactions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin,
            // Client-controlled entries left of the proxy's hop — if the
            // server keyed on the leftmost, every request would get a
            // fresh budget and no 429 would ever appear.
            "x-forwarded-for": `${spoofed}, ${rightmost}`,
          },
          data: {},
        });
        if (res.status() === 429) {
          saw429 = true;
          if (i < 30) early429 = true;
        }
      }
      // Exactly 30 allowed (fresh budget), the 31st blocked — proving both
      // that all 31 shared one key and that the key was the rightmost hop.
      expect(saw429).toBe(true);
      expect(early429).toBe(false);
    } finally {
      await anon.dispose().catch(() => undefined);
    }
  });

  test("forgot-password is capped per mailbox even across rotating IPs", async () => {
    const origin = baseURL;
    const anon: APIRequestContext = await pwRequest.newContext({ baseURL: origin });
    const email = `bomb-probe-${runToken}@nonexistent.test`;
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 4; i++) {
        const res = await anon.fetch(`${origin}/api/auth/forgot-password`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            // Fresh origin per attempt: the per-IP budget never triggers,
            // so only the per-mailbox budget can produce the 429.
            "x-forwarded-for": uniqueIp(88, i),
          },
          data: { email },
        });
        statuses.push(res.status());
      }
      expect(statuses.slice(0, 3)).toEqual([200, 200, 200]);
      expect(statuses[3]).toBe(429);
    } finally {
      await anon.dispose().catch(() => undefined);
    }
  });
});
