# Operations — Failure Diagnosis Runbook

How to take a production failure from **symptom → root cause** using only the
artifacts the app already emits. This is the Phase 6 acceptance artifact from
[`ROADMAP.md`](ROADMAP.md): *a simulated production failure can be traced from
request → endpoint → service → database/error without temporary debugging.*

No step here requires adding `console.log`s or redeploying with debug code.

---

## 1. The correlation ID is the entry point

Every request gets an `x-request-id`:

- [src/middleware.ts](../src/middleware.ts) reads a client-supplied
  `x-request-id` or generates one (`newRequestId()` → UUID) and **echoes it on
  every response** — pages and APIs alike.
- Server error logs emitted through `logRouteError(request, msg, error)`
  ([src/lib/logger.ts](../src/lib/logger.ts)) include that same `requestId`,
  plus `method` and `path`.

**So the first move is always the same:** get the `x-request-id` from the
failed response (browser devtools → network → response headers, or a client
SDK error object), then find the matching log line.

```bash
# Docker / container runtime
docker logs <container> 2>&1 | grep '"requestId":"<id>"'

# If logs are piped to a file or collector (JSON-lines, one object per line)
grep '"requestId":"<id>"' /var/log/farmops/*.log
```

If the response has **no** `x-request-id`, the request never reached
middleware — that points at the reverse proxy or a process-level crash, not
application code (see §4).

## 2. Reading a log line

Logs are **JSON lines** on stdout/stderr (`error`/`warn` go to stderr-capable
streams; see `emit()` in [src/lib/logger.ts](../src/lib/logger.ts)):

```json
{"ts":"2026-10-03T09:12:44.118Z","level":"error","msg":"Error creating transaction","requestId":"9f0c…","method":"POST","path":"/api/transactions","error":{"name":"PrismaClientKnownRequestError","message":"…"}}
```

Rules the logger guarantees:

| Guarantee | Meaning |
|---|---|
| One JSON object per line | Greppable, parseable by any log pipeline |
| `ts` is ISO-8601 UTC | Correlate with DB/proxy timestamps |
| Sensitive keys redacted | `password`, `token`, `secret`, `authorization`, `cookie`, `api-key`, `session`, `credential` → `"[redacted]"` — secrets never appear in logs, so you can share log excerpts safely |
| `error` serialized as `{name, message}` | Enough to classify, never a stack leak to clients (clients only ever see a generic 500 body) |

`logger.child({…})` binds extra fields (e.g. farm scope) to every subsequent
line from that logger.

## 3. Health & liveness vs readiness

`GET /api/health` ([src/app/api/health/route.ts](../src/app/api/health/route.ts)):

- **200 `status: "ok"`** — process up **and** database answers `SELECT 1`.
- **503 `status: "degraded"`** — process up, database unreachable; the body's
  `checks.database` says `{"status":"down"}` and an error log line
  (`"Health check failed: database unreachable"`) is emitted.
- Response includes `uptimeSeconds` and per-check `latencyMs`; `Cache-Control:
  no-store` so probes never hit a cache.

Triage from the probe:

| Probe result | Meaning | Go to |
|---|---|---|
| Connection refused / no response | Process or orchestrator problem | §4 |
| 503, `database: down` | DB down, network partition, or bad `DATABASE_URL` | §5 |
| 200 but `database.latencyMs` high | DB is up but slow — pool exhaustion or lock contention | §5 |
| 200, app still errors | Application-layer bug | §6 / §7 |

## 4. No `x-request-id` / process won't start

1. **Container**: `docker ps` (is it restarting? `docker ps -a` shows restart
   loops), then `docker logs <container>` — startup failures are `prisma
   generate`/migrate errors, missing env vars, or port conflicts.
2. **Build-time failures** (`pnpm install --frozen-lockfile`): the lockfile is
   out of sync with `package.json` — regenerate it (`pnpm install
   --lockfile-only`) rather than deleting it. CI runs the same check.
3. **Next.js compile errors** appear in the dev/build log, before any request
   is served — no `x-request-id` exists because middleware never ran.
4. **Proxy layer**: if the app returns an `x-request-id` when hit directly
   (`curl -H 'x-request-id: diag-1' localhost:3000/api/health`) but not through
   the proxy, the proxy is generating the error (TLS, body size, timeout).

## 5. Database failures

**Symptom:** 503 from `/api/health`, or route errors whose `error.name` is a
Prisma error.

Classify by `error.name` / `error.message` in the log line:

| Signature | Cause | Action |
|---|---|---|
| `PrismaClientInitializationError` / health `down` | Can't connect: DB stopped, wrong `DATABASE_URL`, network | `docker ps` → start the DB container; verify URL **without printing it** (check host/port only, e.g. `grep -o 'localhost:[0-9]*' .env`) |
| `P1017` / "server closed the connection" | DB restarted under the app | Restart app; check DB OOM/restarts |
| `P2021` / `P2002` table/column missing | Schema drift — migrations not applied | `npx prisma migrate status` → `npx prisma migrate deploy` (prod) |
| `P2025` (record not found on update/delete) | Row deleted concurrently, or cross-tenant scope filtered it out | Check the `where` clause's farm scoping; re-read with the request ID |
| Timeout / `PoolTimeout` | Pool exhausted — slow queries or traffic spike | Check `database.latencyMs` trend; look for long-running queries: `SELECT pid, state, query_start, query FROM pg_stat_activity WHERE state <> 'idle';` |
| Constraint violation (`CHECK`, `P2003`) | Business-rule violation surfaced as 500 | See §7 — e.g. negative stock is now impossible by CHECK, so this indicates a race the app should map to 409/400 |

Schema changes go through **migrations** (`prisma/migrations/`), never
`db push`, in anything shared. The baseline is `0_init`; adoption on an
existing database is `prisma migrate resolve --applied 0_init` (once), then
normal `migrate deploy`.

## 6. Authentication failures

Decision table (what the client sees → where to look):

| Response | Meaning | Diagnosis |
|---|---|---|
| **401** `{"error":"Authentication required"}` | No/invalid session (`requireAuth`) | Cookie missing/expired: check `authjs.session-token` (or `__Secure-` variant in HTTPS) in the browser; JWT secret changed → all sessions invalidate (see §6a) |
| **403** `{"error":"Insufficient permissions"}` | Authenticated but wrong role/farm (`requireRole`/`requireMinRole`) | Expected boundary — confirm the user's `role`/`farmId` in DB; cross-farm access also returns "not available for your farm"-style errors from guards |
| **307 → `/login`** (page request) | Middleware found no session cookie | Normal; if the user *is* logged in, cookie name/`NEXTAUTH_URL`/domain mismatch |
| **429** + `Retry-After` | Rate limit (`rateLimitResponse`) | In-memory fixed window; counter is **per process** — after a restart it resets. Login throttling: 5 failed attempts / 15 min per IP+account |
| Login rejected, no error detail | `authorize()` returned null | Check for `isActive: false` (unverified email) vs wrong password — both fail closed on purpose; look up the user to distinguish |
| Verification email not received | SMTP failure or throttled | Register/resend responses include `emailSent`; resend is limited (3 per 15 min per email, 6/min per IP). Dev-only `devCode` is returned when `NODE_ENV !== "production"` and sending failed |

**6a. Everyone logged out at once:** `NEXTAUTH_SECRET` was rotated or the
instance switched between dev/prod using different secrets. Sessions are JWTs —
invalidated instantly and non-recoverably by design. Verify the env var is
present and unchanged across deploys; never commit it.

Audit trail: successful mutations write `AuditLog` rows (`writeAuditLog`), so
"who changed this?" is answerable via `GET /api/audit-log` (admin) even when
the HTTP failure itself is gone.

## 7. Stock & inventory operation failures

Every stock mutation flows through [src/lib/stock.ts](../src/lib/stock.ts)
guarded by a DB transaction; the E2E/concurrency guarantees are documented in
[`testing.md`](testing.md).

| Symptom | Where it lands | What it means |
|---|---|---|
| `"Error creating transaction"` (or split/transfer/adjust) + `requestId` in log | Route `catch` → `logRouteError` → 500 | Read the embedded `error`: Prisma class from §5, or a business error that should have been a 4xx |
| `CHECK ("quantityRemaining" >= 0)` violation | Postgres rejects the write | The concurrency invariant held: someone else consumed the stock first. Client should refetch; the transaction rolled back completely (proved by `tests/db/stock-concurrency.test.ts`) |
| 409 / "already processed" with `Idempotent-Replay` | `withIdempotency` | A retry of a request that already succeeded — not an error; the first attempt's result is authoritative |
| 409 conflict / insufficient stock message | Guard check before write | Expected business validation; no data changed |
| Partial update visible (e.g. batch moved but stock unchanged) | — | **Should be impossible** — mutation + stock update share one transaction. If observed: capture `requestId`, then `pg_stat_activity` + app logs; treat as P1 regression and reproduce with `npm run test:db` |

**Rollback verification** (any reported partial write):

```sql
-- recent stock rows for the affected item
SELECT "updatedAt", "quantityRemaining" FROM "InventoryBatch"
WHERE "itemId" = '<id>' ORDER BY "updatedAt" DESC LIMIT 10;
```

If state is consistent but the client showed an error, the failure happened
*before* commit (client/transport) — replaying the same request with the same
`Idempotency-Key` is safe.

## 8. Tracing one failure end-to-end (checklist)

1. **Capture** `x-request-id` + status code from the failed response.
2. **Grep logs** for that `requestId` → you now have `method`, `path`, `msg`,
   `error.name`, `error.message`.
3. **Classify** by the tables above: 401/403/429 (auth/limits §6), Prisma/DB
   (§5), stock/invariant (§7), no ID at all (§4).
4. **Check health** `GET /api/health` — separates "DB is down" from "app is
   buggy" in one call.
5. **Confirm in DB** with the read-only queries above when data state is in
   question.
6. **Audit** for "who did it": `GET /api/audit-log`.

Every step uses information already in the response or the log stream — no
redeployment, no temporary logging, no guessing.

## 9. Known limitations (tracked, not secret)

- **Metrics**: latency per endpoint and authorization-denial counters are not
  yet exported; diagnosis today is log-based (roadmap Phase 6 remaining work).
- **Error monitoring**: no Sentry/OTel sink yet — ship stdout JSON-lines to
  your collector (Docker/K8s does this natively).
- **Rate-limit state is per process**: horizontal scaling needs shared
  infrastructure (`docs/SECURITY_AUDIT.md` SEC-18).
- **Log redaction is key-based**: never pass a raw secret as a *value* under a
  non-sensitive key (e.g. `{"note": "<the actual password>"}` would not be
  caught). Keep secrets out of message strings too.
