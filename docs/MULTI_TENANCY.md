# Multi-Tenancy Design

Status: Phase 0 | Related: ADR-004, ADR-005, AUTHORIZATION.md, DATABASE_DESIGN.md

## 1. What is a tenant?

**A tenant = a School** (the commercial and data-isolation unit).

- **School** → tenant. Owns all operational data; has `tenant_id` on every tenant-owned row.
- **Campus** → *sub-tenant scope within a school* (organizational unit). Not an isolation boundary between commercial customers; campuses are filtered by `campus_id` for UX/scoping and reports, but isolation guarantee is at school level. Cross-campus access is permitted for roles that hold the permission at school scope (e.g., principal), denied for campus-limited roles via scope checks.
- **Platform** → not a tenant; a global administrative scope (`t:platform`) with its own tables (`plt_*`).

Multi-campus schools share data under one RLS policy because they are one customer/tenant.

## 2. Identity relationships

```text
Platform (global)
   └── School (tenant) ── Campus (org unit)
          │
          └── Membership (user_id, school_id, status)
                  └── MembershipRole (membership_id, role_id)
                          └── Role ── RolePermission ── Permission (code-defined)

User (global: id, email unique, password/SSO credentials)  ← authentication identity
UserProfile (display name, avatar, contact)               ← profile, separate table
```

- **Users are globally unique** (unique lowercased email). One user → many memberships (schools).
- A **membership** is the unit that grants tenant access; removing it revokes all tenant capability.
- **Platform admins** hold platform-scope roles; they access tenant data only through explicit platform tooling (support views with audit), not by silently joining memberships. Optional "controlled impersonation" (if ever built) must be session-flagged + audited.
- Tenant-scoped principals without portal accounts (most students, some guardians) exist as tenant records; when a portal account is needed, a `users` row is created/linked and connected via a link table — never as a second credential store.

## 3. Tenant context establishment

1. **Request arrives** with subdomain (`acme.app.com`) or `X-Tenant-Id` header, or path-scoped session (single-app portals send cookie + header).
2. Auth middleware authenticates the session → `userId`.
3. Tenant resolver maps host/header → `tenantId`.
4. Load memberships for user; select the membership for `tenantId`; if none → **403 tenant access denied** (never 404-leak; see API_DESIGN §errors).
5. Session stores `activeMembershipId`; switching schools issues a new session/`activeTenantId` claim.
6. Platform routes (`/platform`) require a platform-scope role claim.

**Validation rules:** UUID format → tenant exists → tenant status not `suspended/deleted` → membership status `active` → roles loaded → permission checked per route.

## 4. Tenant context propagation

| Hop | Mechanism |
|---|---|
| HTTP handler | `TenantContext { tenantId, campusId?, membershipId, userId, roleIds, permissions }` object created once, passed explicitly (never module-global mutable state) |
| Database | Each unit of work runs inside `BEGIN; SET LOCAL app.tenant_id=…; SET LOCAL app.user_id=…; SET LOCAL app.role_ids=…;` — RLS reads these GUCs |
| Background job | Job payload includes `tenantId` + `actorUserId` (nullable for system jobs); worker wraps every DB access in the same `SET LOCAL` protocol using a system role |
| Cache | Redis key prefix `t:{tenantId}:…`; platform keys `t:platform:…`; a cache helper *requires* tenant argument (type-level: `cache.get(ctx, key)` fails to compile without ctx) |
| Files | Object key prefix `tenants/{tenantId}/`; presigned URL generation takes ctx and embeds the key; download API re-checks DB ownership before signing |
| Logs | AsyncLocalStorage holds request/job context; logger automatically attaches `tenantId`, `userId`, `requestId`, `jobId` |

## 5. Database-layer enforcement (primary control)

Every tenant-owned table:

```sql
tenant_id UUID NOT NULL REFERENCES tenants(id)
-- + RLS enabled
ALTER TABLE stu_students ENABLE ROW LEVEL SECURITY;
ALTER TABLE stu_students FORCE ROW LEVEL SECURITY;  -- owner/postgres also filtered
CREATE POLICY tenant_isolation ON stu_students
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
```

Rules:
- `FORCE ROW LEVEL SECURITY` on all tenant tables so even superuser-owned app connections are filtered unless they set a context.
- Application connects as a non-superuser role `app_rw` that **cannot bypass RLS** (`BYPASSRLS` denied, not owner of tables — owner is `migrator` role).
- Platform tables (`plt_*`) use a separate policy keyed on `current_setting('app.platform_access', 'true') = 'on'` set only by platform routes.
- Migrations run as `migrator` (table owner, can alter policies); runtime as `app_rw`.
- Helper in `packages/db` forces every query through `withTenant(ctx, tx => …)` — API refuses ad-hoc pool queries without context (lint rule + code review).
- RLS + `SET LOCAL` is PgBouncer-transaction-pooling safe.

Defense-in-depth layers: (1) route permission, (2) repository requires ctx, (3) SQL always filters `tenant_id` via RLS, (4) composite indexes start with `tenant_id`, (5) tests attempt cross-tenant access expecting failure.

## 6. Enforcement at API layer

- No endpoint accepts `tenantId` from body to scope reads; tenant comes only from authenticated context.
- Object access pattern: `GET /api/v1/students/:id` → RLS restricts to tenant; missing row → 404 (same shape as "doesn't exist" — prevents cross-tenant existence probing).
- Bulk endpoints validate all IDs belong to tenant in one query.
- Campus-scoped roles: additional `campus_id` check in service layer for rows carrying `campus_id` (RLS remains school-level).

## 7. Background jobs

- Job data: `{ tenantId, actorUserId?, idempotencyKey, payload }`.
- Worker acquires a dedicated DB client per job, `SET LOCAL app.tenant_id`, runs work, releases.
- Platform jobs (billing dunning across tenants) run per-tenant child jobs — never one query looping all tenants without per-tenant context.
- Queue names may be shared; **job payloads are tenant-tagged**; metrics/labels include tenant.

## 8. Files

Covered in FILE_STORAGE.md — key namespace + metadata row has `tenant_id NOT NULL` + RLS; presigned URLs short-lived; no listing APIs without tenant filter.

## 9. Cache isolation

- Key scheme: `t:{tenantId}:{entity}:{id}` and `t:{tenantId}:list:{hash}`.
- Never cache cross-tenant result sets in tenant-prefixed keys; platform-wide caches use `t:platform:` and must never contain tenant row data (only counts/health).
- Cache stampede protection uses per-key locks also tenant-prefixed.

## 10. Logs & observability isolation

- Structured JSON logs include `tenantId`; log-based metrics segmented by tenant.
- Error tracking (Sentry-style) tags events with tenant; scrub PII per SECURITY.md.
- Cross-tenant data must never appear in a single log line or trace span attributes beyond IDs (no payloads with personal data in logs).

## 11. Edge cases

| Case | Handling |
|---|---|
| User in schools A, B | Session pinned to active tenant; header/host must match active tenant else 409/redirect to switcher |
| Suspended subscription | Tenant context still resolvable; entitlement middleware returns 402/`subscription_required` for non-grace features (BILLING_DESIGN) |
| Deleted school | Rows soft-deleted (`tenants.status=deleting`); async purge job; RLS still active; login → 403 |
| Platform support access | Dedicated platform routes with reason capture + audit; no shared sessions |
| Superuser/migrator | Not used at runtime; break-glass procedure documented in DEPLOYMENT.md with audit |
| Tenant UUID guessing | IDs are UUIDv7; even so, RLS makes cross-tenant GET return 404 |

## 12. Isolation test mandate

`tests/tenant-isolation/` — for **every** tenant table, automated test: seed tenant A and B, query as A's context (expect only A's rows), attempt update/delete of B's row (expect 0 rows affected), raw SQL without context (expect 0 rows). Generated from schema metadata so new tables are auto-covered (see TESTING_STRATEGY.md).
