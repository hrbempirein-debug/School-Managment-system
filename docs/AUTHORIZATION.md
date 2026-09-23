# Authorization (RBAC) Design

Status: Phase 0 | Related: ADR-006, MULTI_TENANCY.md, API_DESIGN.md

## 1. Concepts (kept strictly separate)

| Concept | Storage | Notes |
|---|---|---|
| Authentication identity | `auth_identities` (user_id, provider, credential) | password hash, MFA secrets, OAuth subject |
| User profile | `users` (global id, email, display fields) | no roles, no tenant |
| Tenant membership | `memberships` (user_id, school_id, status, campus_scope?) | grants presence in tenant |
| Role | `roles` (id, scope: 'tenant'\|'platform', name, permissions snapshot?) | DB-defined per scope |
| Permission | **code catalog** in `packages/rbac/src/permissions.ts` | strings like `students.read` |
| Assignment | `membership_roles`, `platform_role_assignments` | many-to-many |

Never store permissions only in JWTs; session caches roles with invalidation on change.

## 2. Permission catalog

Format: `module.action` (lowercase, dot). Actions from a fixed vocabulary: `read | create | update | delete | manage | publish | collect | refund | approve | export | grade | …`

Core sets (grows per phase; single source of truth file, exported as `ALL_PERMISSIONS`):

```text
platform.schools.read|create|update|suspend
platform.plans.manage
platform.billing.read
platform.audit.read

school.settings.manage      school.branding.manage
academic.years.manage      academic.timetable.manage
students.read|create|update|delete|export
guardians.read|create|update
enrollment.read|manage
attendance.read|mark|approve_leave
exams.read|create|grade|publish|correct
fees.structures.manage
fees.invoices.read|create|void
fees.payments.collect|refund|read
reports.financial.read
hr.employees.read|create|update
hr.payroll.process|read_payslip|read_all_payslips
library.manage|loans.manage
transport.manage
communication.send|announce
users.invite|roles.manage      (tenant user admin)
audit.read
ai.assist.use
files.read|manage
```

Platform namespace (`platform.*`) vs tenant namespace — a tenant role can never grant `platform.*`.

## 3. Roles

- **Platform seeded roles:** `platform_admin`, `platform_support` (read-only + ticketed access), `platform_billing`.
- **Tenant seeded roles (template on school creation):** `school_owner` (school admin), `principal`, `teacher`, `accountant`, `hr_officer`, `librarian`, `transport_manager`, `parent`, `student`, `campus_coordinator`.
- Roles are rows: admins can duplicate and edit permission sets (grant any subset of the catalog — **cannot grant permissions outside catalog or platform scope**).
- `roles.scope` distinguishes namespaces; `roles.tenant_id` NULL for platform/global templates, NOT NULL for tenant-custom roles.

Seeds defined in code (`packages/rbac/src/roleTemplates.ts`) so new installs get updates; tenant-edited roles persist in DB.

## 4. Campus scoping

Membership or role-assignment row may carry `campus_id` (nullable):
- `NULL` → school-wide scope.
- Set → permission checks additionally require the resource's `campus_id` to match (service-layer check; RLS stays school-level).

## 5. Authorization evaluation (exact order)

For each request after authentication:

1. **Route declares** required permission + scope: e.g. `{ permission: 'students.create', scope: 'tenant' }`.
2. Load actor: `{ userId, tenantId, membershipId, roleIds, permissions: Set<string>, campusId? }` (cached 60s in Redis `t:{tenant}:perm:{userId}`, invalidated on role change).
3. **Membership gate:** tenant active? membership active? else 403/401.
4. **Entitlement gate:** feature enabled by subscription? (second gate, see BILLING_DESIGN) else 402.
5. **Permission check:** `actor.permissions.has(required)`; deny → 403 `forbidden` with `requiredPermission` in error meta (safe to expose).
6. **Scope check:** campus scope + resource ownership via RLS.
7. Handler executes; sensitive actions write audit entries.

Denied-by-default: routes without explicit permission declaration fail startup validation (API boot asserts every route has auth metadata).

## 6. Platform access to tenant data

- Platform routes live under `/api/v1/platform/…`, require platform permission, and run under a **signed platform ticket** (minted by `app_ctx_mint('platform', …)` only when the actor has a real `platform_role_assignments` row; see DECISIONS ADR-014) — the legacy `app.platform_access=on` GUC was forgeable and is retired. Platform actions require `reason` (ticket id) body/header → audit `platform.access.grant`.
- Platform staff cannot use tenant portals with platform roles (separate session claim).

## 7. Session & token model

- Browser: httpOnly, Secure, SameSite=Lax cookie `sid`; server-side session in Redis (`sess:{sid}` → userId, activeTenantId, memberships version); CSRF: double-submit token for state-changing requests + SameSite.
- JWT not used for tenant portal sessions (revocation immediacy). Optional opaque Bearer tokens (`auth_tokens`) for integrations with scopes subset of permissions + expiry.
- MFA (Phase 1): TOTP; step-up required for `fees.refund`, `users.roles.manage`, `platform.*`.

## 8. Permission change propagation

`roles` updated → bump `membership_roles.updated_at`; cache key includes version; sessions validate version lazily (≤60s staleness accepted, documented). Removing role → immediate 403 on next check.

## 9. Testing obligations

- Unit: `can()` truth table.
- Integration: each route's declared permission enforced (fuzz: user with unrelated role gets 403).
- Cross-tenant: member of B with same role name cannot read A (tenant isolation suite).
- Platform boundary: tenant admin cannot call `/platform/*`.
