# Contributing to FarmOps

Thanks for helping. This document is short on purpose — if a rule here
genuinely slows you down, propose changing it in a PR that edits this file.

---

## Setup

```bash
npm install --legacy-peer-deps   # peer-dep note below
cp .env.example .env             # fill in DATABASE_URL + NEXTAUTH_SECRET
npx prisma migrate deploy        # versioned migrations (reproducible; see ADR-003)
npm run db:seed
npm run dev
```

**Why `--legacy-peer-deps`:** `next-auth@5.0.0-beta` declares a peer on
`nodemailer ^7||^8` while we run `^10` (needed for security patches). npm's
strict resolver refuses the combination; `--legacy-peer-deps` accepts it.
This is a known, accepted cost — see
[adr/ADR-003](./adr/ADR-003-prisma-selection.md) notes and
[testing.md](./testing.md).

Verify your setup before first commit:

```bash
npx tsc --noEmit   # typecheck
npm test           # 138 unit tests
```

## Branch & commit style

- Branch: `fix/…`, `feat/…`, `docs/…`, `refactor/…` off the default branch
  (`master`).
- Commits: imperative subject, body explains *why* when it isn't obvious.
  One logical change per commit — don't mix a rename with a behavior change.
- Don't commit `.env`, `node_modules/`, `public/uploads/`, or generated
  `.next/` output.

## Opening a PR

**Title:** what changed, not which files. *“Scope export endpoints by farm”*
not *“Update route.ts”*.

**Description must include:**

1. **Why** — the problem in one or two sentences.
2. **What** — the approach, and anything you considered and rejected.
3. **Risk** — what could break; call out auth, tenancy, or money paths
   explicitly. “None” is only believable with a reason.
4. **Verification** — commands run and their results.

**If your PR touches security-sensitive code, tick these in the PR body:**

- [ ] New/changed route uses `mutationGuard` (writes) or `requireAuth`/`requireRole` (reads)
- [ ] Every tenant-data query applies `resolveFarmScope`
- [ ] Object access uses scoped `findFirst` → **404** (not 403)
- [ ] Both ends validated on cross-entity writes
- [ ] Body validated with Zod; no `role`/`farmId` accepted from the client
- [ ] Mutations call `writeAuditLog`

That checklist mirrors [security/api-security.md](./security/api-security.md)
§12 — it's the same list the audit used.

## Branch protection & release gates

Verified against the GitHub API on 2026-10-12 — not assumed. Re-run the
commands after changing any of it and update this section in the same PR.

**Enforcement layer:** a single ruleset, `master-green-ci` (id `24705506`),
`enforcement: active`, target `branch`. There is **no legacy branch
protection** on `master` (`GET …/branches/master/protection` → 404) — if the
ruleset is ever deleted, `master` is wide open.

**Six required status checks** (literal context strings from the ruleset;
renaming a CI job's `name:` silently breaks the gate for everyone who
isn't bypassed):

1. `Lint & Type Check`
2. `Type Coverage`
3. `Tests (unit + PostgreSQL)`
4. `Build`
5. `E2E Tests`
6. `Docker Build & Smoke Test`

Strict mode is off (no up-to-date-branch requirement) and checks are not
enforced at PR creation (`do_not_enforce_on_create: true`).

**Bypass:** exactly one actor — the `Samuel-Ibe` account (user id `129095302`),
`bypass_mode: always`. No team or app bypass exists. Anyone else pushing or
merging must satisfy all six checks first.

**Other rules:** `deletion` (cannot delete `master`) and `non_fast_forward`
(no force pushes).

**How changes reach master today:**

- Direct push using the `Samuel-Ibe` credential (always-bypass, so CI runs
  *after* the push; every push in this project's history has that shape).
- PR merge (merge, squash, or rebase — all three enabled repo-wide), which
  requires all six checks green for non-bypass actors.

Verification commands:

```bash
gh api repos/Samuel-Ibe/farmops-next/rulesets/24705506 --jq '{name, enforcement, bypass_actors, rules}'
gh api repos/Samuel-Ibe/farmops-next/branches/master/protection   # expect 404
```

## Code conventions

**Do:**

- Type every boundary. DTO types for API responses (P0 work in progress —
  until they exist, don't add new `any`).
- Return the shared guard responses (`if (user instanceof NextResponse) return user`)
  instead of hand-rolling 401/403.
- Name things in the domain's words: *crop cycle*, *seed lot*, *field
  operation* — not `item2`, `dataStuff`, `newFlag`.
- Keep `route.ts` thin: parse → authorize → call → serialize. Rules live in
  `src/lib`.
- Write the ADR when you make a structural choice. If you can't state the
  trade-off, you haven't decided yet.

**Don't:**

- No `$queryRaw`/`$executeRaw` (this is also our SQLi posture).
- No `console.log` in committed code — the app logs through `console.error`
  in catch blocks; debug leftovers get stripped in review.
- No new top-level nav items without an IA note in
  [PRODUCT_REDESIGN.md](./PRODUCT_REDESIGN.md) — the nav is at 18 and the
  target is 5.
- No “temporary” bypasses of guards or scope. If the guard is wrong, fix the
  guard.

## i18n

User-visible strings go through `t()` with keys added to **all four**
locales (`en`, `tw`, `ga`, `ewe`). A missing key renders the raw path —
tests aren't covering this yet, so eyeball the UI in `en` before pushing.

## Tests

- Unit tests live in `tests/`, colocated-by-folder (`tests/lib/…`).
- Run `npm test` before pushing; CI runs it too.
- Changing a lib function's behavior? Update its test in the same PR — or
  add one if it had none.

## Docs

If your change alters any of these, update the doc in the same PR:

| Change | Doc |
|---|---|
| Structural / architectural decision | new `docs/adr/ADR-###-*.md` |
| Auth, scope, uploads, keys | `docs/security/*.md` + `docs/SECURITY_AUDIT.md` if it fixes a finding |
| Schema relationships | `docs/data-model.md` |
| Commands, env vars, deploy steps | `docs/deployment.md`, `docs/testing.md` |
| System shape | `docs/architecture.md` |

## Review expectations

- Small PRs (< ~400 lines of real change) get reviewed same-day.
- Reviews check: correctness first, security second, taste third. Style
  nits are the linter's job.
- One approval to merge to `main`; the author never self-approves
  security-sensitive changes.
