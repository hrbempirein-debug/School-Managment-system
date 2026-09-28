# Phase 6 Release Manifest

**Purpose.** Every file required to run the Phase 6 gate from a clean checkout, with the reason it
is required and its status at the time of writing. This manifest exists because HEAD
(`848c20f`, *"feat: complete phase 2a security foundation"*) contains **only** migrations `0001` and
`0002` — no part of Phase 6 is committed, so "the tests pass" and "a clean checkout can run the
tests" are two different claims. This document separates them.

**No commit has been made.** The staged index is a review artifact. See
[`PHASE_6_RELEASE_PREPARATION_REPORT.md`](./PHASE_6_RELEASE_PREPARATION_REPORT.md) for the measured
results and the conditions attached to them.

| | |
| --- | --- |
| Branch / HEAD | `master` @ `848c20fda26c4bd40d07467ba23d47f421e12f87` |
| Staged paths | 107 |
| Migrations required | `0001`–`0019` (19) |
| Staged snapshot exported & built clean | yes — see the report, "clean-checkout verification" |
| Independent audit verdict | `GO WITH CONDITIONS` ([R3](./PHASE_6_INDEPENDENT_FINAL_RE_AUDIT_REPORT_R3.md)) |

## Release classification of the staged snapshot

Every one of the **107** staged paths is classified below into exactly one class. This
classification is by *release role*; the "How the closure was derived" section that
follows classifies the same files by *derivation* (new / modified / already in HEAD).

| Class | Meaning | Paths |
| --- | --- | --- |
| **A** | Phase 6 implementation | 16 |
| **B** | Required transitive prerequisite | 76 |
| **C** | Required tooling/reproducibility prerequisite | 9 |
| **D** | Documentation/gate correction (approved) | 6 |
| **E** | Unexpected / unclassified | 0 |
| | **Total** | **107** |

Class **E** is empty: no staged path is unexpected or unclassified, and no staged file
contains unrelated work.

| # | Status | Class | Staged path |
| --- | --- | --- | --- |
| 1 | `A` | **C** | `.github/workflows/phase6-security.yml` |
| 2 | `M` | **B** | `apps/api/package.json` |
| 3 | `M` | **B** | `apps/api/src/app.ts` |
| 4 | `M` | **B** | `apps/api/src/plugins/auth.ts` |
| 5 | `A` | **B** | `apps/api/src/plugins/authorization.ts` |
| 6 | `M` | **B** | `apps/api/src/plugins/types.ts` |
| 7 | `M` | **B** | `apps/api/src/routes/audit.ts` |
| 8 | `M` | **B** | `apps/api/src/routes/auth.ts` |
| 9 | `M` | **B** | `apps/api/src/routes/files.ts` |
| 10 | `M` | **B** | `apps/api/src/routes/health.ts` |
| 11 | `M` | **B** | `apps/api/src/routes/me.ts` |
| 12 | `M` | **B** | `apps/api/src/routes/permissions.ts` |
| 13 | `A` | **B** | `apps/api/src/routes/school/academic-terms.ts` |
| 14 | `A` | **B** | `apps/api/src/routes/school/academic-years.ts` |
| 15 | `A` | **B** | `apps/api/src/routes/school/admission-applications.ts` |
| 16 | `A` | **B** | `apps/api/src/routes/school/attendance.ts` |
| 17 | `A` | **B** | `apps/api/src/routes/school/branding.ts` |
| 18 | `A` | **B** | `apps/api/src/routes/school/calendar-events.ts` |
| 19 | `A` | **B** | `apps/api/src/routes/school/calendars.ts` |
| 20 | `A` | **B** | `apps/api/src/routes/school/campuses.ts` |
| 21 | `A` | **B** | `apps/api/src/routes/school/class-subjects.ts` |
| 22 | `A` | **B** | `apps/api/src/routes/school/classes.ts` |
| 23 | `A` | **B** | `apps/api/src/routes/school/departments.ts` |
| 24 | `A` | **B** | `apps/api/src/routes/school/enrollments.ts` |
| 25 | `A` | **B** | `apps/api/src/routes/school/exams.ts` |
| 26 | `A` | **B** | `apps/api/src/routes/school/grade-levels.ts` |
| 27 | `A` | **B** | `apps/api/src/routes/school/guardians.ts` |
| 28 | `A` | **B** | `apps/api/src/routes/school/holidays.ts` |
| 29 | `A` | **B** | `apps/api/src/routes/school/homework.ts` |
| 30 | `A` | **B** | `apps/api/src/routes/school/leave.ts` |
| 31 | `A` | **B** | `apps/api/src/routes/school/periods.ts` |
| 32 | `A` | **B** | `apps/api/src/routes/school/placement.ts` |
| 33 | `A` | **B** | `apps/api/src/routes/school/promotion-batches.ts` |
| 34 | `A` | **B** | `apps/api/src/routes/school/sections.ts` |
| 35 | `A` | **B** | `apps/api/src/routes/school/settings.ts` |
| 36 | `A` | **B** | `apps/api/src/routes/school/student-documents.ts` |
| 37 | `A` | **B** | `apps/api/src/routes/school/student-export.ts` |
| 38 | `A` | **B** | `apps/api/src/routes/school/student-imports.ts` |
| 39 | `A` | **B** | `apps/api/src/routes/school/students.ts` |
| 40 | `A` | **B** | `apps/api/src/routes/school/subjects.ts` |
| 41 | `A` | **B** | `apps/api/src/routes/school/teacher-assignments.ts` |
| 42 | `A` | **B** | `apps/api/src/routes/school/teachers.ts` |
| 43 | `A` | **B** | `apps/api/src/routes/school/timetable.ts` |
| 44 | `A` | **B** | `apps/api/src/routes/school/util.ts` |
| 45 | `M` | **B** | `apps/api/src/routes/tenants.ts` |
| 46 | `A` | **A** | `apps/api/src/security/phase6-exams-acceptance.acceptance.test.ts` |
| 47 | `A` | **C** | `apps/api/vitest.config.ts` |
| 48 | `M` | **B** | `apps/worker/package.json` |
| 49 | `A` | **A** | `apps/worker/src/exams-result-pipeline.test.ts` |
| 50 | `A` | **A** | `apps/worker/src/exams.ts` |
| 51 | `A` | **A** | `apps/worker/src/report-pdf.ts` |
| 52 | `A` | **C** | `apps/worker/vitest.config.ts` |
| 53 | `M` | **D** | `docs/DEPLOYMENT.md` |
| 54 | `A` | **D** | `docs/PHASE_6_GO_CONDITION_REMEDIATION_REPORT.md` |
| 55 | `A` | **D** | `docs/PHASE_6_P2_P3_REMEDIATION_REPORT.md` |
| 56 | `A` | **D** | `docs/PHASE_6_RELEASE_MANIFEST.md` |
| 57 | `A` | **D** | `docs/PHASE_6_RELEASE_PREPARATION_REPORT.md` |
| 58 | `A` | **D** | `docs/PHASE_6_REMEDIATION_REPORT.md` |
| 59 | `M` | **C** | `package.json` |
| 60 | `M` | **B** | `packages/config/src/index.ts` |
| 61 | `M` | **B** | `packages/contracts/src/events.ts` |
| 62 | `M` | **B** | `packages/contracts/src/index.ts` |
| 63 | `M` | **A** | `packages/contracts/src/jobs.ts` |
| 64 | `A` | **B** | `packages/contracts/src/school.ts` |
| 65 | `A` | **B** | `packages/core/src/content.ts` |
| 66 | `A` | **B** | `packages/core/src/csv.ts` |
| 67 | `M` | **B** | `packages/core/src/index.ts` |
| 68 | `A` | **B** | `packages/db/migrations/0003_auth_tokens_rls_idempotency_fix.sql` |
| 69 | `A` | **B** | `packages/db/migrations/0004_school_domain_foundation.sql` |
| 70 | `A` | **B** | `packages/db/migrations/0005_students_foundation.sql` |
| 71 | `A` | **B** | `packages/db/migrations/0006_student_guardians_soft_link.sql` |
| 72 | `A` | **B** | `packages/db/migrations/0007_student_imports_admission_link.sql` |
| 73 | `A` | **B** | `packages/db/migrations/0008_academic_classes_sections_placement.sql` |
| 74 | `A` | **B** | `packages/db/migrations/0009_grade_levels_subjects_assignments.sql` |
| 75 | `A` | **B** | `packages/db/migrations/0010_safe_user_display.sql` |
| 76 | `A` | **B** | `packages/db/migrations/0011_timetable_homework.sql` |
| 77 | `A` | **B** | `packages/db/migrations/0012_timetable_double_book_disambiguation.sql` |
| 78 | `A` | **B** | `packages/db/migrations/0013_student_homework_identity.sql` |
| 79 | `A` | **B** | `packages/db/migrations/0014_attendance_leave.sql` |
| 80 | `A` | **A** | `packages/db/migrations/0015_exams_results.sql` |
| 81 | `A` | **A** | `packages/db/migrations/0016_phase6_result_integrity_fixes.sql` |
| 82 | `A` | **A** | `packages/db/migrations/0017_phase6_result_publication_integrity.sql` |
| 83 | `A` | **A** | `packages/db/migrations/0018_phase6_final_result_snapshot_integrity.sql` |
| 84 | `A` | **A** | `packages/db/migrations/0019_phase6_report_card_snapshot_reconciliation.sql` |
| 85 | `M` | **B** | `packages/db/src/cli/migrate-down.ts` |
| 86 | `M` | **B** | `packages/db/src/cli/migrate.ts` |
| 87 | `M` | **B** | `packages/db/src/cli/paths.ts` |
| 88 | `M` | **B** | `packages/db/src/cli/seed.ts` |
| 89 | `M` | **B** | `packages/db/src/schema.ts` |
| 90 | `A` | **A** | `packages/db/src/security/phase6-exams.test.ts` |
| 91 | `A` | **A** | `packages/db/src/security/phase6-migration-regression.test.ts` |
| 92 | `A` | **C** | `packages/db/src/testing/global-setup.ts` |
| 93 | `A` | **A** | `packages/db/src/testing/publish-card.ts` |
| 94 | `A` | **A** | `packages/db/src/testing/runtime-db.test.ts` |
| 95 | `A` | **A** | `packages/db/src/testing/runtime-db.ts` |
| 96 | `A` | **C** | `packages/db/src/testing/setup-env.ts` |
| 97 | `M` | **C** | `packages/db/vitest.config.ts` |
| 98 | `M` | **B** | `packages/events/src/dispatcher.ts` |
| 99 | `A` | **B** | `packages/idempotency/package.json` |
| 100 | `A` | **B** | `packages/idempotency/src/index.ts` |
| 101 | `A` | **B** | `packages/idempotency/tsconfig.json` |
| 102 | `M` | **A** | `packages/jobs/src/queues.ts` |
| 103 | `M` | **B** | `packages/permissions/src/permissions.ts` |
| 104 | `M` | **B** | `packages/storage/src/index.ts` |
| 105 | `M` | **B** | `packages/tenancy/src/index.ts` |
| 106 | `M` | **C** | `pnpm-lock.yaml` |
| 107 | `M` | **C** | `turbo.json` |

## How the closure was derived

Not by reading `git status`. Starting from the Phase 6 roots, every relative import and every
`@sms/*` package specifier was followed transitively to a fixed point, resolving NodeNext `.js`
specifiers to their `.ts` sources and package specifiers to each package's declared entrypoint.

- **95 source files** reachable, **0 unresolved** specifiers.
- Of those, **21 already exist unmodified in HEAD** and need no action.
- The remaining **74**, plus the migration chain and the manifests that install them, form the
  staged set.

The `0003`–`0015` migrations are not Phase 6, but `0015_exams_results.sql` creates the
`exams`/`marks`/`report_cards` tables that every later Phase 6 migration and every Phase 6 test
depends on, and it in turn depends on the school/student tables from `0004`–`0014`. A snapshot
containing `0016`–`0019` without `0003`–`0015` cannot reach a consistent schema, so the full chain
is staged.

## Class A — required new files (untracked at HEAD)

Untracked because HEAD predates them. All are imported by the Phase 6 closure.

| Path | Why required |
| --- | --- |
| `.github/workflows/phase6-security.yml` | The release gate itself. Defines the four mandatory DB-backed security suites and the final full-suite run. |
| `packages/db/migrations/0003`–`0015` (13 files) | Schema prerequisites for `0015`; see above. `0015` creates the Phase 6 tables. |
| `packages/db/migrations/0016`–`0019` (4 files) | Phase 6 result integrity, publication integrity, final snapshot integrity, snapshot reconciliation. |
| `packages/db/src/security/phase6-exams.test.ts` | DB security suite, 87 tests. |
| `packages/db/src/security/phase6-migration-regression.test.ts` | Rebuilds the database from nothing and re-proves `0018`/`0019` against a real pre-`0018` world, negative control included. |
| `packages/db/src/testing/global-setup.ts` | Creates/validates/migrates the disposable test database before the DB suites. |
| `packages/db/src/testing/runtime-db.ts` | Runtime-role connection with tenant context for the DB suites. |
| `packages/db/src/testing/runtime-db.test.ts` | Unit coverage for the harness itself. |
| `packages/db/src/testing/publish-card.ts` | `publishReportCardWithSnapshot` — the sanctioned publication path the tests must use rather than hand-rolled inserts. |
| `packages/db/src/testing/setup-env.ts` | Resolves the disposable test database URL and refuses to run against a non-test database. |
| `packages/idempotency/package.json`, `tsconfig.json`, `src/index.ts` | Whole package. 29 school routes import `@sms/idempotency`; `apps/api/package.json` adds the workspace dependency. |
| `apps/api/src/security/phase6-exams-acceptance.acceptance.test.ts` | API acceptance suite, 35 tests, including the C5 teardown fix. |
| `apps/api/vitest.config.ts` | API test configuration. |
| `apps/api/src/plugins/authorization.ts` | **Required transitive prerequisite from the earlier authorization phase, not Phase 6 feature implementation.** Deny-by-default route-authorization gate; every school route depends on it, which is also why seven pre-existing tracked routes gain `config.authorization` declarations. |
| `apps/api/src/routes/school/*.ts` — **31 route modules** + `util.ts` (32 files) | **Required transitive prerequisites from the earlier school-domain phases, not Phase 6 feature implementation.** All 31 are imported and registered by `apps/api/src/app.ts`; `util.ts` is a shared helper imported by the routes, not a route. Verified: 31 imports in the staged `app.ts`, 31 `app.register(...)` calls, 0 orphan imports, 0 orphan files. |
| `apps/worker/src/exams.ts` | `makeResultComputeHandler` — the worker half of the F-02 handoff. |
| `apps/worker/src/report-pdf.ts` | Report-card artifact rendering, imported by `exams.ts`. |
| `apps/worker/src/exams-result-pipeline.test.ts` | Worker result-pipeline suite, 13 tests. |
| `apps/worker/vitest.config.ts` | Worker test configuration. |
| `packages/contracts/src/school.ts` | Zod schemas for the school domain routes. |
| `packages/core/src/content.ts`, `csv.ts` | Imported by the school routes (CSV import/export, content helpers). |
| `docs/PHASE_6_REMEDIATION_REPORT.md` | Rounds 1–2 findings; carries the addendum with the corrected DB-suite count and the C2 scoping rule. |
| `docs/PHASE_6_P2_P3_REMEDIATION_REPORT.md` | P2/P3 findings; carries the C3 variable-name fix and the C4 three-test dependency. |
| `docs/PHASE_6_GO_CONDITION_REMEDIATION_REPORT.md` | Gate-condition round; carries the C2 CLI fix and the F-02 contract boundary. |

## Class B — required modifications to tracked files

| Path | Why required |
| --- | --- |
| `apps/api/src/app.ts` | Registers the 31 school route modules. Without the untracked routes, this file's edits are inert; with them, it is the wiring. |
| `apps/api/src/plugins/auth.ts`, `plugins/types.ts` | Shared auth plugin contract used by the authorization plugin and routes. |
| `apps/api/src/routes/{audit,auth,files,health,me,permissions,tenants}.ts` | Pre-existing routes that share the modified plugin/types and tenancy surface. |
| `apps/api/package.json` | Adds the `@sms/idempotency` workspace dependency. |
| `apps/worker/package.json` | Adds `@sms/audit`, `@sms/storage`; adds `pg`, `@types/pg`, `vitest` for the result-pipeline suite. |
| `packages/config/src/index.ts` | Env loading used by the CLI fix and the test harness. |
| `packages/contracts/src/index.ts`, `events.ts`, `jobs.ts` | Event/job contracts; `jobs.ts` adds the Phase 6 report-card job. |
| `packages/core/src/index.ts` | Barrel for `content.ts`/`csv.ts`. |
| `packages/db/src/schema.ts` | Drizzle schema, including the Phase 6 tables and the `report_card_subjects` snapshot table. |
| `packages/db/src/cli/paths.ts` | The C2 fix: `isMainModule()` compared `process.argv[1]` to *its own* `import.meta.url`, so `pnpm db:migrate` exited 0 having applied nothing. |
| `packages/db/src/cli/migrate.ts` | Passes the caller's `import.meta.url`; reports failures with a non-zero exit code. |
| `packages/db/src/cli/migrate-down.ts`, `seed.ts` | Also callers of `isMainModule`; staged because the fix changes their contract. |
| `packages/db/vitest.config.ts` | DB test configuration, incl. the runtime-security gate. |
| `packages/events/src/dispatcher.ts` | Outbox dispatch used by the worker result pipeline. |
| `packages/jobs/src/queues.ts` | Adds the `reports` artifact queue (`JOB_ARCHITECTURE` §2). Additive to `QueueDelegates`; HEAD's `worker.ts` continues to compile unchanged. |
| `packages/permissions/src/permissions.ts` | Phase 6 permissions referenced by the routes and the authorization plugin. |
| `packages/storage/src/index.ts` | Storage surface used by `report-pdf.ts`. |
| `packages/tenancy/src/index.ts` | Tenant context helpers used across the API/DB boundary. |
| `turbo.json` | Adds `env: ["RUN_RUNTIME_SECURITY_TESTS"]` to `test` and the `@sms/{db,api,worker}#test` tasks so Turbo's cache keys on the variable instead of serving a result computed without it. |
| `pnpm-lock.yaml` | See "Lockfile" below. |

## Class C — already in HEAD, unmodified (21 files)

Reachable from the Phase 6 closure and already correct at HEAD, so they appear in neither the staged
set nor the working-tree changes. Listed to show the closure was fully accounted for, not to imply
they were staged.

`apps/api/src/plugins/deps.ts`, `apps/api/src/plugins/request-context.ts`,
`apps/api/src/routes/shared.ts`, `packages/audit/src/index.ts`, `packages/auth/src/index.ts`,
`packages/auth/src/password.ts`, `packages/auth/src/service.ts`, `packages/auth/src/sessions.ts`,
`packages/contracts/src/auth.ts`, `packages/contracts/src/common.ts`, `packages/contracts/src/error.ts`,
`packages/contracts/src/tenants.ts`, `packages/core/src/context.ts`, `packages/core/src/errors.ts`,
`packages/core/src/ids.ts`, `packages/db/src/client.ts`, `packages/db/src/index.ts`,
`packages/events/src/index.ts`, `packages/events/src/outbox.ts`, `packages/permissions/src/index.ts`,
`packages/redis/src/index.ts`.

Also sufficient at HEAD and deliberately untouched: `scripts/bootstrap.sql`,
`pnpm-workspace.yaml`, `tsconfig.base.json`, `.npmrc`, `.gitignore`, `.env.example`.

## Class D — unrelated to Phase 6, deliberately NOT staged

Present in the working tree, left exactly as found. None is imported by the Phase 6 closure.

- **Phase 2–5 test infrastructure** — `apps/api/src/security/*.test.ts` (phase2/3/3-5/4-x/5
  acceptance suites, `authorization`, `branding`, `campus-scope`, `school-domain`),
  `apps/api/src/routes/school/util.test.ts`, `apps/api/src/plugins/authorization.test.ts`,
  `packages/db/src/security/{phase3-5,phase4-1,phase4-2,phase4-3,phase4-4,school-domain,students-foundation,student-guardians,token-scope,enrollment-lifecycle,document-lifecycle}.test.ts`,
  `packages/db/src/security/{impersonation-boundary,trust-boundary}.test.ts` (tracked-modified),
  `apps/worker/src/*.test.ts`, `apps/web/lib/*.test.ts`, `packages/core/src/csv.test.ts`,
  `packages/permissions/src/permissions.test.ts`, `packages/storage/src/storage.test.ts`.
- **The four test-manifest additions that make those suites runnable** —
  `apps/web/package.json`, `packages/core/package.json`, `packages/permissions/package.json`,
  `packages/storage/package.json` each add a `test` script, and `apps/web/vitest.config.ts` is new.
  Excluded because they are the reason the lockfile is mixed; see below.
- **Web UI work** — the `apps/web/app/**` pages and components, `apps/web/lib/*.ts`,
  `apps/web/{next.config.mjs,tsconfig.json,next-env.d.ts}`, `packages/ui/src/index.tsx`.
- **Worker handlers outside the Phase 6 path** — `attendance.ts`, `documents.ts`, `promotion.ts`,
  `student-import.ts` and their tests, `apps/worker/src/worker.ts` (tracked-modified),
  `apps/worker/src/outbox-integration.test.ts`.
- **Stray tooling artifacts** — `.coupling.mjs`, `.mkturbo.mjs`, `.overlay.mjs`, `.stage-list.txt`,
  `.stage.mjs`, `.sync.mjs`, `.turbo.release.json`, `packages/redis/probe.cjs`.
- **Other phases' reports** — `docs/PHASE_4_4_REPORT.md`, `docs/PHASE_5_REPORT.md`.
- **The independent audit reports** — `PHASE_6_INDEPENDENT_FINAL_RE_AUDIT_REPORT{,_R2,_R3}.md`,
  `PHASE_6_INDEPENDENT_RE_AUDIT_REPORT.md`. These are the auditor's artifacts. R3 was read and
  **not modified**; committing someone else's audit is the owner's call, not this task's.

## Class E — mixed or ambiguous, requires an owner decision

Not staged. Each is a tracked file whose diff combines Phase 6 with other work, or a Phase 6
statement embedded in an otherwise unrelated document.

| Path | The coupling |
| --- | --- |
| `docs/AUTHORIZATION.md` | Phase 2/4.2/4.3/4.4 content plus one Phase 6 permission line. |
| `docs/DATABASE_DESIGN.md` | Phase 2/4/4.2/4.3 content plus the Phase 6 tables. |
| `docs/EVENT_ARCHITECTURE.md` | Phase 2/4.1/4.2/4.3 content plus Phase 6 events. |
| `docs/ARCHITECTURE.md` | Phase 2B.3 only; no Phase 6 content. |
| `docs/JOB_ARCHITECTURE.md` | One Phase 6 `reports`-queue line in an otherwise Phase 2/3 document. Clean enough to stage, but it is a documentation-only dependency of a Class E set, so it is held back for one decision. |
| `apps/worker/src/worker.ts` | Multi-phase (attendance, documents, promotion, imports, Phase 6). Its working-tree version closes `queues.reports`, which the staged `packages/jobs/src/queues.ts` provides. The staged snapshot is self-consistent without it (the widened `QueueDelegates` is additive), but committing the full worker would pull in Class D handlers. |
| `pnpm-lock.yaml` (working tree vs index) | See below. |

**One coupled non-Phase 6 change is deliberately included.** `turbo.json` is required by C2, and its
working-tree diff also removes the `"lint": {}` task. Staging that half alone would leave the
snapshot advertising a `lint` script that resolves to nothing. So the removal is staged together
with its two partners, `package.json` (drops `"lint": "pnpm turbo run lint"`) and
`docs/DEPLOYMENT.md` (documents why). It is called out here because it is **not** Phase 6: a
`lint` script invoking `turbo run lint` when no package defines a `lint` task reported success
having checked nothing, and removing it is a false-success-gate fix. It is inseparable from the
C2 change in the same file.

## Lockfile: a deliberate index/worktree divergence

`pnpm-lock.yaml` is **mixed**. The working-tree lockfile adds `vitest` devDependencies for four
unrelated packages (`apps/web`, `packages/core`, `packages/db`, `packages/tenancy`); the staged
lockfile does not. This was measured, not assumed:

- Staging the mixed lockfile while reverting those four manifests to HEAD fails
  `pnpm install --frozen-lockfile` with `ERR_PNPM_OUTDATED_LOCKFILE` — *"in importers["apps/web"]:
  1 dependency was removed: vitest@^3.0.0"*. So the mixed lockfile and the Class D manifests are
  genuinely coupled and cannot be half-adopted.
- The staged lockfile contains exactly the three Phase 6 importer changes and nothing else:
  `apps/api` → `@sms/idempotency`; `apps/worker` → `@sms/audit`, `@sms/storage`, plus devDeps
  `@types/pg`/`pg`/`vitest`; and the new `packages/idempotency` importer.
- `pnpm install --frozen-lockfile` **succeeds** against the staged snapshot exported to a clean
  directory with no repository history. That is the C1/P2-3 provenance proof.

Consequence: the working-tree lockfile is left untouched, so `pnpm-lock.yaml` shows `MM`. After the
owner commits the staged snapshot, adding the Class D test manifests will require regenerating the
lockfile — that is the Class D commit's business, not this one's.

## Known divergence: staged snapshot vs working tree

Both are green; they are not the same size, and the difference is intentional.

| | Working tree | Staged snapshot |
| --- | --- | --- |
| `pnpm test` tasks | 8 | 4 |
| Tests discovered | 1069 | 192 |
| Passed (env unset) | 290 | 24 |
| Skipped (runtime security, env unset) | 779 | 168 |
| Result | 8/8 pass | 4/4 pass |

The staged snapshot contains only the Phase 6 closure, so it has no Phase 2–5 security suites to
run and no `test` script for `apps/web`/`packages/core`/`packages/permissions`/`packages/storage`.
The extra 4 tasks and 877 tests in the working tree are Class D. Reproducing the working-tree
numbers requires committing Class D as well, which is a scope decision for the owner.
