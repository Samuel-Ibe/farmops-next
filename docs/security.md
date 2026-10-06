# FarmOps — Security

*Entry point for everything security-related. Deep documents live in
[`docs/security/`](./security/); full findings history in
[`SECURITY_AUDIT.md`](./SECURITY_AUDIT.md).*

---

## Current posture

| Measure | Status |
|---|---|
| Critical vulnerabilities (prod deps) | **0** |
| High vulnerabilities (prod deps) | **0** (2 moderate, accepted — see below) |
| Authenticated API routes | **45/51 guarded**; 6 intentionally public auth endpoints (+ public `/api/health` probe; `/api/seed` returns 403 outside development) |
| Tenant isolation | **100% of data routes** scoped server-side via `resolveFarmScope`, **proven at the HTTP boundary** by `tests/e2e/tenant-isolation.spec.ts` (13 adversarial scenarios, green in CI) |
| Ownership checks | **100% of per-ID mutations** (scoped lookup → 404) |
| Inventory integrity | Conditional-UPDATE stock mutations **+** DB `CHECK (quantityRemaining >= 0)` **+** real-PostgreSQL concurrency suite (`tests/db/`) |
| Idempotency | On critical mutations, incl. a concurrent duplicate-key E2E regression test |
| Raw SQL | **0 occurrences** (Prisma parameterized-only) |
| Audit logging | On every mutation: actor, IP, old/new values |

**Overall: 7.5/10** (up from 3/10 pre-audit — scoring rationale in
[SECURITY_AUDIT.md](./SECURITY_AUDIT.md) §9).

### Fixed this round (regression-tested)

Two cross-tenant reads found by the Phase 1 E2E work and fixed with the
suite as their regression guard:

1. `GET /api/seasons` returned **every farm's seasons** to any authenticated
   user (no scope at all).
2. `GET /api/reports` leaked cross-farm aggregates and other farms' recent
   transactions through the `dashboard` branch, other farms' purchase-order
   rows through `suppliers`, and global valuations through `valuation`.

Both are now session-scoped like the rest of the API; the tenant-isolation
suite asserts no `E2E-B` marker can appear in any Farm A response.

## Documents

| Doc | What it answers |
|---|---|
| [security/threat-model.md](./security/threat-model.md) | What are we protecting, from whom, and what's explicitly out of scope (STRIDE) |
| [security/tenant-isolation.md](./security/tenant-isolation.md) | How Farm A can never see Farm B — the invariant, the one function, how it breaks |
| [security/api-security.md](./security/api-security.md) | Guard stack, rate limits, CSRF, uploads, SSRF, keys — the endpoint rulebook |
| [SECURITY_AUDIT.md](./SECURITY_AUDIT.md) | All 25 findings with severities, remediation, and code (the record of what was fixed) |

## The five rules

1. **Guard every route.** Writes go through `mutationGuard`; reads through
   `requireAuth`/`requireRole`. New route without a guard = CI failure.
2. **Scope is derived from the session**, never from a query parameter.
   `resolveFarmScope(user)` is the only source of tenant truth.
3. **Object access is a scoped `findFirst`, and a miss returns 404** — never
   "fetch then check", never 403 for existence.
4. **Validate bodies with Zod; unknown keys are stripped.** Authorization
   fields (`role`, `farmId`) are assigned server-side or not at all.
5. **Log every mutation** with actor, IP, and before/after values.

## Open items (roadmap)

Completed work lives in the table above (and its "Fixed this round" note);
what remains:

| Priority | Item | Ref |
|---|---|---|
| P1 | Redis-backed rate limits / idempotency store (both are in-memory today — single-instance limitation) | SEC-18 |
| P1 | Remove `/api/seed` route entirely from production builds (it is dev-gated with 403, but still shipped) | SEC-17 |
| P2 | Enforce API-key `permissions[]` on every external route; cap alert fan-out | — |
| P3 | Reset token via URL fragment; hash-chained audit log | SEC-20/21/25 |
| P3 | Tenant-scope the shared catalog (`Category`, `Supplier`) or formally accept it as shared (batches/stock/quantities are already scope-proven) | §8 of audit |

Already delivered since this list was written (kept out of the table on
purpose): login throttling with progressive backoff (SEC-19), security
headers + CSP (SEC-21), API-key hashing and scopes (SEC-18), magic-byte
upload signature validation (SEC-20), route-level tenant-isolation E2E,
real-PostgreSQL concurrency tests and the `quantityRemaining >= 0` DB
invariant.

## Accepted risks (documented on purpose)

- **2 moderate prod-dep advisories** (`uuid` via `exceljs`): the vulnerable
  buffer path isn't reachable from our usage; fix requires an upstream major.
- **JWT claim staleness** — a role change takes effect on token refresh;
  high-impact routes re-read the DB (ADR-001).
- **Middleware checks cookie presence, not validity** — it's a redirect UX;
  `auth()` on each data path is the boundary (SEC-16).

## Reporting

Security issues are handled privately: open a confidential advisory to the
maintainers rather than a public issue. We aim to acknowledge within 48
hours and credit reporters who want it.
