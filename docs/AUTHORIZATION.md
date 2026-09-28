# Authorization (RBAC) Design

Status: Phase 2B.3 (school-domain foundation) | Related: ADR-006, MULTI_TENANCY.md, API_DESIGN.md, DATABASE_DESIGN.md

## 1. Concepts (kept strictly separate)

| Concept | Storage | Notes |
|---|---|---|
| Authentication identity | `auth_identities` (user_id, provider, credential) | password hash, MFA secrets, OAuth subject |
| User profile | `users` (global id, email, display fields) | no roles, no tenant |
| Tenant membership | `memberships` (user_id, school_id, status, campus_scope?) | grants presence in tenant |
| Role | `roles` (id, scope: 'tenant'\|'platform', name, permissions snapshot?) | DB-defined per scope |
| Permission | **code catalog** in `packages/permissions/src/permissions.ts` | strings like `students.read` |
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
exams.read|manage|mark|publish|correct
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

**Phase 2B.2 implementation (gate):** every route carries `config.authorization` = `{ kind: 'public'|'authenticated'|'tenant'|'platform', permission?: <catalog names>, devOnly? }`. The `authorizationGate` (`apps/api/src/plugins/authorization.ts`) registers an `onRoute` hook that captures and validates every route's contract at registration time (missing contract, unknown permission, scope/permission mismatch, or gate/handler mismatch => boot fails), re-validates on `onReady`, refuses an empty route inventory, and exposes `app.routeAuthorizationMatrix()` for audit. Enforcement uses the existing tagged gates (`session`, `tenantContext`/`platformContext`, `requirePermission`) so declared contracts always match the running pre-handler chain. Fastify-exposed `HEAD` twins inherit their `GET` contract. Fail-fast boot: `buildApp()` awaits `app.ready()`.

## 6. Platform access to tenant data

- Platform routes live under `/api/v1/platform/…`, require platform permission, and run under a **signed platform ticket** (minted by `app_ctx_mint('platform', …)` only when the actor has a real `platform_role_assignments` row; see DECISIONS ADR-014) — the legacy `app.platform_access=on` GUC was forgeable and is retired. Platform actions require `reason` (ticket id) body/header → audit `platform.access.grant`.
- Platform staff cannot use tenant portals with platform roles (separate session claim).

## 7. Session & token model

- Browser: httpOnly, Secure, SameSite=Lax cookie `sid`; server-side session in Redis (`sess:{sid}` → userId, activeTenantId, memberships version); CSRF: double-submit token for state-changing requests + SameSite.
- JWT not used for tenant portal sessions (revocation immediacy). Optional opaque Bearer tokens (`auth_tokens`) for integrations with scopes subset of permissions + expiry.
- MFA (Phase 1): TOTP; step-up required for `fees.refund`, `users.roles.manage`, `platform.*`.

## 8. Permission change propagation

`roles` updated → bump `membership_roles.updated_at`; cache key includes version; sessions validate version lazily (≤60s staleness accepted, documented). Removing role → immediate 403 on next check.

## Phase 2B.3 school domains

The tenant scope of the catalog (§2) is wired to the eight school-domain foundations: `campuses`,
`academic_years`, `academic_terms`, `calendars`, `calendar_events`, `holidays`, `departments` and
`school_settings`. Contracts (decided, test-pinned):

- **Holidays** are deliberately gated on `calendar.read` / `calendar.write` (they share the school
  calendar domain; no separate `holidays.*` permission).
- **School settings**: both GET and PATCH are gated on `school.settings.manage` — the single combined
  flag (principal/teacher have no gate; only `school_owner` template) by design.
- **Campuses**: create → `campus.create`; update/activate/deactivate → `campus.update`.
- Years/terms/calendars/departments use `.read` / `.write` pairs; `school_owner` template grants the
  full school set (see `packages/permissions/src/permissions.ts`).
- **`campus_id` is NOT yet an authz boundary** in 2B.3: values are stored and validated, but scoping
  stays school-level (RLS `tenant_id`); the campus-scoped membership pattern in §4 is deferred.
- **Idempotency:** mutating routes honour `Idempotency-Key` (package `@sms/idempotency`).
  A replay under the same key returns the **stored** status and body verbatim (e.g. a replayed create
  returns `201`, not `200`) and never re-executes; keys are tenant-scoped, so the same key in another
  tenant legitimately creates a separate row (proven by the HTTP suite).

Route contracts are enforced by the same `authorizationGate` boot validation as §5; the post-boot
matrix (`app.routeAuthorizationMatrix()`) now includes every Phase 2B.3 primary route plus its
Fastify-registered `HEAD` twin. Enforcement is proven end-to-end in
`apps/api/src/security/school-domain.test.ts` (real app + real dev DB + live Redis).

## Phase 4.2 academics & catalog (grade levels, subjects, class-subject links, teacher assignments)

Phase 4.2 lands the academic catalog and teacher scoping on the same RBAC core.

- **12 new permissions** (catalog): `grade.levels.read/create/update/delete`, `subjects.read/create/update/delete`, `class.subjects.read/manage`, `teacher.assignments.read/manage`. Concise `manage` split keeps links/assignments distinct from the CRUD domains; there is no separate `teachers.*` permission — teacher *identity* is membership-derived.
- **Role templates** (`packages/permissions/src/permissions.ts`, `ROLE_TEMPLATES`): `school_owner` gains all 12 (full tenure of the catalog + class-subject + teacher-assignment management); `principal` gains the 4 read-only (`grade.levels.read`, `subjects.read`, `class.subjects.read`, `teacher.assignments.read`). The existing tenant `teacher` template (code `teacher`, scope `tenant`) is reused verbatim; `createTenantTransaction` already seeds it, so no new role is introduced.
- **Teacher identity = membership + role**, not a table: an eligible teacher is an ACTIVE tenant membership carrying the tenant-scoped `teacher` role. API routes that need to *name* teachers (`GET /api/v1/teachers`, and the directory used by assignment UIs) do **not** join `user_profiles` directly — `user_profiles` is self-visible only (policy §2). Names come through `app_safe_user_display(user_id, tenant_id)`, a controlled SECURITY DEFINER helper (migration 0010) that returns the display name only when BOTH the calling user and the target user hold an ACTIVE membership in that tenant, so a tenant-scoped session cannot exfiltrate another tenant's members.
- **Route gating** (`authorizationGate`): every route carries `config.authorization`; GET twins (`HEAD`) inherit the contract. Campus scoping (§4) is asserted at the **class** level for class-subject and teacher-assignment routes (member pinned to campus A cannot attach/assign to a campus B class → `403 campus_scope_denied`; reads also 403).
- **Special-case gates:** `grade_level_id` on class create is a create-only field — the class update schema rejects it with `validation_error` (correcting it later is an explicit contract decision); grade-level/subject `activate`/`deactivate` and delete map to the `.update`/`.delete` permissions.
- **Idempotency + CSRF** apply to every mutating Phase 4.2 route exactly as in earlier phases; conflict mapping (409 `teacher_not_active`, `teacher_already_assigned`, `class_subject_already_linked`, `class_subject_has_teachers`, `grade_level_code_taken`, `subject_code_taken`, `grade_level_has_classes`, `subject_has_class_links`, `class_has_subject_links`, …) lives in `apps/api/src/routes/school/util.ts`.

HTTP proofs: `apps/api/src/security/phase4-2-acceptance.test.ts` (30 tests, real app + real dev DB + live Redis) — catalog CRUD + guards + idempotent replays; class-subject attach/detach incl. campus 403 and detach-blocked-while-teachers-409; teacher assign/unassign incl. duplicate 409, non-attached-subject 404, suspended/no-role 409, cross-campus 403, assigment listing; the teacher directory (eligible only, names resolved via the helper); principal read-only RBAC (12 permission checks against the templates). Pairs with the DB-level suite `packages/db/src/security/phase4-2-academics.test.ts` (32 checks, sections A/B/C) and the route-inventory contract in `apps/api/src/security/authorization.test.ts`.

## Phase 4.3 timetable (periods, weekly grid, publish) & homework

Phase 4.3 builds on the Phase 4.2 catalog: the teacher-assignment rows created there become the *authorship/persona* that the timetable and homework servers pin to, keeping the RBAC core unchanged.

- **7 new permissions** (catalog): `timetable.read`, `timetable.manage`, `timetable.publish`, `homework.read`, `homework.create`, `homework.update`, `homework.delete`. `timetable.manage` covers the bell set (`periods.*`) and the grid cells (`timetable.entries`); `timetable.publish` is deliberately a separate gate so publishing remains an explicit, audited action. Homework keeps the 4-way CRUD split (`homework.*`).
- **Role templates** (`ROLE_TEMPLATES`): `school_owner` gains all 7 (full tenure); `principal` gains the 2 read-only (`timetable.read`, `homework.read` — still no mutator); `teacher` gains `timetable.read` + `homework.read/create/update/delete` (a teacher never gets `timetable.manage`/`timetable.publish`); `parent` and `student` gain `homework.read` only (portal visibility). No new role codes are introduced — the seeded templates are the delivery vehicle.
- **Server-derived identity, never client-writable:** grid cell `teacherUserId` is copied from the LIVE `teacher_assignment` of (class, subject) — the create schema is `.strict()` and a client-supplied `teacherUserId` is rejected with `validation_error`. Homework authorship is anchored the same way: a `teacher` caller records `teacherUserId = self` (the DB trigger then refuses a subject they don't teach → 409 `homework_teacher_not_assigned`), while an `school_owner`/`principal` caller authors *on the class behalf* and `teacherUserId` resolves to the assigned lead teacher — so the recorded author is always the real teacher.
- **Row-level result scoping for holders of `homework.read`** (the permission alone only unlocks the route; which rows are reachable is decided per request by `tenantRoleCodes`): `school_owner`/`principal` → every live row; `teacher` → rows they authored (SQL condition + detail 404 so colleagues' homework is not observable); `parent` → classes of their linked students (guardians → student_guardians → students → live enrollments; unlinked classes are empty/404); `student` → classes of the caller's own link (`students.user_id` → live enrollments; unlinked student accounts and any other holder resolve to nothing). Narrowings are 404 (never 403) to hide existence.
- **Teacher self-scope on mutation:** `homework.update`/`delete` as a teacher refuses rows authored by another teacher with 403 `homework_scope_denied`; owner/principal mutate freely.
- **Publish validation:** `POST /api/v1/timetable/publish` re-scans every LIVE entry tenant-wide (raw self-join over `timetable_entries × periods` with `tstzrange` overlap). Zero conflicts → `200 {published:true, conflicts:[]}` + audit + `timetable.published` event; conflicts → `200 {published:false, conflicts:[{weekday, teacherUserId, entryCount}]}` and **no** event. Because the DB trigger already refuses teacher double-bookings, a conflict row can only reach the scan via a privileged write — the path is defense-in-depth and is proven in the acceptance suite by seeding one row with the trigger disabled.
- **Campus scoping (§4)** asserted at the class level on every timetable/homework route (pinned member is denied cross-campus with 403 `campus_scope_denied`), and on periods: a tenant-wide (campus-less) bell set is a school-wide resource — a campus-pinned membership is denied creating it.
- **Conflict mapping** (409) — same families as Phase 4.2, in `util.ts`: `period_no_taken`, `period_time_overlap`, `period_has_entries`, `timetable_slot_conflict`, `teacher_double_booked`, `section_has_timetable`, `subject_has_schedule`, `subject_has_homework`, `class_has_timetable`, `class_has_homework`, `assignment_has_schedule`, `homework_subject_not_in_class`, `homework_teacher_not_assigned`, `homework_attachment_duplicate`. Idempotency + CSRF apply to every mutating route as before.

HTTP proofs: `apps/api/src/security/phase4-3-acceptance.test.ts` (38 tests, real app + real DB + live Redis) — period CRUD + `period_no_taken`/`period_time_overlap` 409s; grid cell with server-derived teacher + mass-assignment rejection; `timetable_slot_conflict`/`teacher_double_booked` 409s (insert AND re-checked on move); publish clean 200 (audit + event) and defense-in-depth conflict branch seeded via trigger-disable (200 `published:false`, grouped conflicts, zero events); section/period delete guards surfaced as 409; homework authorship (self + owner delegation), `homework_teacher_not_assigned` 409, `homework_scope_denied` 403, parent/student/teacher visibility + 404 hiding, idempotent replays, and the permission-template assertions (school_owner 7, principal 2, teacher 5, parent+student 2 combined). Pairs with `packages/db/src/security/phase4-3-timetable.test.ts` (18 DB checks incl. RLS, anchors, exclusion, and the `class_has_timetable` dominance note).

## Phase 4.4 homework portals (parent/student read-only views)

Phase 4.4 finalizes the homework story by closing the one documented gap from Phase 4.3 — the student portal had no way to map a portal user to a student record. It reuses the Phase 4.3 RBAC core unchanged: **no new permissions, no new role templates, no new worker events.**

- **Student portal identity (migration 0013).** `students.user_id` is nullable and unlinked by default; the composite tenant-aware FK `students(tenant_id, user_id) → memberships(tenant_id, user_id)` (anchored on `memberships_tenant_user_uq` from 0009) makes a cross-tenant link impossible, and the SECURITY INVOKER trigger `trg_students_user_link_validate_biu` rejects any target that is not an ACTIVE membership in the student's own tenant (`55000` → 409 `student_link_requires_membership`). One LIVE student per portal user per tenant is pinned by the partial unique index `students_tenant_user_uq` (`23505` → 409 `student_user_already_linked`, with soft-deleted history free to keep its link). The trigger fires on INSERT **and** `UPDATE OF user_id`; unlinking is `NULL`.
- **Linking is an explicit, gated admin act — no new permission.** The existing `PATCH /api/v1/students/:id` (`students.update`, i.e. owner-tier) can now accept `userId: <uuid>` to link or `userId: null` to clear, via the strict `updateStudentRequestSchema` (a stray internal field is still 400 `validation_error`). Campus scoping (§4) still applies, as does audit (`student.updated`) + idempotency. A suspended membership linked earlier simply deactivates the portal afterwards, because every portal/resolver path derives role codes from **active** memberships only (`tenantRoleCodes`).
- **Self-scoped read restoration.** The Phase 4.3 class homework routes now resolve a `student` caller through their own link (the `parent` chain is unchanged); unlinked students and other `homework.read` holders still see empty lists + 404, preserving Row-level anti-observability from §8 (the existing Phase 4.3 acceptance suite continues to pass unchanged).
- **`GET /api/v1/me/homework-context`** (`homework.read`, tenant gate). Returns `{ role: staff|teacher|parent|student|none, classes: [{id, code, name, campusId, academicYearId}] }` mirroring the per-class visibility exactly, so a portal can never advertise a class the caller cannot read. `staff` = every LIVE class (narrowed to the member's campus when campus-pinned), `teacher` = classes they teach, `parent`/`student` = guardian/own live-enrollment classes, `none` = empty. An unlinked parent/student gets an honest empty list.
- **Frontend portals.** Read-only server-component entries at `/parent/homework` and `/student/homework` render only `homework.read`-sourced data (context + per-class lists; they never call `classes`/`subjects` endpoints the portal roles lack). Delivery is via direct portal routes — the shared permission-driven school nav is intentionally untouched (portal roles would otherwise see staff module tiles they cannot use).

HTTP proofs: `apps/api/src/security/phase4-4-homework-portals.acceptance.test.ts` (real app + real DB + live Redis) — 401 unauthenticated, 403 + `requiredPermission` for a member without `homework.read`, bare holder → `role:"none"`, staff/teacher/parent/student/campus-scoped context resolution, owner linking via PATCH (audit), parent/teacher link denied (403), no-membership/cross-tenant/suspended targets → 409 `student_link_requires_membership`, second live student → 409 `student_user_already_linked`, cross-campus link/patch → 403 `campus_scope_denied`, unlink via `userId:null`, strict mass-assignment rejection, linked-student visibility + 404 hiding, and teacher-scope regression. Pairs with `packages/db/src/security/phase4-4-student-portal.test.ts` (linkage constraints, partial-unique lifecycle, RLS erasure under the runtime role).

## 9. Testing obligations

- Unit: `can()` truth table.
- Integration: each route's declared permission enforced (fuzz: user with unrelated role gets 403).
- Cross-tenant: member of B with same role name cannot read A (tenant isolation suite).
- Platform boundary: tenant admin cannot call `/platform/*`.
- Phase 2B.2 HTTP proofs (`apps/api/src/security/authorization.test.ts`, real app + real DB): anonymous 401 on authenticated/tenant endpoints; member without permission 403 with `requiredPermission`; `school_owner` with `audit.read` reaches `/audit`; platform-only operator denied tenant endpoints (403 `Tenant access denied`); tenant member denied `/platform/*`; cross-tenant object access 404; CSRF enforced; Phase 2B catalog visible via `/api/v1/permissions`.
- Phase 2B.3 HTTP proofs (`apps/api/src/security/school-domain.test.ts`): full matrix coverage of the 8 domains with `HEAD` twins; parent (unpermissioned member) gets 403 + `requiredPermission`; CSRF 403 on every state change; owner CRUD across all domains writes audit + outbox; idempotent replay (stored status, no duplicate) and cross-tenant key isolation; domain-rule mapping (409 conflict / `academic_year_has_open_terms`, `overlapping_open_terms`, `term_outside_academic_year` …; 404 for foreign/unknown objects); settings singleton get-or-create + manage gate. Pairs with the DB-level suite `packages/db/src/security/school-domain.test.ts` (RLS 8 tables, FORCE, privileged-only DELETE, 22 checks) and the 2B.1 trust/impersonation/token-scope boundary suites.
