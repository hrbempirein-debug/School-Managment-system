# API Design

Status: Phase 0 | Related: ADR-011, AUTHORIZATION.md, ERROR_HANDLING.md

## 1. Base structure

```text
https://api.example.com/api/v1/...        # public REST (portals + integrations)
https://api.example.com/api/v1/platform/...  # platform-scope routes (platform perms only)
https://api.example.com/internal/v1/...   # worker-to-api or ops endpoints, network-restricted
```

- Version in path. Within v1: additive changes only (new optional fields/endpoints). Breaking → v2.
- Resources are plural, kebab-case: `/students`, `/academic-years`, `/fee-invoices`.
- Sub-resources for real hierarchy: `/students/:id/guardians`, `/classes/:id/sections`.

## 2. Endpoint conventions

| Operation | Method + path | Permission example |
|---|---|---|
| List | `GET /students?…` | `students.read` |
| Get one | `GET /students/:id` | `students.read` |
| Create | `POST /students` | `students.create` |
| Update | `PATCH /students/:id` (partial) | `students.update` |
| Replace | `PUT` only for singleton settings (`/school-settings`) | `school.settings.manage` |
| Delete | `DELETE /students/:id` (soft) | `students.delete` |
| Actions | `POST /students/:id/transfer`, `/invoices/:id/void` (verb segment, not PATCH status) | action-specific |
| Nested lists | `GET /students/:id/attendance` | scoped permission |

State changes that are financial/legal always `POST` + `Idempotency-Key`.

Forbidden patterns: `GET` with side effects; accepting `tenantId` in body for scoping; `/api/students` without version; RPC-style `/api/v1/createStudent`.

## 3. Tenant context

- Header `X-Tenant-Id: <uuid>` **or** subdomain-derived tenant; must match session's active tenant (mismatch → 409 `tenant_mismatch`).
- Platform routes: no tenant header; platform session claim required.
- List/get endpoints never accept tenant as query param.

## 4. Authentication & CSRF

- Cookie `sid` (httpOnly, Secure, SameSite=Lax) for portals; `Authorization: Bearer <opaque>` for machine clients.
- State-changing cookie requests require `X-CSRF-Token` matching double-submit cookie.
- 401 `unauthenticated`; 403 `forbidden`; 402 `subscription_required` (entitlement); 409 conflicts; 422 validation.

## 5. Validation

- Zod schema per endpoint from `packages/contracts`; compiled to JSON Schema for OpenAPI generation (`/openapi.json`).
- Request: unknown keys stripped or rejected (`strict` on PATCH? → reject unknown in body by default).
- Response: **exactly** contract shape in production (strip internal fields); `requestId` always present.

## 6. Error format (all endpoints)

```json
{
  "error": {
    "code": "validation_failed",
    "message": "Human readable, no internals",
    "details": [{ "path": "email", "issue": "invalid_email" }],
    "requestId": "req_01J...",
    "requiredPermission": null
  }
}
```

Codes: `unauthenticated, forbidden, tenant_mismatch, not_found, validation_failed, conflict, idempotency_key_reuse, rate_limited, subscription_required, internal`. Full matrix in ERROR_HANDLING.md. Cross-tenant access → `not_found` (identical to nonexistent id).

## 7. Pagination, filtering, sorting, search

- Lists default `limit=25`, max `100`; **cursor** pagination `?cursor=<opaque>&limit=`; response `{ data: [...], page: { nextCursor, hasMore, limit } }`. Offset pagination allowed only for exports (with cap).
- Filters: `?status=active&campusId=…&createdFrom=…&createdTo=…` — typed per endpoint; equality + `in` (comma) + range for dates.
- Multi-sort: `?sort=lastName:asc,createdAt:desc` — sortable fields whitelisted per endpoint (no arbitrary column sort → no SQLi surface).
- Search: `?q=` runs endpoint-defined indexed search (trigram/FTS per module); never raw SQL string interpolation.
- Compound example: `GET /api/v1/students?status=active&classId=…&q=ahmed&sort=rollNo:asc&limit=50&cursor=…`

## 8. Idempotency

- Header `Idempotency-Key: <uuid>` on POSTs (required: payments, refunds, invoice issuance, payroll posting; optional elsewhere).
- Server stores (`tenant_id`, key) → request hash + response for 24h: same key + same hash → replay stored response; same key + different hash → 409 `idempotency_key_reuse`.
- Concurrent duplicate → second request waits/polls or 409 (documented per endpoint; finance endpoints: 409 after 2s wait).

## 9. Rate limiting

- Per IP + per session + per tenant token buckets (Redis); headers `RateLimit-Limit/Remaining/Reset`; 429 `rate_limited` with `Retry-After`.
- Stricter buckets: auth endpoints (login/reset), AI endpoints, payment creation.

## 10. Request/trace identity

- `X-Request-Id` honored (validated format) or generated; echoed in response header + error body.
- W3C `traceparent` propagated when present; logs/metrics/traces correlate.

## 11. File transfer

- Upload: `POST /files/init` → authorized presigned PUT URL + `fileId`; finalize `POST /files/:id/complete` (verify, scan enqueue).
- Download: `GET /files/:id` → 302 to presigned GET (or streamed server-side for watermarked docs).

## 12. Webhooks (platform outbound, later)

Signed (`X-Signature: HMAC-SHA256`, timestamp + replay window), per-endpoint secret, at-least-once with event ids.

## 13. OpenAPI

Generated at build from Zod contracts; published at `/openapi.json`; contract tests assert snapshot stability (TESTING_STRATEGY.md).
