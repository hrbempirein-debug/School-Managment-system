# PHASE 5 IMPLEMENTATION + SECURITY AUDIT REPORT

Phase 5 (Attendance) delivered daily + period attendance, staff attendance (light), the student leave workflow, class/student reports, the self-scoped parent & student portals, and the late-notification + daily-summary worker jobs. Four permissions and five events were added; the roadmap's Phase 5 scope is the only scope implemented.

## Deliverables

| Pillar | What shipped | Files |
| --- | --- | --- |
| DB schema (migration 0014) | `leave_types`, `attendance_days`, `attendance_periods`, `staff_attendance`, `leave_requests`; unique constraints for `(tenant, section, date)` and `(tenant, attendance_day, period)`, CHECK constraints on status/date windows, RLS on all five, `school_app_rw` grants, validation triggers (5) + leave-type delete guard/lifecycle triggers, 20+ indexes | `packages/db/migrations/0014_attendance_leave.sql`, `packages/db/src/schema.ts` |
| Permissions | `attendance.read`, `attendance.mark`, `attendance.approve_leave`, `attendance.request_leave` — deliberately four separate grants so a read-only role can never mark and a filing role can never decide | `packages/permissions/src/permissions.ts` |
| Events | `attendance.marked`, `attendance.corrected`, `leave.requested`, `leave.approved`, `leave.rejected` (catalog 84 → **89**) | `packages/contracts/src/events.ts` |
| Contracts | daily/period/staff/leave request + response, report, portal-context types, exported `AttendanceContextRole` | `packages/contracts/src/school.ts` |
| API | 19 route registrations (10 non-GET + 9 GET, each with a Fastify HEAD twin): marking (idempotent per date+period), same-day correction with mandatory reason, class + student reports, staff clock, leave type CRUD, leave file/approve/reject, and the self-scoped `/me` portal pair | `apps/api/src/routes/school/attendance.ts`, `apps/api/src/routes/school/leave.ts`, `apps/api/src/routes/me.ts`, `apps/api/src/app.ts` |
| Worker | `attendance.marked` → deferred late notification to the LIVE guardian of each late student; `attendance.corrected` → no notification; `leave.requested/approved/rejected` → deferred decision stub to the requester; `attendance.daily_summary` job computing the tally from the database and writing exactly one audit row per `(tenant, date)`; all handlers tenant-scoped and post-commit deferred | `apps/worker/src/attendance.ts`, `apps/worker/src/worker.ts` |
| Web | School console (`/school/attendance`) with daily register, period marking, corrections, staff clock, leave inbox + leave types; self-scoped parent/student portals (`/parent/attendance`, `/student/attendance`) sharing one read-only view with a leave-request form; 35-test pure helper lib | `apps/web/app/school/attendance/{page.tsx,attendance-manager.tsx}`, `apps/web/app/attendance/attendance-portal-view.tsx`, `apps/web/app/{parent,student}/attendance/page.tsx`, `apps/web/lib/attendance.{ts,test.ts}`, `apps/web/lib/nav.ts` |
| Docs | Attendance/leave schema, RLS and permission notes; 0014 migration entry; event catalog entries | `docs/DATABASE_DESIGN.md`, `docs/AUTHORIZATION.md`, `docs/EVENT_ARCHITECTURE.md` |

## Acceptance matrix (real app + real PostgreSQL + real Redis)

`apps/api/src/security/phase5-attendance.acceptance.test.ts` — **46 tests, all green**, across nine groups:

| Group | Assertions |
| --- | --- |
| Route gate & permission separation | 401 unauthenticated on all 8 read endpoints; 403 + `requiredPermission` for a member with no attendance permission; `attendance.mark` provably separate from `attendance.read` (parent reads, cannot mark self/child, cannot clock staff); anonymous/idempotency/CSRF discipline |
| Uniqueness enforced by the database | duplicate `(tenant, section, date)` and `(tenant, attendance_day, period)` rejected by unique indexes (not by app code); cross-tenant independence of the same key |
| Same-day correction rules | correction requires a reason, writes `attendance.corrected` + audit, is itself audited, and past/future dates are refused; a decided leave row is frozen at the DB level (trigger rejects UPDATE) |
| Parent own-children scope | parent context returns only linked children; cross-child negative test proves a second family's child is absent from the parent's portal payload (both the class-report and the self-scoped path) |
| Teacher mark scope | teacher may mark only sections assigned to them via `teacher_assignments`; unassigned section → 403/404; teacher cannot read another section's register |
| Tenant isolation | tenant B cannot read/mark/correct tenant A rows; cross-tenant ids in payloads are rejected rather than silently ignored |
| Staff attendance (light) | staff clock mark/read, one row per `(user, date)`, non-staff user rejected |
| Leave request lifecycle | file → pending; approve/reject transitions; requester vs approver separation; decided rows immutable; cancelling a pending request |
| Audit & outbox coverage | every state change writes the expected audit action and outbox event exactly once, with no cross-tenant rows |

`apps/worker/src/attendance.test.ts` — **10 tests, all green** against real PostgreSQL: one deferred mail stub per late student's LIVE guardian, deferring is the handler's only side effect, no deferral when nobody is late, decision stub addressed to the requester, a no-op when the request no longer matches the decision, a payload without `leaveRequestId` is rejected rather than guessed, the daily tally counts unmarked students, exactly one `attendance.daily_summary` audit row per `(tenant, date)`, the tally is recorded as the audit value, and the summary job never sees another tenant's data.

## Regression (constraint: existing suites must stay green)

| Suite | Before P5 | After | New |
| --- | --- | --- | --- |
| `apps/api` security (real app + DB + Redis) | 356 tests / 19 files | **403** / 20 | 46 + 1 matrix entry |
| `packages/db` security (real DB) | 224 tests / 16 files | **224** / 16 | 0 |
| `apps/worker` runtime (real DB + Redis) | 51 tests / 3 files | **61** / 4 | 10 |
| `apps/web` unit (vitest) | 72 tests / 11 files | **105** / 12 | 35 attendance + nav count |
| `apps/web` build (`next build`) | — | OK — `ƒ /school/attendance`, `ƒ /parent/attendance`, `ƒ /student/attendance` | 3 routes |
| `apps/api` authorization inventory (`authorization.test.ts`, 14 tests) | green | green (+ 19 Phase 5 entries incl. HEAD twins, 213 → 241 matrix rows) | 19 |
| Typecheck (17 packages) / `turbo run build` | — | all clean | — |
| Phase 4.4 homework portals (21) | green | green (unchanged) | — |
| Dev-DB residue after a full run | — | zero Phase 5 rows (tenant-scoped teardown verified) | — |

Full workspace: `RUN_RUNTIME_SECURITY_TESTS=1 pnpm turbo run test --force` → **8/8 tasks, 0 cached, 860 tests green.**

## Decisions & audit notes

- **Correctness lives in the database.** Idempotent per `(section, date)` and `(period, day)`, the status/date CHECKs, decided-leave immutability and the leave-type delete guard are all constraints/triggers; the API maps the resulting SQLSTATEs to 409 domain codes. Application-only "validation" would be bypassable by the runtime role.
- **`attendance.mark` ≠ `attendance.read`.** Read-only holders (parents) can view; only `attendance.mark` holders write. Leave *filing* (`attendance.request_leave`) and leave *deciding* (`attendance.approve_leave`) are separate from both, so no single role can file and approve its own request.
- **Portal scope is a relationship join under RLS, never a request parameter.** `/me/attendance-context` resolves the caller's own role and linked children only; the parent's payload provably omits another family's child.
- **Worker notifications are post-commit and deferred.** Handlers only `defer` jobs; a rolled-back handler leaves no mail, which is asserted directly.
- **Notification channel is a stub**, per the roadmap. `mailQueueName` on `startOutboxWorker` keeps the integration suite hermetic so a concurrently running dev worker cannot steal its messages.
- **`attendance.mark` also gates leave-type administration** (the roadmap defines only four attendance permissions); leave-type management is a settings act, not a filing or decision act.

## Environment & tooling fixes made during verification

1. `turbo.json` did not forward `RUN_RUNTIME_SECURITY_TESTS`, so `pnpm test` silently **skipped** every DB-backed security suite. It is now declared in the `test` task's `env` (and mirrored in the three package-scoped test tasks).
2. The DB-backed suites of `@sms/db`, `@sms/api` and `@sms/worker` share one dev database; turbo ran them concurrently, so fixtures could observe each other. They are now ordered `db → api → worker`.
3. `phase5-attendance.acceptance.test.ts` teardown used a wrong email pattern (`%@<slug>.example.com` vs the fixtures' `<role>-<slug>@example.com`) and leaked a platform user + `platform_role_assignments` row per run; the pattern is fixed and a clean run now leaves zero residue. Leaked rows from earlier interrupted runs were purged from the dev database.
4. **Known caveat (not a Phase 5 defect):** a long-running `pnpm dev:worker` shares the dev outbox and will execute *other* suites' promotion batches, which intermittently fails the Phase 3.3 lifecycle suite. Stop the dev worker before DB-backed test runs.

## Known unrelated defect (untouched)

`packages/db/src/cli/paths.ts:17-25` mis-derives the migrations directory, so `pnpm db:migrate` is unreliable; the canonical `applyMigrations()` API is correct and is what every test uses.

Tests executed live, not skipped; all counts above are real from `vitest run` with the runtime gate enabled and the dev worker stopped.

PHASE 5 COMPLETE — READY FOR PHASE 6 (Exams + Results)
