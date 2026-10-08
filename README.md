# FarmOps

[![FarmOps CI/CD](https://github.com/Samuel-Ibe/farmops-next/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/Samuel-Ibe/farmops-next/actions/workflows/ci.yml)

**FarmOps helps medium-size farms reduce input waste and coordinate field operations across planting, maintenance, and harvest seasons.**

It is the operational layer between the field and the store: what was ordered, what arrived, which lot went where, what got counted, what was wasted — scoped to one farm, auditable per action, usable by field staff on a phone.

Built for farms running 20–500 hectares across several plots in Ghana (GH₵, kg/bags/liters, English + Twi + Ga + Ewe), where input prices are high, loss hurts, and the answer to "where did those 40 bags of NPK go?" needs to exist.

---

## Engineering metrics

Measured on `master`, not estimated. The badge above reflects all **six** CI checks required on `master` by the `master-green-ci` ruleset — Lint & Type Check, Type Coverage, Tests (unit + PostgreSQL), Build, E2E Tests, and Docker Build & Smoke Test; the run (and badge) is green only when every one passes:

| Metric | Value | Tool |
|---|---|---|
| Type coverage | **99.51%** (43,372 / 43,583) — hard CI gate (`Type Coverage` job) | `type-coverage` |
| TypeScript | `strict: true`, **0 errors** | `tsc --noEmit` |
| ESLint | **0 errors**, 2 warnings (budget `--max-warnings 10`) — hard CI gate | `eslint .` |
| Unit tests | **176 passing** (15 suites — incl. 93 adversarial security tests and 7 real-PostgreSQL concurrency/rollback/invariant tests) | Vitest |
| E2E tests | **35 passing** — 13 route-level tenant-isolation attack scenarios, 17 API contract checks, 5 auth/UI | Playwright |
| Branch coverage, `src/lib` | **92.5%** | `vitest --coverage` |
| Critical vulnerabilities, production deps | **0** | `pnpm audit --prod` |
| High vulnerabilities, production deps | **0** (2 moderate accepted — see [security.md](docs/security.md)) | `pnpm audit --prod` |
| Authenticated API routes | **45/51 guarded** — 6 are intentionally public auth endpoints | route sweep |
| Tenant isolation | **100% of data routes** scoped server-side from the session, **proven through real HTTP** by the Farm A/B attack suite | `resolveFarmScope` + `tests/e2e/tenant-isolation.spec.ts` |
| Ownership checks | **100% of per-ID mutations** (scoped lookup → 404, never 403) | audit |
| Stock mutations | **atomic** — conditional updates inside DB transactions; lost race → 409; DB `CHECK (quantityRemaining >= 0)` rejects negative stock; verified against real PostgreSQL | `src/lib/stock.ts` + `tests/db/` |
| Idempotency | `Idempotency-Key` on transactions, transfer, split, approvals, PO submission — incl. a concurrent duplicate-key E2E test | `src/lib/idempotency.ts` |
| API keys | stored **SHA-256 hashed**, scope-enforced per route | `src/lib/api-keys.ts` |
| Login throttling | 5 failed attempts / IP+account / 15 min, no lockout DoS | `src/lib/rate-limit.ts` |
| Email verification | **required on sign-up** — 6-digit code, 15-min TTL, 8 guesses/account, HMAC-stored | `src/lib/email-verification.ts` |
| Security headers | CSP + HSTS + frame/nosniff policy on every response | `src/middleware.ts` |
| Schema management | versioned Prisma migrations (`prisma/migrations/`, baseline + invariants) deployed in CI — not `db push` | `prisma migrate deploy` |
| Docker | image **builds and boots in CI** with a runtime smoke test (health/DB/auth) | `.github/workflows/ci.yml` |
| Health endpoint | `GET /api/health` (DB probe, 200/503) | deployment checks |
| Raw SQL / `dangerouslySetInnerHTML` | **0 / 0** | grep |

Honest gaps (they're tracked, not hidden): statement coverage across `src/lib` is 27.5% — the tested modules are covered well, but whole modules (`api-auth`, `validations`, `audit`, `auth`) still have no unit tests; route handlers are covered at the HTTP boundary (tenant E2E) rather than by handler-level unit tests. See [docs/testing.md](docs/testing.md) §2. The full hardening status — including completed phases (the DTO/`any` sweep and zod validation of every API request body are done) and deferred items like distributed rate limiting — is mapped recommendation-by-recommendation in [docs/PRODUCTION_ELEVATION.md](docs/PRODUCTION_ELEVATION.md); the next engineering phases live in [docs/ROADMAP.md](docs/ROADMAP.md).

---

## What's in the box

**Today (working):**

- **Stock control with lot tracking** — batches with expiry (FEFO), reorder points, valuation, split/transfer/count between stores
- **Procurement** — purchase orders, suppliers, internal input requests
- **Loss accounting** — waste records with reason and estimated value
- **Seasons** — planning periods with inventory plans
- **Forecasting Engine** — six-month weighted moving-average consumption forecasts, reorder thresholds, anomaly flags (explicit math, no "AI": [docs](docs/) → Forecasting page)
- **Alerts** — expiry, low stock, critical stock, ranked and farm-scoped
- **QR capture** — scan a bag, look up a lot, see its movements
- **Exports** — CSV / Excel / PDF, all tenant-scoped
- **5 roles** — Admin, Farm Manager, Warehouse Manager, Accountant, Field Worker
- **Audit trail** — every mutation with actor, IP, before/after values
- **i18n** — English, Twi, Ga, Ewe

**Not in the box (on purpose):** no AI chat, no "smart insights" branding, no marketplace, no payroll, no chart builder. The redesign in [docs/PRODUCT_REDESIGN.md](docs/PRODUCT_REDESIGN.md) cuts 18 nav items to 5 and rebuilds the model around crop cycles.

---

## Quick start

```bash
git clone <repo> && cd farmops
corepack enable              # activates the pnpm pinned in package.json
pnpm install --frozen-lockfile
cp .env.example .env               # set DATABASE_URL + NEXTAUTH_SECRET
npx prisma migrate deploy          # versioned migrations (baseline + invariants)
npm run db:seed
pnpm dev
```

Open http://localhost:3000.

**One package manager, one lockfile:** the repo is pnpm-only
(`packageManager` field + `pnpm-lock.yaml`; `package-lock.json` is
intentionally absent). npm peer-dep conflicts (`next-auth@5` vs
`nodemailer@10`) that once required `--legacy-peer-deps` are a non-issue
under pnpm. See [docs/contributing.md](docs/contributing.md).

### Docker

```bash
docker compose up -d   # PostgreSQL + app + MailHog (email UI: :8025)
```

### Seeded login

The seed creates **exactly one account**: your admin. Credentials come from
`.env` — nothing is hardcoded, and the seed refuses to run if they're unset:

```bash
ADMIN_EMAIL="admin@farmops.com"   # your login email
ADMIN_PASSWORD="<strong password>" # min 12 chars; never commit this
ADMIN_NAME="Samuel Ibe"            # optional
```

No other accounts exist until you create them in-app (or via `POST
/api/auth/register`, which assigns `FIELD_WORKER` server-side and never
accepts a role from the client).

---

## Tech stack

| Layer | Choice | Why |
|---|---|---|
| Framework | Next.js 16 (App Router) | one codebase for SSR + API |
| Language | TypeScript 5.7, `strict` | 92.5% type coverage |
| Database | PostgreSQL 16 | one DB, `farmId` discriminators ([ADR-002](docs/adr/ADR-002-multi-tenant-design.md)) |
| ORM | Prisma 6 | typed schema→code, zero raw SQL ([ADR-003](docs/adr/ADR-003-prisma-selection.md)) |
| Auth | NextAuth v5, JWT sessions | one module owns claims ([ADR-001](docs/adr/ADR-001-auth-strategy.md)) |
| UI | Radix + Tailwind + shadcn/ui | accessible primitives without a design-system project |
| Validation | Zod | same schemas at every boundary |
| Charts | Recharts | |
| Tests | Vitest + Playwright | |
| Storage | Local disk behind a `FileStore` seam → object storage later ([ADR-004](docs/adr/ADR-004-storage-strategy.md)) | |

---

## Architecture

A **modular monolith**: one Next.js app, one Postgres, 53 route handlers. Boundaries are code-level (bounded contexts), not network hops.

```
Browser → middleware (cookie presence, UX only)
       → route handler: guard → Zod → resolveFarmScope → Prisma → audit log
```

```
CROP PRODUCTION (core)     CropCycle · Plot · SeedLot · FieldOperation · HarvestBatch…
INPUTS & STORES (support)  Store · InputLot · StockMove · PurchaseOrder · StockCount
EQUIPMENT (support)        Machine · EquipmentUsage
IDENTITY (generic)         Farm(tenant) · User · Role
ACCOUNTING (generic)       export to spreadsheets — don't build a ledger
```

Full shape, seams, and debts: **[docs/architecture.md](docs/architecture.md)**

---

## Documentation

| | |
|---|---|
| [architecture.md](docs/architecture.md) | system shape, layers, seams, known debts |
| [data-model.md](docs/data-model.md) | tables, meaning, migration plan to crop cycles |
| [security.md](docs/security.md) | security entry point — posture, rules, open items |
| ├ [threat-model.md](docs/security/threat-model.md) | STRIDE: assets, threats, trust assumptions |
| ├ [tenant-isolation.md](docs/security/tenant-isolation.md) | how Farm A never sees Farm B |
| └ [api-security.md](docs/security/api-security.md) | guard stack, limits, CSRF, uploads, keys |
| [SECURITY_AUDIT.md](docs/SECURITY_AUDIT.md) | 25 findings, severities, remediation, code |
| [PRODUCT_REDESIGN.md](docs/PRODUCT_REDESIGN.md) | identity, DDD, UX redesign, scores, roadmap |
| [testing.md](docs/testing.md) | commands, coverage reality, what to test next |
| [deployment.md](docs/deployment.md) | env, migrations, checklist, scaling triggers |
| [operations.md](docs/operations.md) | failure diagnosis runbook: auth, database, stock operations |
| [ROADMAP.md](docs/ROADMAP.md) | next-phase engineering roadmap + phase status |
| [contributing.md](docs/contributing.md) | setup, PR rules, security checklist |
| [adr/](docs/adr/) | ADR-001 auth · ADR-002 tenancy · ADR-003 ORM · ADR-004 storage |

---

## Trade-offs (the compromises we made on purpose)

Documented decisions, not accidents — the full list lives in the ADRs.

- **Modular monolith over microservices** — team < 5, lower operational
  complexity, faster development, easier debugging. Extraction triggers are
  written down ([ADR-004](docs/adr/ADR-004-storage-strategy.md)).
- **Shared-schema tenancy over database-per-tenant** — one database to
  migrate, pool, and back up; tenant isolation enforced by one server-side
  function instead of infrastructure. The invariant is convention + CI sweep,
  not the type system — the trade-off is explicitly accepted
  ([ADR-002](docs/adr/ADR-002-multi-tenant-design.md)).
- **JWT sessions over DB sessions** — no session store, one request = one
  cookie check; cost is claim staleness on role changes, mitigated by
  re-reading the DB on sensitive routes
  ([ADR-001](docs/adr/ADR-001-auth-strategy.md)).
- **Prisma over Drizzle/raw SQL** — fastest path to end-to-end types and
  zero SQL-injection surface; cost is a black-box query planner and
  Decimal⇄Number friction at every calculation site
  ([ADR-003](docs/adr/ADR-003-prisma-selection.md)).
- **Local-disk uploads behind an interface** — zero infrastructure today,
  one-class migration to S3/R2 when a written trigger fires
  ([ADR-004](docs/adr/ADR-004-storage-strategy.md)).
- **In-memory rate limits & API keys** — correct for one instance, wrong
  for two. Scaling out requires moving them first; the trigger is documented
  in [deployment.md](docs/deployment.md) §8.
- **NextAuth v5 beta** — pre-stable, pinned in the lockfile, upgrades gated
  by the test suite.
- **2 accepted moderate dependency advisories** — unreachable code paths
  pending upstream fixes, detailed in [security.md](docs/security.md).

---

## Roadmap

Prioritized plan from 4/10 → 8.5/10 across product, security, architecture,
and UX: **[docs/PRODUCT_REDESIGN.md](docs/PRODUCT_REDESIGN.md)** Part VIII.
The current *engineering* hardening plan (phases, acceptance criteria,
status) is **[docs/ROADMAP.md](docs/ROADMAP.md)**.

| Phase | Focus |
|---|---|
| P0 | DTO layer, server-composed views, nav 18 → 5, season home |
| P1 | CropCycle + Plot aggregates, SeedLot split, FieldOperation flow |
| P2 | Lifecycle rail, seasonal timeline, movement flows, offline capture |
| P3 | Disease/weather events, fertilizer plan vs actual, equipment, margin review |
| P4 | Security backlog, tenant-scoped catalog, field validation |

---

## License

[MIT](LICENSE) © Samuel Ibe
