# Database Design

Status: Phase 0 (logical design; migrations are phase-gated) | Related: MULTI_TENANCY.md, FINANCE_DESIGN.md, ADR-001/004

Conventions applied to **every** table unless noted:
- PK: `id UUID` (UUIDv7 via app) unless composite natural key stated.
- Tenant tables: `tenant_id UUID NOT NULL REFERENCES tenants(id)`, RLS enabled + FORCE, composite indexes lead with `tenant_id`.
- Audit columns: `created_at timestamptz NOT NULL DEFAULT now()`, `updated_at timestamptz NOT NULL`, `created_by UUID NULL`, `updated_by UUID NULL`.
- Soft delete: `deleted_at timestamptz NULL` **only** where recovery matters (entities) — RLS policies and unique indexes account for it (partial unique `WHERE deleted_at IS NULL`). Immutable/financial tables: **no** soft delete, no UPDATE (enforced by trigger or `REVOKE UPDATE`).
- Monetary: `numeric(19,4)` (no floats); currency char(3) ISO-4217 at invoice header.
- JSONB used for extension/config payloads only — never as substitute for queryable relational fields.
- FK behavior: children `ON DELETE RESTRICT` by default for operational data; `ON DELETE CASCADE` only for pure dependents (e.g., invoice line → invoice). Historical/financial rows restrict parent deletion (schools are never hard-deleted while finance rows exist → purge pipeline archives first).

**Estimated core tables: ~110–130 across all phases** (below lists the architecture-defining tables; module phases add detail tables).

---

## 1. Platform (`plt_*`, not tenant-RLS; platform policy)

| Table | Purpose | Key fields / constraints / indexes |
|---|---|---|
| `tenants` | School = tenant | `id`, `slug unique`, `name`, `status (trial|active|past_due|suspended|cancelled|deleting)`, `primary_domain`, `created_at`. idx on `slug`, `status` |
| `tenant_domains` | Custom domains | `tenant_id FK`, `domain unique` |
| `plt_plans` | Subscription plans | `code unique`, `name`, `price numeric`, `billing_interval (monthly|annual)`, `currency`, `is_active` |
| `plt_plan_features` | Plan × feature | unique(`plan_id`,`feature_code`), `limit_value bigint NULL` (NULL = unlimited) |
| `plt_features` | Feature catalog | `code unique` (e.g. `students.limit`, `ai.assistant`, `campuses.limit`) |
| `plt_subscriptions` | Subscription per tenant | `tenant_id`, `plan_id`, `status (trialing|active|past_due|suspended|cancelled|expired)`, `trial_ends_at`, `current_period_start/end`, `cancel_at`, `ended_at`. One active sub per tenant → partial unique index `WHERE status IN (...)` |
| `plt_subscription_events` | Lifecycle history (append-only) | `subscription_id`, `event`, `payload jsonb`, `occurred_at` |
| `billing_provider_refs` | Provider abstraction | `subscription_id`, `provider (stripe|manual|…)`, `external_id`, `raw jsonb` |
| `plt_usage_counters` | Usage limits | (`tenant_id`,`metric`,`period_start`) PK, `value bigint`, idx tenant+metric+period |
| `plt_invoices` / `plt_payments` | Platform's billing to school (distinct from school→parent finance) | provider-linked, append-only amounts |
| `platform_audit_logs` | Platform-scope audit | see §7 |

## 2. Identity / Tenancy (`auth_*`, `idn_*`)

| Table | Purpose | Notes |
|---|---|---|
| `users` | Global identity | `email citext unique`, `email_verified_at`, `status (active|disabled)`, `last_login_at` |
| `user_profiles` | Profile separate from auth | `user_id PK/FK`, `full_name`, `phone`, `locale`, `avatar_file_id` |
| `auth_identities` | Credentials | (`user_id`,`provider`) unique — `password` (argon2id hash), `secret_enc` (reserved, **unused**), `mfa_enabled` (always false today); REVOKE for mass exports |
| `auth_sessions` | Server sessions | `id`, `user_id`, `active_tenant_id NULL`, `ip`, `user_agent_hash`, `expires_at`, `revoked_at`; idx user, expires |
| `auth_tokens` | Reset/verify/invite/PAT | `user_id`, `type`, `token_hash unique`, `expires_at`, `consumed_at` |
| `memberships` | User ∈ school | unique(`user_id`,`tenant_id`), `status (active|invited|suspended)`, `campus_id NULL`; idx tenant,status |
| `roles` | RBAC roles | `scope (platform|tenant)`, `tenant_id NULL` (NULL = platform/template), `code`, unique(scope, tenant_id, code) with NULLS NOT DISTINCT |
| `role_permissions` | Role → permission | unique(`role_id`,`permission`), CHECK permission matches catalog pattern |
| `membership_roles` | Assignment | unique(`membership_id`,`role_id`), `campus_id NULL` |
| `invitations` | Tenant invites | `tenant_id`, `email`, `role_ids uuid[]`, `token_hash`, `expires_at`, `accepted_at` |
| `auth_audit_logs` / shared `audit_logs` | See §7 | |

## 3. School administration (`sch_*`)

| Table | Purpose | Notes |
|---|---|---|
| `campuses` | Campuses | tenant-scoped, `code`, unique(tenant_id, code) WHERE deleted_at IS NULL; `is_primary` → partial unique per tenant |
| `academic_years` | Years | unique(tenant_id, code); CHECK `end_date > start_date` |
| `terms` | Terms | FK year, unique(tenant_id, year_id, code), CHECK date order within year |
| `holidays` | Calendar days | tenant + optional campus_id |
| `departments` | Org departments | used by academics + HR (tenant-scoped) |
| `school_settings` | Config JSONB + typed columns | 1:1 tenant, `locale`, `timezone`, `grading_config jsonb`, `branding jsonb` |
| `calendars` / `events` | School events | FK term nullable |

**Phase 2B.3 foundation (migration `0004_school_domain_foundation.sql`, applied live):** the first
eight implemented tenant tables — `campuses`, `academic_years`, `academic_terms`, `calendars`,
`calendar_events`, `holidays`, `departments`, `school_settings`. All follow the § conventions:
RLS `ENABLE` + `FORCE` with the shared value-based policy shape `(tenant_id = app_current_tenant_id()
AND app_current_tenant_id() IS NOT NULL) OR app_privileged()` for SELECT/INSERT/UPDATE and
`app_privileged()` ONLY for DELETE (even the privileged executor may not delete through RLS; physical
deletion is a `school_migrator` admin operation only):

- Composite tenant-aware FKs via `UNIQUE (tenant_id, id)` on the parent (`academic_terms.academic_year_id`,
  `calendar_events.calendar_id`, DDL only — no runtime user)
- Partial unique `(tenant_id, code) WHERE deleted_at IS NULL`; `academic_terms` unique
  `(academic_year_id, sequence)`; `school_settings` singleton `UNIQUE (tenant_id)`
- Triggers (`SECURITY INVOKER`, raise with `ERRCODE 55000`, message = domain error code), e.g.
  `trg_academic_years_state` (closed can only open; active can only close), `trg_academic_terms_validate`
  (term dates inside parent year, no overlap among open terms, no open terms inside a closed year,
  parent-year visibility)
- Business semantics surfaced through the Drizzle schema + contracts (`packages/contracts/src/school.ts`);
  ORM timestamp `updated_at` uses `$onUpdate(() => new Date())` (drizzle wraps `$onUpdate` results in a
  typed param; returning an SQL fragment crashes `PgTimestamp.mapToDriverValue`, so a JS Date is required).

## 4. Students (`stu_*`)

| Table | Purpose | Notes |
|---|---|---|
| `students` | Student master | `student_no` unique(tenant_id, student_no), name, dob, gender, status (`applicant|active|transferred|graduated|alumni`), `primary_campus_id`, photo file_id, RESTRRICT delete |
| `guardians` | Guardian record | may link `user_id NULL` for portal |
| `student_guardians` | Relationships | (`student_id`,`guardian_id`,`relation`) unique; `is_primary`, `can_pickup bool` |
| `enrollments` | Student ∈ academic year/class | unique(tenant_id, student_id, academic_year_id); `class_id`, `section_id`, `status`, `roll_no` unique(tenant_id, section_id, roll_no) WHERE active |
| `student_documents` | Files | `file_id FK`, `doc_type`, student FK; RLS tenant |
| `admission_applications` | Admissions pipeline | `status` state machine, snapshot jsonb |
| `transfers` | Out/in transfers | student FK, `type (out|in)`, documents |
| `promotion_batches` + `promotion_items` | Year promotion | batch append-only items from section A→B etc. |
| Alumni = `students.status='alumni'` (no separate table). |

## 5. Academics (`acd_*`)

| Table | Purpose | Notes |
|---|---|---|
| `grade_levels` | Grade/level taxonomy | tenant, `code` unique(tenant) |
| `classes` (or `academic_classes`) | Class per year | tenant, year FK, grade_level FK, `name`; avoid reserved word `classes` in SQL → table `acd_classes` |
| `sections` | Sections of class | unique(tenant, class_id, code) |
| `subjects` | Subject catalog | unique(tenant, code) |
| `class_subjects` | Subject offering in class | unique(class_id, subject_id), `teacher_id NULL` |
| `teacher_assignments` | Teacher ↔ class/subject/period scope | unique constraints per scope |
| `timetable_slots` / `timetable_entries` | Weekly grid | unique(tenant, section_id, weekday, period_no); FKs teacher, subject, room |
| `periods` | Period definitions | tenant: `period_no`, time range, CHECK no overlap via exclusion constraint on tstzrange where same tenant+campus |
| `homework` / `assignments` | Tasks | FK class/subject/teacher, due date, `file attachments` via junction |

### Phase 4.2 — grade levels, subjects, class-subject links & teacher assignment (migration 0009)

Implemented (RLS FORCE on all four; tenant-scoped SELECT/INSERT/UPDATE; privileged-only hard DELETE; runtime grants `school_app_rw`; SECURITY INVOKER triggers; composite tenant-aware FKs):

- **`grade_levels` / `subjects`** — tenant-scoped catalog, `code` live-unique per tenant (partial unique index on `(tenant_id, code) WHERE deleted_at IS NULL`, so a soft-deleted row may reuse its code), `status` CHECK `(active|inactive)`. Delete guards (55000) refuse dropping a grade level referenced by live classes (`grade_level_has_classes`) or a subject with live class links / live teacher assignments.
- **`acd_classes.grade_level_id`** — nullable FK to `grade_levels`; classes pin (tenant, campus, academic_year); the soft-delete guard also refuses deletion while live class_subjects or live teacher_assignments reference the class.
- **`class_subjects`** (link) — (class, subject) live-unique per tenant; copy of campus + academic_year from the parent class **pinned by composite FKs** to the class row (class must be live; the subject must be live — this is the FK-pin mechanism). A live unique index on `(tenant_id, class_id, subject_id)` masks FK-pin errors (both constraint classes surface before the FK check on an already-live pair → consumers get `class_subject_already_linked`).
- **`teacher_assignments`** — the assignment row copies campus/year from the parent class (same composite-FK pin); `memberships_tenant_user_uq` (unique `(tenant_id, user_id)` on `memberships`) anchors `(tenant_id, teacher_user_id) → memberships`. No `teachers` table: `trg_teacher_assignments_validate` (SECURITY INVOKER) re-verifies on INSERT/live-UPDATE that the class-subject link is live and that the teacher is an ACTIVE membership holding the tenant-scoped `teacher` role (55000 → `teacher_not_active`); it **skips** eligibility on soft-delete so unassignment always works even after the teacher was suspended. One live assignment per (class, subject).

Cross-cutting (documented for trigger authors): BEFORE triggers run **before** RLS `WITH CHECK`, so a cross-tenant INSERT on `class_subjects`/`teacher_assignments` surfaces as FK 23503 (parent "not found"), not 42501 — routes map that text to a 404. The subject delete guard checks live links before live assignments; a live assignment always implies a live link, so its `subject has live teacher assignments` branch is defense-in-depth (unreachable via honest writes).

### Phase 4.2 — controlled display-name helper (migration 0010)

`user_profiles` is self-visible only (select policy requires `app_current_user_id() = user_id` | platform | privileged), so member-facing name lookups can't join it. `app_safe_user_display(user_id, tenant_id)` is a SECURITY DEFINER (owner `school_migrator`, `SET search_path`) helper that returns the target member's `full_name` only when BOTH caller and target hold ACTIVE memberships in the given tenant — closing cross-tenant exfiltration while letting tenant staff name their own teachers. The eligible-teacher directory uses it after filtering memberships to the `teacher` role.

### Phase 4.3 — bell periods, the weekly timetable grid & homework (migration 0011; trigger refinement 0012)

Implemented with the same § conventions as Phase 4.2: RLS `ENABLE` + `FORCE`, tenant-scoped SELECT/INSERT/UPDATE, privileged-only hard DELETE, `school_app_rw` grants, SECURITY INVOKER triggers, composite tenant-aware FKs:

- **`periods`** — the bell set. `campus_id NULL` = the tenant-wide set (a single conflict domain via `COALESCE(campus_id, zero-uuid)`). `period_no` live-unique per (tenant, campus); **no overlapping time ranges** via a GiST `EXCLUDE USING gist` over `tstzrange([start_time, end_time))` on the fixed epoch date (23P01 → `period_time_overlap`); CHECK `start_time < end_time`. Status CHECK `(active|inactive)` — inactivating a period does NOT drop lessons (the grids keep their snapshot), but a period may not be soft-deleted while LIVE entries reference it (`period_has_entries`).
- **`timetable_entries`** — one weekly grid cell per (section) × (weekday 1..7) × (period). The `timetable_entries_section_slot_live_uq` partial unique index makes the slot itself a conflict domain (23505 → `timetable_slot_conflict`). The row carries a copy of `campus_id` + `academic_year_id` **pinned** by composite FKs to the live `sections` parent (pinned again to the class); `teacher_user_id` is pinned to the live `teacher_assignment` of (class, subject) — a lesson always runs under the assigned lead teacher and the column is never client-writable. `trg_timetable_entries_validate` re-verifies on INSERT **and** live UPDATE that the section, class-subject link (55000 `homework_subject_not_in_class`/`…` territory) and assignment are live, and enforces the teacher spread: no two LIVE entries may give the same teacher the same weekday in OVERLAPPING periods (55000 `teacher_double_booked`). **Migration 0012** refines the spread check to exclude the exact same `(section, weekday, period)` pair, so a genuine in-section duplicate surfaces as the partial unique index's 23505 (`timetable_slot_conflict`) instead of being masked by the 55000 branch.
- **`homework` / `homework_attachments`** — assignments per (class, subject) with `title`, `body`, `due_at`; authorship is *anchored to the assignment*, not the session: `trg_homework_validate` pins `teacher_user_id` to the live `teacher_assignment` of (class, subject) and requires the class-subject link (55000 `homework_subject_not_in_class` / `homework_teacher_not_assigned`). Attachments are create-only, a junction to `files` pinned by the composite FK (a file must exist and belong to the tenant), unique per (homework, file).
- **Cross-table delete guards (55000)** — extend the existing families with the timetable payload: a section with live lessons refuses soft-delete (`section_has_timetable`), a subject with live schedule refuses delete or live-status flip (`subject_has_schedule`, `subject_has_homework`), a class with live homework refuses delete (`class_has_homework`), an assignment with live lessons refuses unassignment (`assignment_has_schedule`). Bounding note: `class_has_timetable` is **unreachable as a first-line guard** — every lesson's composite FK pins a live section, and the section's own guard already refuses deletion while live lessons exist, so `class_has_sections` always fires first (test 17 of the DB suite proves the dominance property directly).

- **`students.user_id` (migration 0013, Phase 4 finalization)** — the student-portal identity that closes the Phase 4.3 gap. Nullable by default; the composite tenant-aware FK `students(tenant_id, user_id) → memberships(tenant_id, user_id)` anchors on the 0009 `memberships_tenant_user_uq` index so a link can only ever point at a member of the SAME tenant. `trg_students_user_link_validate_biu` (SECURITY INVOKER, fires on INSERT and `UPDATE OF user_id`) demands an ACTIVE membership → otherwise `55000` → `student_link_requires_membership`; because the lookup runs under the invoking role's RLS it is automatically tenant-local (a foreign membership is invisible, never probeable). One LIVE student per (tenant, user) is pinned by the partial unique `students_tenant_user_uq` (`23505` → `student_user_already_linked`); soft-deleted history keeps its link. Suspending a membership after linking deactivates the portal (all role-code lookups are active-only).

Event vocabulary (10 new): `period.created|updated|deleted`, `timetable.entry.created|updated|deleted`, `timetable.published`, `homework.created|updated|deleted` — ids-only payloads; the worker has auto log-only handlers (events 74 → 84, keep `EVENT_ARCHITECTURE.md` green).

## 6. Attendance (`att_*`)

| Table | Purpose | Notes |
|---|---|---|
| `attendance_days` | Student daily attendance | unique(tenant, student_id, date); `status (present|absent|late|excused)`, `marked_by`, `source (manual|period)` |
| `attendance_periods` | Period-level | unique(tenant, student_id, date, period_no) |
| `staff_attendance` | Employee attendance | unique(tenant, employee_id, date), times |
| `leave_requests` | Student/staff leave | `type`, range, `status (pending|approved|rejected)`, approver FK, decision_at |
| Attendance rows are **mutable only same-day** (corrections create audit + optional correction row); reports read snapshots. |

## 7. Audit logging (shared `audit_logs`)

| Field | Notes |
|---|---|
| `id` | UUIDv7 |
| `tenant_id NULL` | platform events NULL + `scope='platform'` |
| `actor_user_id NULL`, `actor_type (user|system|job)` | |
| `action` | `student.created`, `fee.payment.recorded`, `exam.result.published`, `user.role.changed`, `subscription.changed` |
| `resource_type`, `resource_id` | indexed (`tenant_id, resource_type, resource_id, occurred_at DESC`) |
| `old_value jsonb NULL`, `new_value jsonb NULL` | **diffs only**, secrets/passwords/totp forbidden (writer filters keys via denylist) |
| `request_id`, `trace_id`, `ip inet`, `user_agent text` | |
| `occurred_at` | indexed with tenant |

Append-only: enforced **at the RLS policy level** — `audit_logs` carries only an INSERT and a SELECT
policy (`0001`), i.e. no UPDATE/DELETE policy exists, so **no role** (not even the privileged
`school_migrator`) can mutate or delete rows; this is verified live (`delete from audit_logs` matches
zero rows under `school_migrator`). Retention: per DATA_RETENTION.md (default 1 year hot, archive
after — archiving reads + purges via a privileged maintenance path). Written **in the same
transaction** as the change. `outbox_events` has explicit INSERT/READ/UPDATE and privileghed-only
DELETE policies (workers dispatch, maintenance purges); `idempotency_keys` uses a single
`FOR ALL` tenant/platform/privileged policy (TTL cleanup via DELETE).

## 8. Exams and results

| Table | Purpose | Notes |
|---|---|---|
| `exam_types` | e.g. Unit test, Midterm | tenant catalog; `code` immutable, cannot be deactivated while a live exam references it |
| `grading_scales` | Grade bands as ordered `bands` jsonb | versioned (`code` + `version`, `version` server-owned), at most one active version per code; bands must TILE 0..100 — checked by trigger, in any input order; band labels unique per scale; once a scale has produced a result its bands are frozen — create a new version |
| `exams` | Exam instance per term | `status (draft\|scheduled\|grading\|published\|cancelled)`, one-way lifecycle, `grading_scale_id` optional (NULL = the tenant's newest ACTIVE scale, PINNED at `grading`; a NAMED scale must be active) |
| `exam_subjects` | Subject session of an exam | unique(exam, class_subject); `max_marks`, `weight` (> 0) — frozen once the exam reaches `grading` |
| `exam_schedules` | Date/time/room | FK exam_subject |
| `marks` | Grade entry | unique(exam_subject, enrollment_id); `marks_obtained <= max_marks`; `status (provisional\|locked\|rechecked)`; `percentage`, `grade_label`, `grade_point` are DERIVED by trigger and can never be posted; `published_exam_id` + `frozen_at` are the server-owned PUBLICATION MARKER (both set or both NULL, migration 0017); `updated_at` is maintained by trigger |
| `mark_corrections` | Append-only ledger | (old, new, reason, actor); INSERT + SELECT only for the runtime role, and a trigger refuses UPDATE/DELETE even for a privileged session |
| `report_cards` | Generated artifact | versioned per (student, exam): one active version; `status (draft\|published)`, published rows immutable AND hard-DELETE guarded; a changed recomputation mints `version + 1` |

Invariants enforced in the DATABASE, not in application code (each has a test in
`packages/db/src/security/phase6-exams.test.ts`):

- The exam lifecycle is one-way and terminal: `published` and `cancelled` never move, and
  publication is not reachable through a plain status UPDATE.
- Publication requires a real result set (at least one subject session and one mark) and
  locks every provisional mark of the exam in the same transaction. Each locked mark is
  STAMPED (`published_exam_id` + `frozen_at`) in that same transaction, so "this result is
  published" is a fact on the row rather than an inference from the exam.
- The marker is immutable and server-owned. It is deliberately independent of the mutable
  `exam_subject_id`: a published mark cannot be re-homed to another subject session, nor
  soft-deleted, nor moved into a different published exam. Its presence is what publication
  keys on to re-derive, so the frozen `percentage`/`grade_label`/`grade_point` cannot be
  changed retroactively by a later scale change.
- Only the correction workflow may change a published mark's value, and only
  `marks_obtained`; anything else about a frozen mark is refused.
- The grading scale of an exam is PINNED the moment the exam can hold marks (`grading`),
  and the pin is what resolution reads — so retiring a scale later cannot silently change
  what a published result means.
- Grading bands must tile 0..100 without gaps or overlap, and an exam may not name a
  dormant or deleted scale (otherwise every mark of that exam would silently grade NULL).

## 9. Finance (`fin_*`) — see FINANCE_DESIGN.md for rules

| Table | Purpose | Notes |
|---|---|---|
| `fee_structures` / `fee_items` | Fee templates per year/class | versioned; unique(tenant, year, code, version) |
| `fee_assignments` | Student's applied fees | student+year+item unique |
| `invoices` | Bill to guardian | `invoice_no unique(tenant_id, invoice_no)`, `tenant_id`, `currency`, `subtotal`, `discount_total`, `total`, `amount_paid`, `amount_refunded`, `status (draft|issued|partially_paid|paid|void)`, `issued_at`, `student_id`, `academic_year_id`; **CHECK amounts >= 0**; issued invoices: money columns updated only via payment/refund procedures (below) |
| `invoice_items` | Lines | FK invoice CASCADE, `fee_item_id NULL`, `description`, `amount numeric(19,4) CHECK (amount>=0)`; immutable once `issued` |
| `invoice_adjustments` | Discounts/scholarships/fines | append-only per invoice, `type`, `amount (+/-)`, `reason`, `approved_by` |
| `payments` | Money received | `payment_no unique(tenant)`, `invoice_id NULL` (on-account), `amount numeric CHECK (>0)`, `method`, `provider`, `external_id`, `status (pending|settled|failed|reversed)`, `received_at`, `idempotency_key unique(tenant_id, idempotency_key)`; **INSERT-only; reversal via compensating row** |
| `payment_allocations` | Payment ↔ invoice splits | unique(payment_id, invoice_id), amount > 0 |
| `receipts` | Issued receipts | unique(tenant, receipt_no), FK payment, `issued_at`, immutable (regenerate reprints, don't edit) |
| `refunds` | Refund requests | unique(tenant, refund_no), payment FK, amount ≤ refundable (CHECK via trigger), `status (requested|approved|processed|rejected)`, idempotency_key unique(tenant) |
| `ledger_accounts` / `ledger_entries` | Double-entry | entries: `tenant_id`, `account_id`, `direction (debit|credit)`, `amount > 0`, `entry_group uuid` (balanced per group — trigger verifies sum debits = credits), **INSERT-only**; reconciliation = reversing groups |
| `payment_gateway_webhooks` | Raw webhook store | `provider`, `external_id`, `signature_valid`, `processed_at`, raw jsonb; unique(provider, external_id) for replay protection |
| Immutability trigger: `BEFORE UPDATE OR DELETE ON invoices/payments/receipts/ledger_entries` → RAISE except via `app.allow_immutable_update` GUC set only inside controlled correction functions. |

## 10. HR (`hr_*`)

`employees` (unique(tenant, employee_no), `user_id NULL`), `positions`, `employee_assignments`, `leave_types`, `salary_structures` (versioned), `salary_components` (allowance/deduction), `payroll_runs` (period, `status (draft|approved|posted)`, `posted_at` — posted runs immutable), `payslip_lines` (insert-only after post, `file_id`), `employee_leave_balances`.

## 11. Library (`lib_*`)

`books` (ISBN unique per tenant), `book_editions/copies` (barcode unique per tenant, `status`), `authors`, `categories`, `book_authors` M2M, `loans` (unique active loan per copy — partial unique `WHERE returned_at IS NULL`), `reservations`, `library_fines` (links to finance via `fin_payment_allocations` or standalone small ledger).

## 12. Transport (`trn_*`)

`vehicles` (plate unique per tenant), `drivers`, `conductors` (employee FKs), `routes`, `stops`, `route_stops` (order), `vehicle_assignments`, `student_transport_assignments` (unique(student, year, route)), transport fee items reuse `fin_fee_items`.

## 13. Communication (`com_*`)

`notification_templates`, `notifications` (tenant, user/student target, `status`, dedupe key), `announcements` (audience scope jsonb + materialized recipient query stored), `message_threads`/`messages` (school community messaging), `outbox_events` (§14), `email_outbox`/`sms_outbox` job rows or handled purely via jobs.

## 14. Outbox & jobs (`evt_*`, `job_*`)

| Table | Purpose | Notes |
|---|---|---|
| `outbox_events` | Transactional events | `tenant_id NULL` platform, `event_type`, `payload jsonb`, `created_at`, `processed_at NULL`, `attempts`; idx `(processed_at) WHERE processed_at IS NULL`; append-only payload |
| `job_runs` | Idempotency/dedupe | (`queue`,`job_name`,`idempotency_key`) unique, `status`, `attempts`, `last_error`, `finished_at` |
| `idempotency_keys` | API Idempotency-Key | (`tenant_id`, `key`) unique, `request_hash`, `response_status`, `response_body jsonb`, `expires_at` |

## 15. Files (`fil_*`)

`files` (global id, `tenant_id NOT NULL` + RLS, `storage_key unique`, `content_hash`, `mime`, `size_bytes`, `visibility (private|tenant_portal)`, `owner_type/owner_id`, `created_by`, `scan_status (pending|clean|blocked)`), `file_access_logs` (append-only).

## 16. AI (`ai_*`)

`ai_conversations` (tenant, user, `scope`), `ai_messages`, `ai_tool_calls` (conversation FK, tool name, args digest, result digest, `permission_snapshot`, duration, tokens) → audit-linked, `ai_usage` counters → feeds `plt_usage_counters`.

## 17. Critical composite indexes (pattern examples)

- All tenant tables: `(tenant_id, created_at DESC)` + entity-specific e.g. `students (tenant_id, status, last_name)` where active.
- `enrollments (tenant_id, academic_year_id, class_id, section_id)`.
- `invoices (tenant_id, status, issued_at DESC)`, partial index `(tenant_id) WHERE status IN ('issued','partially_paid')` for aging reports.
- `audit_logs (tenant_id, occurred_at DESC)`, `(tenant_id, resource_type, resource_id)`.
- `outbox_events (created_at) WHERE processed_at IS NULL`.

## 18. Foreign key / cascade summary

- Operational children: RESTRICT.
- Line items of mutable headers (invoice lines while draft): CASCADE on draft delete; issued headers cannot be deleted (RESTRICT path via status guard).
- Users: memberships RESTRICT user delete while audit references exist → users soft-disable, purge job anonymizes PII after retention (DATA_RETENTION.md).
- Tenants: never hard-deleted by FK cascade from operational rows; deletion is an orchestrated state machine.

## 19. Migration discipline

- SQL files in `packages/db/migrations/NNNN_name.sql`, applied by Drizzle-kit/custom runner as `migrator` role.
- Every tenant table creation script must include RLS policy creation + isolation test registration.
- Expand/contract pattern for zero-downtime deploys (add nullable → backfill → constrain → drop).
- No destructive ops without reviewed rollback note in migration header.
