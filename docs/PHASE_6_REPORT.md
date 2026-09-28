# Phase 6 Report — Exams + Results

> **Superseded in part.** A later audit of this phase produced eight result-integrity findings
> (F-01 … F-08) and a forward-only remediation. See
> [`PHASE_6_REMEDIATION_REPORT.md`](./PHASE_6_REMEDIATION_REPORT.md). This document is kept as the
> record of the original delivery. The test counts in §6 and the closing banner below describe the
> state **before** remediation and must not be read as current.

Roadmap line: *Goal:* exams, marks, grading scales, report cards, publishing + corrections.
*Acceptance:* full cycle class → exam → marks → publish → parent sees results; illegal mark edit blocked at DB trigger.

Everything below was executed live against the dev PostgreSQL + Redis with the runtime gate
(`RUN_RUNTIME_SECURITY_TESTS=1`) and the dev worker stopped. No count is estimated.

## 1. Database — `packages/db/migrations/0015_exams_results.sql`

| Table | Purpose | Hard invariants |
| --- | --- | --- |
| `grading_scales` | Versioned banding (label, min/max %, grade point) | Bands must TILE `[0,100]` with no gap/overlap once sorted; `version` is monotonic per scale name; only an **active, undeleted** scale may be referenced |
| `exam_types` | Tenant exam-type catalogue | Per-tenant unique code |
| `exams` | One exam per (term, type, campus) | One-way lifecycle `draft → scheduled → grading → published` (`cancelled` terminal); `grading_scale_id` NULL = the tenant's newest active scale, a NAMED scale must be active |
| `exam_subjects` | (exam × class_subject) with `max_marks`, `weight` | `weight > 0` — a zero weight would silently drop the subject out of the GPA; `max_marks` is the denominator for every mark |
| `exam_schedules` | Per-subject session windows | Must sit inside the exam's term |
| `marks` | One row per (exam_subject, enrollment) | `marks_obtained <= max_marks`; `percentage`, `grade_label`, `grade_point` are **derived by trigger** and can never be posted; `status ∈ provisional → locked → rechecked` |
| `report_cards` | Versioned per-student aggregate | One live draft per (exam, student); publication requires the exam to be published; a recomputation mints `version + 1` rather than forking |
| `mark_corrections` | Append-only ledger | `UPDATE`/`DELETE` refused for everyone; the corrected value must be written **before** the mark UPDATE it justifies |

Tenant RLS on all eight tables. The single `SECURITY INVOKER` helper, `fn_exam_grade_for`, is the
one place a percentage becomes a grade label/point, so the API and the worker can never disagree.

### Triggers that carry the security weight

- `trg_exams_lifecycle_validate` — rejects a skipped/illegal transition and an explicitly named
  inactive or deleted grading scale (`exam_scale_not_active`).
- `trg_grading_scales_validate` — sorts the submitted bands before the tiling check, so a
  client cannot smuggle a gap past validation by submitting them out of order.
- `trg_marks_validate` / `trg_marks_derive` — ceiling, derivation, and the lock sweep: publishing
  the exam flips every provisional mark to `locked` in the same transaction.
- `trg_marks_immutable_published_trg` — a post-publish `UPDATE` is refused with a message that
  names the correction workflow, so the *only* legal path is `mark_corrections` + recheck.
- `trg_mark_corrections_append_only_trg` — the ledger is immutable for every role, including
  privileged ones. (The acceptance teardown lifts it as the migrator for exactly one statement and
  re-enables it immediately; the test asserts a privileged UPDATE is still refused.)

## 2. Permissions — `packages/permissions/src/permissions.ts`

| Permission | Grants | Built-in roles |
| --- | --- | --- |
| `exams.read` | exams, gradebook, report cards, transcript, `/me/results` | all staff/teacher/parent roles |
| `exams.manage` | exam types, exams, exam subjects, exam schedules | owner, admin, principal, teacher |
| `exams.mark` | result entry for **own** class subjects only | owner, admin, teacher |
| `exams.publish` | the publication boundary | owner, admin, principal |
| `exams.correct` | the correction workflow — the only way a published mark moves | owner, admin, principal |

`exams.mark` is deliberately **absent** from `principal`, so "a teacher can mark but cannot publish"
is provable with two real sessions, and `exams.correct` is separate from both.

## 3. API — `apps/api/src/routes/school/exams.ts`

Exam types `GET/POST /api/v1/exam-types`, `PATCH /api/v1/exam-types/:id`; grading scales
`GET/POST /api/v1/grading-scales`, `PATCH /api/v1/grading-scales/:id`; exams
`GET/POST /api/v1/exams`, `GET /api/v1/exams/:id`, `POST /api/v1/exams/:id/status`,
`POST /api/v1/exams/:id/publish`; subjects `GET/POST /api/v1/exams/:id/subjects`,
`PATCH /api/v1/exam-subjects/:id`, `GET /api/v1/exam-subjects/:id/gradebook`; schedules
`GET/POST /api/v1/exams/:id/schedules`, `GET /api/v1/exam-schedules/:id`; marks
`POST /api/v1/marks`; corrections `GET /api/v1/mark-corrections`,
`POST /api/v1/marks/:id/corrections`; results `GET /api/v1/report-cards`,
`GET /api/v1/report-cards/:id`, `GET /api/v1/students/:studentId/transcript`,
`GET /api/v1/me/results`.

Design decisions worth naming:

- **`published` is not a status-transition target.** `examStatusTransitionRequestSchema` is
  `scheduled | grading | draft | cancelled`, so publication is reachable *only* through the
  `POST /publish` route, i.e. only with `exams.publish` and only with its own transaction.
- **The body is the source of truth for an exam subject.** `POST /exams/:id/subjects` requires
  `examId` in the body and rejects a mismatch with the path (`exam_id_mismatch`).
- **The gradebook is a roster, not a table.** It returns the actively enrolled class with
  `canMark`; a teacher with no assignment gets `403 exam_subject_not_assigned`, a parent gets 403.
- **A parent may have several children.** `/me/results` returns `{ context, views }` with one view
  per linked child; a nameless parent with more than 25 children must name one instead of pulling
  the whole school.
- **Publication is one transaction**: exam → `published`, every draft card published with it,
  `exam.result.published` audited, `exam.result.compute` + `exam.published` enqueued. Nothing is
  readable by a family before the worker has produced the cards, so a half-computed publication is
  never observable.

## 4. Events & jobs

Four event types added (catalog **89 → 93**, each with exactly one registered handler):
`exam.result.compute`, `exam.published`, `report_card.generated`, `result.corrected`.
`apps/worker/src/exams.ts` computes the result set convergently (idempotent, safe to re-run) and
`apps/worker/src/report-pdf.ts` renders the report card on the `reports` queue. The family
notification remains a stub until Phase 8.

## 5. Frontend

`apps/web/app/school/exams/` (manager + publish flow) and `apps/web/app/parent/results/`
(portal view). The publish gate reads the **real** readiness state — subject count and the number
of students with an entered mark — instead of a placeholder, so the button cannot offer a
publication the API would refuse with `exam_has_no_subjects`.

## 6. Tests actually run

| Suite | Count | Command |
| --- | --- | --- |
| DB security, Phase 6 | 38 | `pnpm --filter @sms/db exec vitest run src/security/phase6-exams.test.ts` |
| API acceptance, Phase 6 | 29 | `RUN_RUNTIME_SECURITY_TESTS=1 pnpm --filter @sms/api exec vitest run src/security/phase6-exams-acceptance.acceptance.test.ts` |
| Worker result computation | 21 | `pnpm --filter @sms/worker exec vitest run src/exams.test.ts` |
| Full monorepo suite | **976** (22 core, 30 permissions, 2 config, 13 storage, 133 web, 262 db, 432 api, 82 worker) | `RUN_RUNTIME_SECURITY_TESTS=1 pnpm turbo run test --force` |
| Typecheck | 17/17 tasks | `pnpm turbo run typecheck --force` |
| Build | 3/3 tasks | `pnpm turbo run build --force` |

The acceptance suite walks the roadmap's own line end to end: A route gate and permission
separation, B/C lifecycle + mark entry, D publication + immutability (including a **direct SQL**
`UPDATE` of a published mark), E correction ledger, F parent scoping, G tenant isolation.

## 7. Environment & tooling fixes made during verification

1. **Acceptance teardown ordering.** The fixture deleted `roles` before
   `platform_role_assignments`, which RESTRICTs both endpoints, so a failed run leaked a platform
   role per run and broke unrelated suites that count global rows. The assignment now goes first,
   each teardown step is independent (one failure cannot orphan the rows after it), and the role
   predicates carry an exact-code fallback besides the id.
2. **Worker event catalog pin.** `outbox-integration.test.ts` pinned the catalog at 89; Phase 6
   makes 93. The pin is the point of the test, so it was moved to 93 with the four new types named
   — a new event type still cannot drift in un-registered.
3. **Leaked dev-database rows** from earlier interrupted fixture runs (2 orphan platform roles)
   were purged; a clean run now leaves zero residue.
4. **Known caveat (not a Phase 6 defect):** a long-running `pnpm dev:worker` shares the dev outbox
   and will execute other suites' batches. Stop it before DB-backed runs.

## 8. Known unrelated defect (untouched)

`packages/db/src/cli/paths.ts:17-25` was reported here as mis-deriving the migrations directory.
That claim does not reproduce: `paths.ts` resolves `migrationsDir` from `import.meta.url`, which is
correct for both `tsx` (source) and compiled output, and the canonical `applyMigrations()` — the
path every test and the harness use — has always been correct. The counts elsewhere in this section
are left as measured at delivery.

Tests executed live, not skipped; all counts above are real from `vitest run` with the runtime gate
enabled and the dev worker stopped.

PHASE 6 DELIVERED — **NOT** READY FOR PHASE 7. Two subsequent audits found result-integrity defects:
F-01 … F-08 (remediated in `0016_phase6_result_integrity_fixes.sql`) and the final re-audit
P1-01 … P3-03 (remediated in `0017_phase6_result_publication_integrity.sql`). Both rounds, their
evidence and their open caveats are in
[`PHASE_6_REMEDIATION_REPORT.md`](./PHASE_6_REMEDIATION_REPORT.md).
