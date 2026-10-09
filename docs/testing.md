# FarmOps — Testing

*What we test, how to run it, what we don't test yet — and why.*

---

## 1. Commands

```bash
pnpm test                 # unit suite (Vitest), single run
pnpm run test:watch       # watch mode
pnpm run test:coverage    # unit + V8 coverage report (text/json/html)
pnpm run test:db          # real-PostgreSQL suite (needs DB_TEST_DATABASE_URL)
pnpm run test:e2e         # Playwright end-to-end (starts a dev server locally)
pnpm run test:e2e:ui      # Playwright UI mode
pnpm run test:all         # vitest && playwright
```

The repository is **pnpm-only** (`packageManager` in `package.json`, one
lockfile). CI runs `pnpm install --frozen-lockfile` → `tsc --noEmit` →
`eslint . --max-warnings 10` →
`vitest run` (with a PostgreSQL service: unit **and** real-DB suites) →
`next build` → Playwright e2e → Docker build + runtime smoke test. All five
jobs are required status checks on `master` via the `master-green-ci`
ruleset (owner push bypass keeps direct pushes working).

## 2. Current numbers (measured, not aspirational)

| Metric | Value | How it's measured |
|---|---|---|
| Unit tests | **176 passing** across 15 files (169 pure unit + 7 real-PostgreSQL; the DB 7 self-skip without `DB_TEST_DATABASE_URL`) | `pnpm test` |
| E2E tests | **53 passing** (21 tenant-isolation adversarial, 10 concurrency/transaction-integrity against real PostgreSQL, 17 API contract, 5 auth/UI) | `pnpm run test:e2e` |
| Type coverage | **99.51%** (43,372 / 43,583) — hard CI gate (`typecov` job) | `pnpm type-coverage` |
| TypeScript | `strict: true`, 0 errors | `npx tsc --noEmit` |
| ESLint | **0 errors**, 2 warnings (budget 10) — hard CI gate since Phase 4 | `npx eslint . --max-warnings 10` |
| Branch coverage across `src/lib` | **92.5%** | `pnpm run test:coverage` |
| Statement coverage across `src/lib` | **27.5%** | coverage include is `src/lib/**` only |

That last row is the honest one: the tested lib modules are covered well
(`tenant`, `rate-limit`, `security-headers`, `file-signatures`,
`email-verification` and `stock` are 95–100%) while whole modules go
untested (`api-auth`, `validations`, `audit`, `notifications`, `auth`).
Route handlers and pages still have almost no *unit* coverage — only the
two auth verification routes. The load-bearing authorization behavior is
instead proven at the HTTP boundary by the tenant-isolation e2e suite and
at the database boundary by the concurrency suite. Closing the remaining
gap is roadmap Phase 4/5: the guard/scope functions in `api-auth.ts` are
the highest-value targets because they *are* the security boundary.

## 3. What we test today

**`tests/lib/` — pure logic, no DB:**

| File | Covers |
|---|---|
| `utils.test.ts` (35) | formatting, currency/date/number helpers |
| `webhooks.test.ts` (13) | registration, dispatch, event fan-out |
| `email.test.ts` (12) | template rendering for each notification type |
| `api-keys.test.ts` (8) | create/validate/revoke lifecycle |
| `pagination.test.ts` (8) | cursor/limit parsing, response envelope |

**`tests/security/` — adversarial & security-regression units:**

| File | Covers |
|---|---|
| `tenant-isolation.test.ts` (14) | `resolveFarmScope`, role hierarchy, warehouse scope — the pure tenant boundary |
| `stock-race.test.ts` (12) | atomic conditional-UPDATE stock logic (in-memory contract) |
| `email-verification*.ts` (31) | code hashing/expiry/attempts + the three auth route contracts |
| `login-throttle.test.ts`, `security-headers.test.ts`, `file-signatures.test.ts`, `idempotency.test.ts`, `api-key-scopes.test.ts` | first-round hardening regressions |

**`tests/db/` — real PostgreSQL (gated):**

| File | Covers |
|---|---|
| `stock-concurrency.test.ts` (7) | concurrent 80/100 deductions → one winner & final 20, 20-way storm, mid-transaction rollback, CHECK-constraint enforcement. Skipped unless `DB_TEST_DATABASE_URL` points at a disposable migrated database — it never falls back to `DATABASE_URL`. |

**`tests/e2e/` — Playwright against a running server:**

- `tenant-isolation.spec.ts` (13) — Farm A attacks Farm B through real
  authenticated HTTP: list/read/export/write/transfer/split/delete paths,
  `farmId` query injection, unassigned and role-restricted users, admin
  positive control, concurrent duplicate `Idempotency-Key`.
- `api.spec.ts` (17) — anonymous 401 contract on protected endpoints +
  authenticated response shapes (CSRF, 405s, external-key 401).
- `auth.spec.ts` (5) — login/register/protected-route UI behavior.

Fixtures (`tests/e2e/tenant-fixtures.ts`) create two idempotent tenants
(`E2E-A`/`E2E-B` markers) and sign in through the real NextAuth callback.

**Deliberately excluded from unit tests:** anything needing a live database
*except* the gated `tests/db/` suite, which exists precisely for that.

## 4. What we should test next (priority order)

1. **Guard chain units:** `checkCsrf` (safe methods, matching/mismatched
   origin) and `hasMinRole` hierarchy edges — `api-auth.ts` still shows 0%
   statement coverage.
2. **Zod schemas:** unknown keys stripped (especially that `role` can't
   arrive through `createUserSchema`).
3. **Password-reset token logic:** digest match, expiry, single-use
   invalidation (email *verification* tokens are covered; reset tokens
   are not).
4. **Route-handler unit tests** beyond the two auth verification routes,
   starting with the highest-risk inventory/transaction handlers.

Already done from the old list: `resolveFarmScope` cases, adversarial
multi-tenant e2e, export scoping (proven in e2e), login throttling.

## 5. Writing tests

- Vitest style: `describe` per unit, `it` states the behavior in a sentence.
- No DB in unit tests — pass data in, assert data out. If a function can't
  be tested without a DB, it's doing too much; split it.
- Use `vi.fn()` for collaborators; don't mock Prisma inside unit tests
  (that's a sign the unit is a route handler — test the extracted function).
- Coverage thresholds: none yet. Adding them before the number is meaningful
  just teaches people to lower them.

## 6. Known tooling notes

**One package manager, one lockfile (roadmap Phase 3).** `package.json`
pins `packageManager: pnpm@…`; Corepack (`corepack enable`) picks it up
automatically. `package-lock.json` was removed on purpose — do not commit
one back. CI and the Docker build both use `pnpm install --frozen-lockfile`,
so a `package.json` dependency change must be followed by a lockfile update
(`pnpm install --lockfile-only`).

**Real-PostgreSQL suite:** set `DB_TEST_DATABASE_URL` to a **disposable**
database with `prisma migrate deploy` applied (e.g. a `*_e2e` database),
never your working one. Without it the 7 DB tests skip with a warning.

**Coverage provider pinning:** `@vitest/coverage-v8` must match the Vitest
major (currently 3.x) or the run dies with `BaseCoverageProvider` export
errors. It's pinned in `devDependencies`.

**Playwright** needs browsers once per machine: `npx playwright install`
(ffmpeg too, for video-on-failure). If the browser download is blocked,
`PW_CHANNEL=chrome` runs the suite against an installed Chrome instead.
The tenant fixtures need `DATABASE_URL` (exported, or present in `.env`).

**Coverage config** (`vitest.config.ts`): `include: ["src/lib/**/*.ts"]`,
excluding `prisma.ts`. Widening it to `src/app/api/**` will crater the
percentage — do that *with* the route tests in §4, not before, so the number
means something when it changes.

## 7. Definition of done

A change is done when:

- [ ] `npx tsc --noEmit` is clean
- [ ] `pnpm test` is green (and new behavior has tests where §4 says it should)
- [ ] e2e passes if auth, tenancy, navigation, or a major flow changed
- [ ] Security-sensitive changes ticked the checklist in
      [contributing.md](./contributing.md)
