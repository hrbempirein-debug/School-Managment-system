# PHASE 4.4 IMPLEMENTATION + SECURITY AUDIT REPORT

Phase 4.4 (finalization of the Phase 4 homework/portal story) delivered the student-portal identity and the parent/student read-only homework portals on top of the Phase 4.2/4.3 RBAC core, **with no new permissions, no new role templates, and no new worker events**.

## Deliverables

| Pillar | What shipped | Files |
| --- | --- | --- |
| DB schema (migration 0013) | `students.user_id` (nullable default), composite tenant-aware FK `students(tenant_id, user_id) → memberships(tenant_id, user_id)` on `memberships_tenant_user_uq` (0009), SECURITY INVOKER trigger `trg_students_user_link_validate_biu` (active-membership-only), partial unique `students_tenant_user_uq` (one live student per user per tenant) | `packages/db/migrations/0013_student_homework_identity.sql`, `packages/db/src/schema.ts` |
| Link API | `PATCH /api/v1/students/:id` accepts `userId` (`uuid\|null`) under the existing `students.update`, strict schema (mass-assignment still 400), campus scope + audit + idempotency | `apps/api/src/routes/school/students.ts`, `apps/api/src/routes/school/util.ts`, `packages/contracts/src/school.ts` |
| Self-scoped context | `GET /api/v1/me/homework-context` → `{role: staff\|teacher\|parent\|student\|none, classes:[{id,code,name,campusId,academicYearId}]}` under `homework.read`; mirrors per-class visibility exactly; runs on `tenantRoleCodes` so an unlinked/suspended/parent-suspended portal user resolves honestly | `apps/api/src/routes/me.ts`, `apps/api/src/routes/school/homework.ts`, `packages/contracts/src/school.ts` |
| Student visibility | `homework.read` holders: owner/principal → all; teacher → authored; parent → guardian children's live-enrollment classes; student → own-link live-enrollment classes; others → empty/404. Precedence all > teacher > parent > student > none | `apps/api/src/routes/school/homework.ts` |
| Portals | Read-only server-component routes `/parent/homework` and `/student/homework`; pure testable lib; shared honest empty-state view. Direct routes — permission-driven school nav deliberately untouched (portal roles would otherwise see staff tiles they cannot use) | `apps/web/app/{parent,student}/homework/page.tsx`, `apps/web/app/homework/homework-portal-view.tsx`, `apps/web/lib/homework-portal.{ts,test.ts}` |
| Docs | Phase 4.4 sections + 0013/visibility/context notes (student vis line 145 updated; migration 0013 added) | `docs/AUTHORIZATION.md`, `docs/DATABASE_DESIGN.md` |

## Acceptance matrix (real app + real DB + live Redis)

`apps/api/src/security/phase4-4-homework-portals.acceptance.test.ts` — **21 tests, all green.**

| Area | Assertions |
| --- | --- |
| Gate | unauthenticated 401; member without `homework.read` 403 + `requiredPermission`; bare holder → `role:"none"` + empty classes |
| Context roles | staff (owner/principal) all classes; campus-pinned staff narrowed to campus; teacher → taught class; parent → guardian children class; unlinked student → role `student`, empty list |
| Link lifecycle | owner PATCH `{userId}` → 200 + `student.updated` audit; parent/teacher PATCH → 403 `students.update`; no-membership / cross-tenant / suspended targets → 409 `student_link_requires_membership`; second live student → 409 `student_user_already_linked`; cross-campus link/patch → 403 `campus_scope_denied`; unlink `userId:null` → 200 then relink → 200; mass-assignment `{tenantId,userId}` → 400 `validation_error` |
| Linked-student visibility | list includes the class's homework + detail 200; other class empty/404; context now `[classA]`; teacher scope unchanged (regression) |

`packages/db/src/security/phase4-4-student-portal.test.ts` — **10 checks, all green** (trigger 55000/`student_link_requires_membership` under both runtime RLS and migrator; partial-unique 23505 lifecycle incl. soft-delete keeps link + new live claims, cross-tenant independence; RLS erasure of other-tenant rows under the runtime role).

## Regression (constraint: existing suites must stay green)

| Suite | Before P4.4 | After | New |
| --- | --- | --- | --- |
| `packages/db` security (RUN_RUNTIME_SECURITY_TESTS=1, real DB) | 214 tests / 15 files | **224** / 16 | 10 |
| `apps/api` security (real app + DB + Redis) | 335 tests / 18 files | **356** / 19 | 21 |
| `apps/api` authorization inventory (`authorization.test.ts`, 14 tests) | green | green (+ `GET /api/v1/me/homework-context` entry, GET/HEAD twin map consistent) | 1 route |
| `apps/web` unit (vitest) | — | 72 tests / 11 files green | 5 (portal lib) |
| `apps/web` build (`next build`) | — | OK — `ƒ /parent/homework`, `ƒ /student/homework` | 2 routes |
| Typecheck contracts / db / api / web | — | all clean | — |
| `git diff --check` | — | clean (exit 0; only pre-existing CRLF notices) | — |
| Phase 4.3 acceptance (38) | green | green (unchanged — student-visibility change is additive) | — |

## Notation / decisions
- Student portal identity lives **in the schema**, not in new permissions: the DB trigger + partial-unique index + composite tenant FK carry the invariants; 55000 and 23505 map to 409 domain codes in `util.ts`. Suspending a membership after linking deactivates the portal because every resolver path reads **active** memberships only.
- Cross-tenant link with the composite FK is structurally impossible on a tenants table with `(tenant_id, user_id)` uniqueness; `memberships_tenant_user_uq` (0009) is the anchor.
- Portals render only `homework.read`-sourced data (context + per-class lists) and never touch `classes`/`subjects` endpoints portal roles lack.

Tests executed live, not skipped; all counts above are real from `vitest run` with the runtime gate enabled.

PHASE 4.4 COMPLETE — READY FOR PHASE 4.5