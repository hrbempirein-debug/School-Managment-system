# Development Roadmap

Status: Phase 0 | Each phase: Goal / Dependencies / DB / API / Frontend / Worker / Tests / Security / Acceptance.

Rule: phases are sequential unless marked parallelizable; no skipping foundation phases.

---

## Phase 0 — Architecture (THIS PHASE)

- **Goal:** Auditable blueprint: stack decisions, tenancy, authz, data, security, roadmap.
- **Deliverables:** `docs/*` complete set, ADRs, `.env.example`, `.gitignore`, git init, empty-yet-valid workspace plan.
- **Acceptance:** Docs internally consistent; env audit recorded with VERIFIED/ASSUMED; self-audit passed; no application business code.

## Phase 1 — Infrastructure + Authentication + Tenancy + RBAC

- **Goal:** Runnable skeleton: monorepo boots, API+web+worker dev loop, login works, tenant isolation real, RBAC enforced end-to-end.
- **Dependencies:** Postgres creds, Redis confirm, storage decision (FS adapter OK), CI account.
- **DB:** `tenants, users, user_profiles, auth_identities, auth_sessions, auth_tokens, memberships, roles, role_permissions, membership_roles, invitations, audit_logs, idempotency_keys, outbox_events, job_runs, files (minimal)` + RLS infra, migrator/app_rw roles, tenant-table registry.
- **API:** health endpoints (`/healthz`,`/readyz`), auth routes (register-login-logout-refresh/reset/invite-accept/me), tenant switch/resolve, generic route framework with permission metadata + Zod validation + error envelope + request ids + rate limits, platform tenant CRUD (minimal), audit writer, outbox dispatcher, presigned file init/complete (FS backend acceptable), OpenAPI gen.
- **Frontend:** Next.js shell, login/register pages, tenant context provider, `/platform` + `/school` shells with menu from permissions, error boundaries, API client with envelope handling.
- **Worker:** dispatcher consumer, mailer stub (logs or local SMTP), session cleanup job.
- **Tests:** isolation suite v1 (all Phase-1 tables), authz route matrix, idempotency replay, session security tests, CI pipeline green.
- **Security:** argon2id, cookie+CSRF, rate limits, secret scan, RLS FORCE proven by raw-SQL tests.
- **Acceptance:** Two tenants seeded; user in A cannot read B via API, raw SQL, or worker; every route without permission fails boot test; fresh clone → `pnpm install && pnpm dev` works on Windows.

## Phase 2 — Schools + Campuses + Academic Structure

- **Goal:** Tenant onboarding content: campuses, years, terms, calendar, departments, settings/branding.
- **DB:** `campuses, academic_years, terms, holidays, departments, school_settings, calendars/events`.
- **API:** CRUD + ordering rules (term dates), settings put, branding upload.
- **Frontend:** school settings UI, campus list, academic year wizard.
- **Worker:** n/a (minimal), maybe branding image process.
- **Tests:** date overlap constraints, authz per campus scope, isolation for new tables.
- **Security:** `school.settings.manage` gates; branding file rules.
- **Acceptance:** New school (from Phase 1 onboarding) fully configured for an academic year.

## Phase 3 — Students + Guardians + Enrollment

- **Goal:** Student lifecycle: applications → admission → enrollment → documents → transfer/promotion/graduation.
- **DB:** `students, guardians, student_guardians, enrollments, student_documents, admission_applications, transfers, promotion_batches/items` + search indexes (trigram on names).
- **API:** list/filter/search/pagination conventions live; CRUD; actions (enroll, transfer, promote, graduate); bulk import (CSV) job; documents upload.
- **Frontend:** student directory, detail tabs, admission pipeline board, guardian linking, bulk import wizard.
- **Worker:** CSV import, document scan hook, promotion batch execution.
- **Tests:** uniqueness (student_no, roll_no), relationship integrity, isolation, import idempotency, authz (export perm).
- **Security:** PII in logs scrub verified; file attach perms; mass-assignment tests.
- **Acceptance:** Admit 100 students via import; cross-tenant GET 404; audit rows for create/update/delete.

## Phase 4 — Teachers + Academics + Timetable

- **Goal:** Class/subject structure, teacher assignment, timetable, homework.
- **DB:** `grade_levels, acd_classes, sections, subjects, class_subjects, teacher_assignments, periods, timetable_entries, homework/assignments`.
- **API:** CRUD + conflict validation (teacher double-booking, period overlap via exclusion constraints), publish timetable event.
- **Frontend:** timetable grid UI, assignment tools, homework list for teacher/parent/student portals (parent/student read views).
- **Worker:** conflict lint job optional; notifications on timetable publish (stub until Phase 8 — outbox event only).
- **Tests:** overlap constraint tests, isolation, teacher-scoped access (own classes only).
- **Security:** campus scoping for multi-campus timetables; homework attachments file rules.
- **Acceptance:** Published timetable with zero conflicts; teacher cannot edit other teacher's homework.

## Phase 5 — Attendance

- **Goal:** Daily + period attendance, staff attendance basics, leave requests, reports.
- **DB:** `attendance_days, attendance_periods, staff_attendance (light), leave_requests, leave_types (student)`.
- **API:** mark/bulk mark (idempotent per date+period), corrections w/ reason (audit), leave approve/reject, reports.
- **Frontend:** teacher class roster marking UI, admin dashboards, parent/student read, leave forms.
- **Worker:** late-notification jobs (stub channel ok), daily summary.
- **Tests:** unique constraints, same-day correction rules, parent sees only own children (cross-child negative test), isolation.
- **Security:** `attendance.mark` vs read; parent scope enforced by relationship join under RLS.
- **Acceptance:** Mark attendance for 20 classes; correction writes audit; parent API returns only linked students.

## Phase 6 — Exams + Results

- **Goal:** Exams, marks, grading scales, report cards, publishing + corrections.
- **DB:** `exam_types, exams, exam_subjects, exam_schedules, marks, grading_scales (versioned), report_cards (versioned), mark_corrections`.
- **API:** mark entry (teacher, own subject only), grading scale CRUD, compute results job, publish (perm `exams.publish`), correction workflow (`exams.correct`), transcript read.
- **Frontend:** gradebook grid, report card preview, admin publish flow, parent result view.
- **Worker:** result computation, PDF generation (reports queue), publish notifications (stub→Phase 8).
- **Tests:** mark bounds, publish immutability (post-publish UPDATE only via correction path), GPA math units, isolation, authz (teacher cannot publish).
- **Security:** result data parent-scoped; audit `exam.result.published`.
- **Acceptance:** Full cycle class → exam → marks → publish → parent sees results; illegal mark edit blocked at DB trigger.

## Phase 7 — Fees + Finance

- **Goal:** Complete money cycle: structures → invoices → payments → receipts → refunds → balances → ledger.
- **DB:** all `fin_*` (DATABASE_DESIGN §9) + ledger accounts seed.
- **API:** structures CRUD, invoice generate/issue/void, payment record (+gateway later), refund flow, receipts, balance/aging reports; **Idempotency-Key required** on money POSTs.
- **Frontend:** fee setup wizard, invoice lists/detail, payment collection POS-style UI, refund审批, reports for accountants, parent invoices/pay online (gateway stub = manual until provider keys).
- **Worker:** invoice batch generation, receipt PDF, reconciliation jobs, dunning reminders (channel stubs).
- **Tests:** full finance suite (TESTING_STRATEGY §6): races, triggers, ledger balance, webhook replay (fake provider), isolation.
- **Security:** step-up MFA on refund/cash collect; immutability REVOKE verified; reconciliation alerting.
- **Acceptance:** Randomized property test 10k operations maintains invariants; issued invoice lines unmodifiable; audit for every money event.

## Phase 8 — Communication

- **Goal:** Notifications, announcements, email/SMS send paths, in-app messaging.
- **DB:** `notification_templates, notifications, announcements, message_threads/messages` + provider tables.
- **API:** send/announce (audience selectors w/ server-side resolution), templates, thread messaging, preferences.
- **Frontend:** announcement composer, notification center, messaging UIs across portals.
- **Worker:** `mail`, `sms`, `push` queues with retries/DLQ, dedupe keys, provider adapters (real keys REQUIRES USER ACTION; fake provider adapter in tests only — **no fake in prod code paths**: feature-flagged until keys provided).
- **Tests:** dedupe, retry/DLQ, audience correctness (no cross-tenant recipients), unsubscribe prefs.
- **Security:** `communication.send` perm; rate limits per tenant SMS budget; content injection into templates escaped.
- **Acceptance:** Announcement reaches exactly configured audience across two tenants with zero cross-leak; failed provider → retries then DLQ visible.

## Phase 9 — Library + Transport + Operations

- **Goal:** Library circulation; transport fleet & assignments; ops dashboards.
- **DB:** `lib_*`, `trn_*` (+ reuse fee items for transport fees).
- **API/FE/Worker:** catalog/loans/returns/fines (fines post to finance via adjustments/events); vehicle/routes/assignment; transport fee assignments via finance module events.
- **Tests:** active-loan uniqueness, fine math, isolation, parent sees own transport only.
- **Acceptance:** Loan→overdue→fine→pay cycle works; route assignment limits by campuses enforced.

## Phase 10 — HR + Payroll

- **Goal:** Employees, attendance, leave, salary structures, payroll runs, payslips.
- **DB:** `hr_*` complete; employee↔user linking.
- **API:** payroll draft→approve→post (state machine, post immutable), payslip reads scoped (own vs `hr.payroll.read_all`), leave.
- **Frontend:** employee admin, payroll console, payslip portal views.
- **Worker:** payroll computation (payroll queue, per-tenant fairness), payslip PDF, year-end summary (later).
- **Tests:** posting immutability, idempotent runs, calc units, isolation, authz (employee sees only own payslip).
- **Security:** payslips private files; payroll perms step-up; audit `payroll.posted`.
- **Acceptance:** Posted run produces equal ledger effects + payslips; re-run blocked; payslip download audited.

## Phase 11 — Subscriptions + Billing

- **Goal:** Plans/entitlements/usage live enforcement, trials, provider checkout, dunning, admin billing views.
- **DB:** full `plt_*` billing tables (DATABASE_DESIGN §1), platform invoice minimal.
- **API:** platform plan CRUD, tenant subscription lifecycle endpoints, webhook receiver, usage reporting, feature gate middleware wiring across existing routes (retrofit metadata), billing portal links.
- **Frontend:** `/platform` plans & school subscriptions, school upgrade CTAs, 402/usage UX.
- **Worker:** dunning sweeps, usage rollups, provider reconciliation, trial expiry.
- **Tests:** state machine table tests, limit races (create student at exact limit concurrently), webhook idempotency/replay, suspended write-deny matrix, isolation of platform tables.
- **Security:** webhook signatures; platform audit for plan edits; no provider coupling in domain code (adapter contract test).
- **Acceptance:** New school trial → limits enforced → upgrade via fake/manual provider → limits lift; suspended school read-only; code grep shows zero `plan ===` style checks.

## Phase 12 — AI

- **Goal:** AI gateway, assistants, tool catalog with authz, usage metering.
- **DB:** `ai_conversations, ai_messages, ai_tool_calls` + usage counters.
- **API:** chat endpoint (stream), admin tool/policy config, conversation history (RLS).
- **Frontend:** assistant widgets per portal with persona prompts.
- **Worker:** `ai` queue completions, batch analyses, report drafts.
- **Tests:** tool authz matrix, cross-tenant tool denial, injection corpus, cost cap behavior, audit completeness.
- **Security:** THREAT_MODEL T18–T20 review sign-off; prompt/response retention policy honored; provider DPA noted in docs.
- **Acceptance:** Parent assistant cannot retrieve another family's fees even with adversarial prompts (handler-level proof); deny attempts logged; monthly token cap triggers 402.

## Phase 13 — Production Hardening

- **Goal:** GA readiness: HA, DR, pen test, SLOs, alerting, runbooks, performance, retention jobs, erasure/export, DLQ tooling, canary deploys.
- **Dependencies:** production cloud accounts, domains, secrets manager, monitoring stack, budget for pen test.
- **Tests:** load tests (k6), DR restore drill, chaos (kill worker mid-job), full regression, accessibility pass on portals.
- **Acceptance:** SLO dashboards live; restore drill ≤1h RTO; pen-test findings triaged; on-call runbooks index; scale smoke: 1000 seeded tenants × RLS queries within latency budget.

---

## Parallelizable work

- Phases 9 and 10 can proceed in parallel after Phase 8.
- Phase 11 can start (tables + platform UI) during Phase 8–9 if staffed; enforcement retrofit lands before Phase 12.
- Phase 12 depends on 5–7 (data to reason about) and 11 (usage billing).

## User Decisions Required (roll-up)

1. **DB/Redis dev access:** credentials & database name; whether to standardize on Windows Postgres+WSL Redis or install Docker.
2. **Object storage:** MinIO via Docker (needs Docker) vs FS adapter initially vs cloud bucket now.
3. **Jurisdiction/statutory defaults** for finance/student retention & consent (financing defaults assumed 7y).
4. **Trial expiry behavior:** expired vs past_due after trial (default: expired read-only).
5. **Payment providers:** which gateway(s) for school billing (Phase 11) and tuition collection (Phase 7) — keys required; offline-first manual flow is the default until provided.
6. **Email/SMS providers** for Phase 8 (keys required; dev uses log/SMTP-local adapters behind interfaces).
7. **LLM provider** and budget for Phase 12.
8. **Brand/domain** decisions (app domain, product name finalization).
9. **Currency/locale defaults** for seed (multi-currency future-ready; default single currency per school — which?).
10. **MFA policy** exact rollout (all admins day-1 vs Phase 13).
