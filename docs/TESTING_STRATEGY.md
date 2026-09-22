# Testing Strategy

Status: Phase 0 | Principle: tests gate merges; tenant isolation and finance get the strictest coverage.

## 1. Test pyramid

```text
E2E (Playwright, thin)          — critical journeys per phase
API integration (PG+Redis)      — majority of confidence
Module unit tests               — pure domain logic
```

Tooling (Phase 1 exact pinning): Vitest (unit + integration), Testcontainers **or** dedicated PG/Redis test databases (REQUIRES USER ACTION: Docker not verified in current env — fallback: local PG/Redis with `test_*` databases and truncate-between-tests; decide in Phase 1), Playwright for e2e.

## 2. Unit tests

- Domain state machines (subscription transitions, invoice status, grade calc), permission `can()` truth table, money math (numeric), Zod contracts, pagination cursors, idempotency hash logic.
- No DB in unit tests (pure functions).

## 3. Integration tests (API + DB)

- Spin real PostgreSQL (RLS must be real — never mock) + Redis; run migrations; seed fixtures.
- Cover: CRUD happy paths, validation 422s, auth 401, RBAC 403 matrix samples, pagination/filter contracts, idempotency replay (same response), rate limit 429, error envelope shape.
- Every phase adds route tests alongside routes.

## 4. Tenant isolation suite (EXTREMELY CRITICAL)

`tests/tenant-isolation/` — auto-generated from schema registry listing every tenant table:

For each table T:
1. Seed row in tenant A and tenant B (fixtures via raw SQL as migrator, then query as `app_rw`).
2. As tenant A context: `SELECT` → only A's rows.
3. As tenant A: `UPDATE T SET … WHERE id = <B id>` → 0 rows.
4. As tenant A: `DELETE … WHERE id = <B id>` → 0 rows.
5. With **no** tenant GUC set: SELECT → 0 rows (proves RLS default deny).
6. INSERT with foreign `tenant_id=B` while ctx=A → RLS WITH CHECK rejection.

Plus API-level: member of A GET `/students/<B id>` → 404; list never contains B rows; cache helper with A ctx never returns B payload; job run with A ctx cannot read B; file presign for B key denied.

CI fails if a tenant table exists without a registered policy (schema diff check).

## 5. Authorization tests

- Per-route: required permission enforced (build actor with unrelated role → 403).
- Privilege escalation: grantor cannot grant perms they lack (property test).
- Platform boundary: tenant admin → `/platform/*` 403; platform session → tenant portal routes rejected.
- Campus scoping: campus-limited teacher cannot read other campus rows.
- Step-up MFA required paths.

## 6. Financial tests

- Invoice issue freezes lines (UPDATE attempt fails).
- Payment with idempotency key: double POST → one payment, identical response.
- Concurrent payments racing balance (two parallel requests, final `amount_paid` correct, no overpayment beyond cap).
- Refund bounds: refund > refundable rejected at DB trigger level (test as raw SQL too).
- Ledger: every group balanced; direct UPDATE/DELETE on ledger denied.
- Receipt number uniqueness under parallelism (N workers → N distinct nos).
- Webhook replay (same external_id twice) → single settle.
- Golden-path e2e: issue → pay partial → pay rest → receipt; void rules; refund flow.
- Property/randomized: random pay/refund sequences maintain invariants (paid ≤ total, balances = Σ allocations).

## 7. Worker tests

- Idempotent handler double-run → same state.
- Retry: transient error → retries with backoff (fake timers) → success; PermanentJobError → 1 attempt.
- DLQ: exhausting attempts → dead status + metric event.
- Tenant ctx: job without tenantId for tenant job → fail validation; job cannot read other tenant (isolation assertion).
- Outbox: tx rollback → no event; commit → delivered exactly-once-to-handler-with-idempotency.

## 8. API contract tests

- Zod-inferred types ↔ OpenAPI snapshot; response strip verification (no leaking internal fields); error envelope snapshot.
- Breaking-change detection via committed OpenAPI snapshot diff in CI.

## 9. E2E (Playwright)

Per phase one golden journey: login/invite, enroll student, mark attendance, publish results, issue invoice + record payment, admin plan change (Phase 11), AI tool authorization happy/deny (Phase 12). Run against real API+DB+web in CI (or staging for heavy).

## 10. Security tests

- Automated: dependency audit, gitleaks, injection fuzz on sort/q params, XSS payload storage → render assertions, CSRF missing-token rejection, rate limit tests, file upload type confusion.
- Manual/pre-GA: OWASP ASVS L1, tenant-isolation red-team checklist, external pen test (Phase 13).

## 11. Performance tests (Phase 13; light smoke earlier)

k6 scripts: login, list students @500 concurrent per school scenario, report generation queue depth behavior; RLS index effectiveness (`EXPLAIN` budget for hot queries).

## 12. Coverage policy

- Statements: not a vanity gate; **critical domains (finance, authz, tenancy) require ≥90% line coverage** in their packages; overall ≥70% by Phase 13.
- Mutation testing optional on money math later.

## 13. CI pipeline order

typecheck → lint → unit → build → integration (PG service) → tenant isolation → contract → (main) e2e → deploy staging.
