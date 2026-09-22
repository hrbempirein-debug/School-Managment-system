# Error Handling

Status: Phase 0 | Related: API_DESIGN.md §6, JOB_ARCHITECTURE.md, TESTING_STRATEGY.md

## 1. Principles

- One error envelope for all API responses (client errors and unexpected).
- Never leak internals (stack, SQL, file paths, tenant existence) to clients.
- Distinguish 401/403/404/409/402 deliberately — 404 also for cross-tenant.
- Fail fast at boundaries (config, contracts); domain errors as typed results where recoverable, exceptions for exceptional paths.
- Workers: classify retryable vs permanent; never retry validation/permission errors.

## 2. HTTP error envelope

```json
{
  "error": {
    "code": "validation_failed",
    "message": "Request validation failed",
    "details": [{ "path": "email", "issue": "invalid_email" }],
    "requestId": "req_01J8...",
    "requiredPermission": null
  }
}
```

`requiredPermission` populated only on 403 when safe (permission names are not secrets per AUTHORIZATION).

## 3. Status × code matrix

| HTTP | code | When |
|---|---|---|
| 400 | `bad_request` | Malformed JSON/URL |
| 401 | `unauthenticated` | No/expired session/token; `mfa_required` step-up missing |
| 402 | `subscription_required` / `usage_limit_exceeded` | Entitlement gate (after authz passed) |
| 403 | `forbidden` | Authenticated but permission/scope denied; platform boundary |
| 404 | `not_found` | Missing OR other tenant (indistinguishable) |
| 405/415 | `method_not_allowed` / `unsupported_media_type` | |
| 409 | `conflict` | State conflicts (already paid, version mismatch); `idempotency_key_reuse`; `tenant_mismatch` (header vs session — safe: both known to client) |
| 413 | `payload_too_large` | Upload limits |
| 422 | `validation_failed` | Zod failures with paths |
| 429 | `rate_limited` | + `Retry-After` |
| 500 | `internal` | Unexpected; message generic; detail only in logs w/ requestId |
| 503 | `service_unavailable` | Dependency outage/maintenance mode |

Domain-specific codes are namespaced strings (`invoice_already_paid`, `refund_exceeds_payment`, `enrollment_duplicate`) mapped from typed domain errors — still same envelope.

## 4. Internal error taxonomy (code)

```ts
AppError
 ├── HttpError(status, code, details)        // thrown by guards
 ├── DomainError(code, meta)                 // business rules: invoice, enrollment
 ├── PermanentJobError                       // worker: no retry
 └── RetryableJobError                       // worker: retry w/ backoff
```

- Fastify error handler converts unknown errors → 500 + logs full stack with requestId; response never includes stack (prod).
- Zod error → 422 formatter maps issues (strip internal keys).
- PG error mapping: unique_violation → 409 with field hint (from constraint name map — no raw constraint text to client); rls/permission → 500 (shouldn't surface to legit users; indicates bug) + alert; deadlock → retry once in tx helper then 500.

## 5. Validation

- All inputs Zod-validated before handler; errors aggregated (all field issues in one 422, cap 20).
- Response validation in dev/test (Zod parse of outgoing body) — disabled prod for perf (sampling optional).

## 6. Partial failures

- Batch endpoints: all-or-nothing by default (single tx) unless `mode=best-effort` documented; best-effort returns `{ succeeded: [], failed: [{id, code}] }` with 207-style body (still 200) — used only for bulk imports Phase 3+.
- Multi-provider fanout (notifications): per-recipient job failures independent; aggregate status job.

## 7. Logging policy for errors

| Level | Use |
|---|---|
| error | 500s, unexpected exceptions, DLQ arrivals, reconciliation drift |
| warn | 4xx except 401/403/404 (those are info/audit), retryable failures |
| info | lifecycle, job completion |
| debug | dev only |

Every 500 log: requestId, traceId, route, tenantId?, userId?, stack, payload digest (not full body).

## 8. Client-side (web)

- Central fetch wrapper: parse envelope; 401 → redirect login (preserve return path); 403 → forbidden screen with permission name; 402 → upgrade CTA (school admin) or soft notice; 422 → field-level form errors; 429 → toast + backoff; 500 → generic error + requestId displayed for support.
- Never render raw `message` as HTML.

## 9. Worker errors

- Handler wraps: catch → classify → throw `RetryableJobError`/`PermanentJobError`.
- Unknown errors default retryable (up to attempts) — safer for transient infra.
- After final attempt: DLQ + `error` log + metric (JOB_ARCHITECTURE §5).
- Outbox dispatcher failures: exponential poll backoff, never drop rows.

## 10. Graceful degradation

- Optional providers (SMS) down → queue retries, portal unaffected.
- Readiness fails on PG/auth-critical Redis only.
- Feature-flagged modules down → routes return 503 `service_unavailable` if disabled at boot.
