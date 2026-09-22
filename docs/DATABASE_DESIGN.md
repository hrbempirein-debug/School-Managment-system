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
| `auth_identities` | Credentials | (`user_id`,`provider`) unique — `password` (argon2id hash), `totp_secret_enc`, `mfa_enabled`; REVOKE for mass exports |
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

Append-only: no UPDATE/DELETE grants for `app_rw`. Retention: per DATA_RETENTION.md (default 1 year hot, archive after). Written **in the same transaction** as the change.

## 8. Exams (`exm_*`)

| Table | Purpose | Notes |
|---|---|---|
| `exam_types` | e.g. Unit test, Midterm | tenant catalog |
| `exams` | Exam instance per term | FK term, `status (draft|scheduled|grading|published|cancelled)` |
| `exam_subjects` | Subject session of exam | unique(exam, class_subject); `max_marks numeric`, `weight numeric` |
| `exam_schedules` | Date/time/room | FK exam_subject |
| `marks` | Grade entry | unique(exam_subject, enrollment_id); `marks_obtained numeric CHECK (>=0 <= max)`, `status (provisional|locked|rechecked)`, entered_by, locked_at |
| `grading_scales` | Grade bands | tenant (+ optional global template), versioned `version int`, CHECK bands non-overlapping (app validation + trigger) |
| `report_cards` | Generated artifact | unique(student, exam), `file_id`, `status (draft|published)` — published snapshot immutable; corrections → new version row (`version int`, partial unique on active) |
| Published marks: UPDATE allowed only via **correction workflow** (permission `exams.correct`) which writes `mark_corrections` audit table (old,new,reason) + audit log. |

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
