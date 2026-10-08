# FarmOps — Next-Phase Implementation Roadmap

**Production Hardening → Reliability → Engineering Maturity**

Baseline: second engineering/security audit • 2 October 2026

> This is the authoritative "what next" document (§11 of the roadmap table in
> the documentation cleanup). Current-state documents (README,
> `docs/security.md`, `docs/testing.md`) describe what *is*; this file
> describes what comes next. Status below is updated as phases complete.

## Implementation status

| Priority | Phase | Outcome | Status (2 Oct 2026) |
|---|---|---|---|
| P0 | 1. Tenant E2E Security | Prove cross-tenant isolation through real HTTP | ✅ **Done** — `tests/e2e/tenant-isolation.spec.ts` (13 scenarios: reads, ID-based reads, writes, transfers/splits, exports, unassigned/role-restricted users, admin control, idempotency). Whole e2e suite **35/35 green** locally and wired as a required CI job. Fixed 2 real leaks found while writing it: unscoped `GET /api/seasons` and unscoped `GET /api/reports` (dashboard/suppliers/valuation branches) — both regression-covered by the suite. |
| P0 | 2. PostgreSQL Correctness | Concurrency, rollback, DB invariants | ✅ **Done** — `tests/db/stock-concurrency.test.ts` runs the acceptance scenario against real PostgreSQL (100 units, two concurrent 80-unit deductions → exactly one succeeds, final 20; 20-way storm; mid-transfer rollback; failure-path rollback). `CHECK ("quantityRemaining" >= 0)` added; suite proves the DB rejects negative stock. Migrations validated against a fresh database **and** a copy of real existing data. |
| P0 | 3. Deployment & Migrations | Reproducible build + controlled schema evolution | ✅ **Done** — pnpm-only (`package-lock.json` removed, `packageManager: pnpm@12.8.1`, CI uses frozen lockfile), baseline migration `prisma/migrations/0_init` + `migration_lock.toml`, Dockerfile fixed (it could not build or start before) and a **Docker build + runtime smoke test** job in CI (health/db/auth checks, logs on failure). |
| P1 | 4. Type Safety | Remove unsafe client boundaries | ✅ **Done** — `eslint .`: **0 errors** (was 249: 206 `no-explicit-any`, 38 `set-state-in-effect`, plus empty-object/unescaped-entity debt), 2 warnings vs the `--max-warnings 10` budget; `type-coverage` **98.26%** (was 93.01%); typed session via `src/types/next-auth.d.ts`, route-level DTO exports, `Prisma.*UpdateInput`/`WhereInput` across mutated routes. Lint promoted to a **hard CI gate** (`continue-on-error` removed) and `master` now enforces all five checks via the `master-green-ci` ruleset (owner push bypass). |
| P1 | 5. Domain Service Refactor | Separate HTTP from business logic | ⏳ Not started (domains in §9) |
| P1 | 6. Observability | Diagnose failures in production | 🔶 Partial — structured JSON logs with request IDs, readiness/liveness health endpoint and `logRouteError` already exist; remaining: endpoint/DB latency metrics, authorization-denial counters, production error monitoring. Failure-diagnosis runbook delivered as [`docs/operations.md`](operations.md). |
| P2 | 7. Documentation | Single authoritative current-state docs | 🔶 Done for this round — roadmap promoted into this file, metrics re-measured, completed-vs-open split refreshed in `docs/security.md`, `docs/testing.md`, README. |
| P2 | 8. Product Expansion | Only after hardening | ⏳ Blocked by execution rule §3 |

---

FarmOps
Next-Phase Implementation Roadmap
Production Hardening → Reliability → Engineering Maturity
Baseline: second engineering/security audit • 2 October 2026
1. Purpose
This is the implementation plan for FarmOps after the second engineering audit. It assumes the major first-round recommendations have already been implemented: atomic stock mutation, tenant-scoped warehouse validation, idempotency on critical mutations, API-key hashing/scopes, login throttling, upload signature validation, security headers, server-side dashboard aggregation, CI trigger corrections, health checks and expanded security documentation.
The objective now is not to make FarmOps larger. It is to prove that the existing system is correct, secure, reproducible and maintainable under realistic failure conditions.
2. Current Target State
Dimension
Current state
Next target
Security
Strong controls and helper-level tests
Route-level adversarial E2E proof
Inventory integrity
Atomic application logic + race test
Live PostgreSQL concurrency proof + DB invariants
Idempotency
Implemented on critical mutations
Regression coverage and operational verification
Testing
Improved critical-path coverage
Security + integration + concurrency suite
Type safety
Good overall coverage; notable any debt
Typed critical domains and strict CI gate
Deployment
Docker/CI improvements
Reproducible container build + runtime smoke test
Database lifecycle
Schema-push oriented
Versioned Prisma migrations
Documentation
Detailed but some stale pages
Single authoritative current-state docs
Operations
Basic health/logging foundations
Structured observability and failure diagnostics
3. Execution Rules
Do not add major product features until Phases 1–3 are complete.
Every security or data-integrity bug fixed must receive a regression test.
Keep commits/PRs focused on one engineering objective.
Run the relevant suite after each phase; do not postpone verification.
Measure before optimizing queries or adding caching.
Review AI-generated code yourself, especially authorization, data-flow and failure behavior.
Keep documentation synchronized with the actual repository state.
4. Priority Map
Priority
Phase
Outcome
Why
P0
1. Tenant E2E Security
Prove cross-tenant isolation through real HTTP routes
Highest remaining security-confidence gap
P0
2. PostgreSQL Correctness
Prove concurrency and rollback behavior against real DB
Protects business data
P0
3. Deployment & Migrations
Reproducible build + controlled schema evolution
Production readiness
P1
4. Type Safety
Remove unsafe client boundaries
Maintainability
P1
5. Domain Service Refactor
Separate HTTP from business logic
Testability and growth
P1
6. Observability
Diagnose failures in production
Operational maturity
P2
7. Documentation
Accurate engineering story
Portfolio/interview value
P2
8. Product Expansion
Only after hardening
Avoid feature-driven debt
5. Phase 1 — Route-Level Tenant Security E2E
Goal: prove authorization at the real HTTP/API boundary, not merely inside helper functions.
Implementation
Create two isolated test farms: Farm A and Farm B.
Create representative users/roles in each farm.
Seed inventory items, batches, warehouses, transactions, requests, notifications and reports in both farms.
Authenticate real test users and capture session state.
Attempt cross-tenant reads using valid IDs.
Attempt cross-tenant writes, deletes, transfers and exports.
Test foreign warehouse, batch and item relationships.
Test unassigned users and role-restricted users.
Test legitimate administrator behavior separately.
Turn every discovered authorization bug into a regression test.
Suggested test
tests/e2e/tenant-isolation.spec.ts
Acceptance criteria
Farm A cannot read, modify, delete or export Farm B resources through documented routes.
Foreign warehouse IDs cannot be injected into stock operations.
Foreign batch/item relationships cannot cross the tenant boundary.
Unassigned users receive no tenant data.
Administrative cross-farm behavior works only where explicitly intended.
The suite runs automatically in CI.
6. Phase 2 — Real PostgreSQL Concurrency & Integrity
Goal: prove that stock invariants survive real database concurrency.
Run tests against an actual PostgreSQL instance, preferably disposable in CI.
Create a batch with 100 units and launch two simultaneous 80-unit deductions.
Assert exactly one succeeds and final stock is 20.
Repeat for transfers, reversals, splits and adjustments where relevant.
Force failures after a stock mutation and verify complete rollback.
Test duplicate Idempotency-Key requests concurrently.
Add safe database CHECK constraints such as quantity_remaining >= 0.
Review isolation/locking assumptions for high-risk operations.
Acceptance criteria
No concurrent test produces negative or impossible stock.
Failed transactions leave inventory and transaction records consistent.
Duplicate requests have one effective business outcome.
Database constraints reject impossible states.
7. Phase 3 — Dependency, Migration & Deployment Discipline
7.1 Standardize package management
Use pnpm consistently.
Remove the competing npm lockfile.
Document Corepack/pnpm setup.
Use pnpm install --frozen-lockfile in CI.
7.2 Introduce Prisma migrations
Establish a clean baseline migration from the current schema.
Use migrations for future schema changes.
Test migrations against a fresh database.
Test migrations against representative existing data.
Document recovery expectations for destructive migrations.
7.3 Docker runtime smoke test
Build the production image in CI.
Start the container with PostgreSQL.
Run a health/readiness check.
Verify database connectivity.
Verify authentication and a representative API call.
Fail CI if the image builds but the container does not start correctly.
Acceptance criterion: a clean checkout can be installed, migrated, built, containerized and smoke-tested through a documented repeatable process.
8. Phase 4 — Type Safety Campaign
Work in this order:
Dashboard DTOs/hooks
Inventory DTOs/components
Transactions/stock operations
Reports/exports
Intelligence/forecasting
Shared forms/components
Rules
Do not replace any with unknown and immediately cast it back without validation.
Validate external API data at boundaries.
Keep Prisma models separate from client DTOs.
Use discriminated unions for status-heavy objects where useful.
Centralize API response types where practical.
Target: critical client domains contain no intentional any; lint can eventually become a blocking CI gate.
Status: achieved — 0 lint errors and lint is a blocking CI gate (Oct 2026).
9. Phase 5 — Domain Service Refactor
Refactor high-risk workflows without rewriting the whole application.
Domain
Target
Inventory
InventoryService.applyStockDelta(), transfer()
Transactions
TransactionService.issue(), reverse()
Procurement
PurchaseOrderService.submit(), approve(), receive()
Exports
ExportService.buildInventoryExport()
Authorization
FarmScopeService / AuthorizationPolicy
Start with inventory, transactions, procurement and exports. Keep low-risk CRUD routes alone until there is a concrete benefit.
Acceptance criterion: core business rules can be tested without constructing a full HTTP request.
10. Phase 6 — Observability & Operational Readiness
Add request/correlation IDs to server logs.
Use structured logs.
Measure endpoint and database latency for critical workflows.
Track authorization denials and mutation failures without logging secrets.
Add production error monitoring.
Separate liveness/readiness checks where useful.
Document failure-diagnosis procedures for authentication, database and stock operations.
Acceptance criterion: a simulated production failure can be traced from request → endpoint → service → database/error without temporary debugging.
11. Phase 7 — Documentation Cleanup
Document
Role
README.md
Current overview, setup, capabilities and verified metrics
docs/security.md
Current security architecture and controls
docs/SECURITY_AUDIT.md
Historical findings and remediation record
docs/PRODUCTION_ELEVATION.md
Completed hardening work and decisions
docs/operations.md
Failure-diagnosis runbook (auth, database, stock operations)
This roadmap
Next implementation sequence
Remove stale current-state claims.
Re-run metrics before publishing them.
Never report historical coverage as current.
Document known limitations honestly.
12. CI Quality Gate — End State
Install with frozen pnpm lockfile.
Generate Prisma client.
Run formatting/checks.
Run TypeScript validation.
Run unit tests.
Run integration/security tests against PostgreSQL.
Run E2E tests.
Run lint with zero-error policy.
Build Next.js application.
Build Docker image.
Start container and run smoke test.
Promote each check to a required gate only after the repository is clean enough that the gate is useful.
Status: all five CI checks are required on `master` through the `master-green-ci` ruleset (owner push bypass so direct pushes still work, Oct 2026).
13. Git/PR Strategy
Use one branch per engineering objective.
Keep security fixes separate from formatting-only changes.
Write PR descriptions as: problem → risk → implementation → tests → residual risk.
Reference the roadmap item.
For security changes, include the attack scenario and regression test.
For database changes, include migration and recovery considerations.
14. AI-Assisted Development Rules
Mimo 2.6 has assisted with parts of FarmOps. Use that as evidence of effective AI-assisted engineering, not as a substitute for engineering judgment.
Review generated code before accepting it.
Ask the assistant to explain authorization boundaries and failure modes.
Use AI to generate test cases, then personally verify the threat model and assertions.
Never allow generated code to make authorization decisions based only on client input.
Keep security-sensitive changes small and reviewable.
Be able to explain every important architectural decision yourself in an interview.
15. Release Milestone After Phase 3
After Phases 1–3, pause feature development and create a hardening release/tag.
Security E2E report
Concurrency test report
Migration guide
Docker deployment instructions
Updated architecture diagram
Updated security model
16. Definition of Done
Tenant isolation is proven through real route-level E2E tests.
Live PostgreSQL concurrency tests pass.
Stock invariants are reinforced with database constraints where appropriate.
Critical mutations are idempotent and regression-tested.
Prisma schema changes use migrations.
One package manager and one lockfile are used.
Docker build and runtime smoke tests pass in CI.
Critical frontend paths are strongly typed.
Lint can be made a required CI gate.
High-risk business logic is separated from HTTP handlers.
Production failures are diagnosable through structured logs and monitoring.
Security documentation matches the implementation.
17. What Comes After Hardening
Only after this milestone should you choose another major product capability. Prefer deeper farm workflows over unrelated technology.
Crop cycles, plots and field operations
Seasonal planning
Supplier performance/procurement analytics
Farm cost and profitability intelligence
More robust forecasting
Choose the next feature from a real user workflow or farm problem. Do not add AI, IoT or blockchain merely for portfolio optics.
18. Immediate Next 10 Actions
Create tests/e2e/tenant-isolation.spec.ts.
Set up Farm A/Farm B fixtures and authenticated test users.
Attack high-risk ID-based endpoints across the tenant boundary.
Run a real PostgreSQL concurrent stock test.
Add rollback/failure-path tests to critical inventory transactions.
Add quantity_remaining >= 0 database protection where safe.
Introduce the first Prisma migration baseline.
Standardize the repository on pnpm and remove the competing lockfile.
Make Docker build + startup a CI smoke test.
Clean current security documentation so completed and open work are clearly separated.
19. Final Direction
FarmOps does not need to become bigger to become more impressive. The next level is depth: proving security boundaries through real routes, proving inventory remains correct under concurrency, proving deployments are reproducible, and making the codebase strongly typed and operationally diagnosable.
If these phases are completed, FarmOps will demonstrate engineering judgment—not merely feature-building ability—through invariants, threat modelling, database behavior, deployment discipline and maintainability.
20. Final Checklist
□ Route-level tenant E2E suite
□ Real PostgreSQL concurrency suite
□ Rollback/failure-path tests
□ Database invariants
□ Prisma migrations
□ pnpm-only workflow
□ Docker runtime smoke test
□ Critical-domain type cleanup
□ High-risk service-layer refactor
□ Structured observability
□ Current-state documentation cleanup
□ CI quality gates
□ Hardening release/tag
Next principle: prove the system before expanding the system.
