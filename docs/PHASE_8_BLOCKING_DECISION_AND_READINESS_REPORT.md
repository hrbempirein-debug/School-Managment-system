# PHASE 8 — BLOCKING DECISION & PRE-IMPLEMENTATION REMEDIATION AUDIT

**Status:** READ-ONLY AUDIT — NO CHANGES APPLIED TO CODE, SCHEMA, DEPENDENCIES, OR GIT.
**Output of:** Phase 8 readiness gate, prompt 2 of 2 (blocking decisions + threat model).
**Companion:** Phase 8 reconnaissance report (prompt 1).

---

## 1. Baseline verification (gate precondition)

| Field | Value |
|---|---|
| `pwd` | `G:/School Managment system` |
| `git branch --show-current` | `master` |
| `git rev-parse HEAD` | `5bf11d0067424ea6e372f92f536e4af0aa795552` |
| `git log -1 --oneline` | `5bf11d0 feat(finance): complete phase 7 fees and finance` |
| `git diff --stat` | *empty* |
| staged files | *none* |
| `origin/master` | `d12b90416b2104846a3eee028c2de5460f1727c1` — **HEAD is 1 commit AHEAD** |
| migrations present | **34** (`0001` … `0028_phase7_finance_security_mfa_encrypt_remediation.sql`) |
| latest applied prefix | `0028` |
| `0029` | **RESERVED** for `fin_artifacts_webhooks.sql` (`docs/PHASE_7_FINANCE_DESIGN.md:13717`) |
| quarantined drafts | `packages/db/migrations-not-authorized/{0026_fin_ledger,0027_fin_reconciliation,0028_fin_runtime_security,0029_fin_final}.sql` — **must remain quarantined** |

Untracked paths observed in `git status --short` (all pre-existing, none created by this audit, none touched):

```
?? .r11_map.json
?? .tmpgate/
?? __pycache__/
?? packages/db/migrations-not-authorized/
?? packages/db/{console.error(e.code
?? testconn.mjs
```

**Verdict: BASELINE MATCHES. Gate may proceed.**

Test-file census (files counted, suites deliberately **not** re-run — they mutate databases):

| Package | `.test.ts(x)` files |
|---|---|
| `packages/db` | 30 |
| `apps/api` | 24 |
| `apps/worker` | 7 |
| `apps/web` | 14 |

Phase 7 HEAD commit = **37 files changed**, +26,102 / −878.

---

## 2. What Phase 8 is, architecturally

Phase 8 is **greenfield**. Verified by exhaustive search — every one of these has **zero** code, migration, route, permission, or frontend occurrences:

| Artifact | State |
|---|---|
| `com_*` tables | absent |
| `notification_templates` table | absent |
| `notifications` / `announcements` / `message_threads` / `messages` tables | absent |
| consent / preference / unsubscribe tables | absent |
| `communication.*` permission | absent from `PERMISSION_CATALOG` and from every migration |
| webhook endpoints (inbound) | absent from `apps/api/src` |
| provider adapters (mail/SMS/push) | absent |
| consumer for queue `mail` | **exists but is log-only** (`apps/worker/src/worker.ts:214-224`) |
| code reading `SMTP_*` / `SMS_*` | **absent** (`.env.example:71-79` defines them; nothing reads them) |
| `nodemailer` | **absent from every `package.json`** |
| communication UI | absent from `apps/web/app/{attendance,homework,login,parent,platform,school,student}` |

Design documents that describe Phase 8 as if it existed:

- `docs/DEVELOPMENT_ROADMAP.md:93-101` — goal, DB, API, FE, worker, tests, security, acceptance.
- `docs/DATABASE_DESIGN.md:234` — §13 `com_*` naming.
- `docs/EVENT_ARCHITECTURE.md:109` — Phase 8 emits `notification.requested`, `announcement.published`.
- `docs/PHASE_7_FINANCE_DESIGN.md:278` — dunning deferred to Phase 8.

**Conclusion:** there is no legacy to preserve inside Phase 8 itself. Every Phase 8 decision is a first-time contract. The *blockers* are therefore not Phase 8 code — they are pre-existing defects and contract ambiguities in Phases 1–7 that Phase 8 will step on.

---

## 3. D3 — Worker database identity (**P0, architecture decision required**)

### 3.1 Evidence

| Source | Finding |
|---|---|
| `scripts/bootstrap.sql:19-20` | Stated intent: `school_migrator` → owns objects, runs DDL. `school_app_rw` → "runtime role used by **API + worker** (DML only, no BYPASSRLS)" |
| `apps/worker/src/worker.ts:328` | `createDb({ url: env.DATABASE_URL_MIGRATOR, ... })` → worker connects as **`school_migrator`** |
| `apps/api/src/server.ts:8` | `createDb({ url: env.DATABASE_URL_APP, ... })` → API connects as **`school_app_rw`** |
| `packages/db/migrations/0002_trusted_context.sql:58-61` | `app_privileged() = SELECT current_user IN ('school_migrator')` |
| 164 policy definitions across `0001`,`0004`,`0005`,`0014`,`0015` | every one terminates with `OR app_privileged()` |
| `0001:209-210`, `0004:219-220` | `ENABLE ROW LEVEL SECURITY` **and** `FORCE ROW LEVEL SECURITY` are both applied |
| `apps/worker/src/worker.ts:49-54` | **The doc comment states the design explicitly** |
| `packages/db/src/client.ts` `withGuc(..., {system:true})` | sets `app.rls` to `''` → `app_ctx_claims()` returns `NULL` (`0002:130-133`) → `app_current_tenant_id()` is `NULL` |
| `0028:733-742` `app_finance_emit_event` | explicitly permits the migrator's empty ticket: `IF v_session_tenant IS NULL THEN IF session_user <> 'school_migrator' THEN RAISE` |

The worker's own documentation (`worker.ts:49-54`):

> The session is the trusted executor (school_migrator), so `app_privileged()` is true and app.rls is cleared via `set_config('app.rls', '', true)` … **Tenant scoping for handlers is therefore DATA-based: a handler must select the intended tenant's rows by `event.tenant_id`, never rely on context.**

### 3.2 Corrected severity model

My prompt-1 wording ("worker bypasses RLS entirely") was **mechanistically wrong** and must be corrected on the record:

- `FORCE ROW LEVEL SECURITY` *is* set, so the table-owner attribute bypass does **not** apply.
- `school_migrator` has **no** `BYPASSRLS` and is **not** superuser — `scripts/bootstrap.sql:43-44`, `scripts/bootstrap-check.js:115-121`, `.github/workflows/phase6-security.yml:179-196`.
- RLS **is evaluated on every statement**.
- The escape is *inside* the policy predicate: `OR app_privileged()` short-circuits to `TRUE` for `current_user = 'school_migrator'`.

**Net effect on data visibility is identical to a bypass**, but the mechanism is a deliberate, documented policy predicate — not an attribute misconfiguration. That distinction matters, because it means this is a **design that must be enforced**, not a **bug that must be patched**.

### 3.3 Architecture options

| Option | Description | Assessment |
|---|---|---|
| **A** | Switch worker to `DATABASE_URL_APP` (`school_app_rw`) | **Rejected.** Breaks `app_privileged()` for every handler; `app_finance_emit_event` would raise `42501` unless a ticket matches (`0028:733-742`); `markProcessed` / dispatcher `withSystem` cross-tenant scan would fail; attendance summary scheduler (`worker.ts:308-331`) iterates all tenants; all 7 worker tests construct pools with `DATABASE_URL_MIGRATOR` (`attendance.test.ts:111`, `documents.test.ts:62`, `exams-result-pipeline.test.ts:133,136`, `outbox-integration.test.ts:57`, `student-import.test.ts:64`). Requires a migration + bootstrap rewrite. |
| **B** | Keep `school_migrator`; make the documented data-based tenant invariant **mechanically enforceable** | **SELECTED.** No schema, no bootstrap, no dependency change. Turns a prose comment into a test-enforced contract. |
| **C** | Third role `school_worker_rw` (not owner, not in `app_privileged()`), real signed ticket per event with tenant claim | **Deferred.** Cleanest long-term model, but requires `CREATE ROLE` (bootstrap, out of scope), new grants on every Phase 8 table, and a rewrite of `withSystem` semantics. |
| **D** | `SET ROLE school_app_rw` after connecting as migrator | **Rejected.** `session_user` stays `school_migrator`, so `app_finance_emit_event:735` still takes the empty-ticket branch — a confusing half-measure where `current_user` and `session_user` disagree. |

### 3.4 DECISION D3-1 — worker tenant isolation is a **test-enforced data invariant**

**Chosen: Option B, with Option C recorded as mandatory post-gate hardening.**

The contract Phase 8 must satisfy, in full:

1. **Every** query inside an `OutboxHandler` that reads or writes a tenant-scoped table MUST include an explicit predicate equivalent to `tenant_id = <event.tenantId>` (or `= <the alias derived from it>`), for **every** joined table, not just the root.
2. `event.tenantId` may be `NULL` **only** for platform-scope events. A handler receiving a `NULL` tenantId on a tenant-scope event MUST throw (fail-closed), not no-op.
3. An AST/lint rule (or a pure-regex gate over `apps/worker/src/**.ts`) MUST reject any `tx.select(...)` inside a handler module that has no `tenantId` reference. Known-exceptions list is empty by default and requires a documented waiver.
4. An isolation test MUST seed a **foreign-tenant row** into every table Phase 8 touches and assert that a handler processing tenant A's event cannot read or mutate it. This mirrors the existing pattern in `packages/db/src/security/finance-rbac.test.ts`.
5. Option C (`school_worker_rw`) MUST be opened as a tracked follow-up item, explicitly gated on migration authorization, and referenced from this document.

**Rationale:** the invariant already exists and is documented at `worker.ts:49-54`. What is missing is enforcement. Phase 8's own acceptance criterion — *"Announcement reaches exactly configured audience across two tenants with zero cross-lean"* — is unsatisfiable without (1) and (4).

---

## 4. D1 — Queue routing is a two-value ternary (**P0 contract**)

### 4.1 Evidence

`apps/worker/src/worker.ts:86-92`:

```ts
const target: Queue | undefined =
  job.queue === 'mail' ? (queues.mail as Queue) : (queues.events as Queue);
```

`packages/jobs/src/queues.ts:45-50` defines the correct, table-driven router — and it is **dead code**:

```ts
export function queueForJob(jobName: string): JobQueueName {
  const mapped = JOB_NAME_TO_QUEUE[jobName];
  if (mapped === 'mail') return 'mail';
  if (mapped === 'reports') return 'reports';
  return 'events';
}
```

`JOB_NAME_TO_QUEUE` (`packages/contracts/src/jobs.ts:49-54`) maps all 4 job names.

Deferred jobs in production code:

| Site | `queue:` value | Routed to |
|---|---|---|
| `apps/worker/src/attendance.ts:109,174` | `'mail'` | `mail` ✔ |
| `apps/worker/src/exams.ts:579` | `'mail'` | `mail` ✔ |
| **`apps/worker/src/exams.ts:523`** | **`'reports'`** | **`events` ✘** |

### 4.2 Failure trace (D1 is live, not theoretical)

`exams.ts:513-533` `report_card.generated` → `defer({ name: 'report.studentReportCard', queue: 'reports', data: {...} })`
→ `enqueueDeferred` sends it to **`events`**
→ `eventsWorker` runs `processEvent` (`worker.ts:126`)
→ `outboxEventSchema.safeParse(job.data)` — `job.data` is `{reportCardId, tenantId, idempotencyKey, correlationId}`, **not** an outbox envelope → **parse fails**
→ `failEvent(db, id, ...)` where `id = job.data.event?.id ?? job.id`; `job.data.event` is `undefined`, so `id = job.id` (BullMQ auto id, not a UUID) → `UPDATE outbox_events SET last_error … WHERE id = <non-uuid>` → **matches zero rows, silent no-op**
→ rethrow → BullMQ retries ×3 (`buildQueue` default `attempts: 3`, `packages/jobs/src/queues.ts:25`) → job fails.

**Consequences:**
1. `report.studentReportCard` **never executes** — no PDF artifact, in any environment.
2. The `reports` queue is starved of real work; its consumer idles.
3. Every such attempt writes a misleading `event job failed` log line naming a non-existent eventId (`worker.ts:247-249`).
4. The failure is *silent in the outbox* — `processed_at` never moves and `last_error` never updates, so no outbox-based alert would ever fire.

### 4.3 DECISION D1-1 — routing must be table-driven and fail closed

**Contract:**

1. `enqueueDeferred` MUST resolve the target queue via `JOB_NAME_TO_QUEUE[job.name]` — the ternary is **deleted**.
2. An unknown job name MUST **throw**, never fall back to `events`. Silent fallback is the root cause of D1.
3. `JobQueueName` MUST be extended in the same change that introduces the `sms` and `push` queues (roadmap `:99`), keeping `JOB_NAME_TO_QUEUE` exhaustively typed (`Record<string, JobQueueName>` plus a `never` check).
4. `packages/jobs/src/queues.ts:queueForJob` becomes the **single** exported router; `worker.ts` must not carry a second copy.
5. A test MUST assert that every value of `queue:` appearing in a `defer({...})` call site resolves to a non-`events` queue unless the job name is genuinely an event job — i.e. a bidirectional pin over the 4 (future: 6) job names.

**Phase 8 impact:** Phase 8 adds `mail` (real), `sms`, `push` queues. Without this decision the same ternary silently collapses `sms`/`push` onto `events`, producing exactly the D1 failure mode across the entire Phase 8 send path. **This is a Phase 8 blocker, not a Phase 6 bug.**

---

## 5. D2 / B1 — Event-type registry parity (**P0, live broken state**)

### 5.1 Mechanical census

I mechanically diffed every event-type-shaped string in `apps/` + `packages/` (`.ts` and `.sql`) against `outboxEventTypeSchema`.

**Outbox catalog:** 93 members (`packages/contracts/src/events.ts:3-145`).
**Registry pin:** `apps/worker/src/worker-event-registry.test.ts:48-58,75` — `HANDLED` = **9**, catalog pinned at **93**.

| Emission surface | Distinct types | In enum? |
|---|---|---|
| API `enqueueOutbox(...)` / `eventType:` | **72** (plus 1 test fixture, `mystery.thing`) | **72 / 72 ✔** |
| DB `app_finance_emit_event('…')` in `packages/db/migrations/*.sql` | **3** | **0 / 3 ✘** |

The three DB-emitted, unregistered types:

```
refund.approved     (0028:1144)
refund.rejected     (0028:1241)
refund.processed    (0028:1291)
```

`grep -c refund packages/contracts/src/events.ts` → **0**.
`grep -rn refund apps/worker/src/*.ts` (excluding tests) → **0 handlers**.

### 5.2 Failure trace (D2)

1. Refund approves → `app_finance_emit_event('refund.approved', …)` inserts a real `outbox_events` row. Tests confirm it: `finance-refund-state-machine.test.ts:421,434,502`, `finance-refund-stepup.acceptance.test.ts:586,720,769-770`. **These tests assert only that the row exists — none drives it through the worker.**
2. Dispatcher (`packages/events/src/dispatcher.ts:74-88`) claims it with `FOR UPDATE SKIP LOCKED`, enqueues with `jobId = event.id`, `attempts: 5`, exponential backoff 2000 ms, `removeOnFail: 200`.
3. `processEvent` (`worker.ts:107-110`) → `outboxEventSchema.safeParse` fails on `eventType` → `failEvent` writes `last_error` (correctly this time, because `event.id` **is** a UUID) and rethrows.
4. BullMQ exhausts 5 attempts → job enters `failed`, retained up to 200 jobs.
5. Dispatcher redrive (`dispatcher.ts:63-69`) re-selects the row (`processed_at IS NULL`, `dispatched_at` older than 5 min) and calls `queue.add` with the **same `jobId`**. BullMQ dedupes by `jobId` while the job still exists → **the add is a silent no-op**.
6. Once the failed job is evicted past the 200-job window, step 5 re-creates it → 5 more attempts → fail → repeat.

**Net behaviour: the row is permanently stuck at `processed_at IS NULL`, cycling between "invisible to redrive" and "re-poisoned" forever. It never converges, and it never appears in any completed/failed surface that an operator would naturally watch.**

`docs/EVENT_ARCHITECTURE.md:110` claims "there is no silent ack" and that such rows are "eventually re-processed after the redrive window when a fix lands." That is true only for *transient* failures. For an unregistered type the fix is a code deploy, and until it lands the row is a permanent poison pill. The doc overstates the guarantee.

### 5.3 B1 — `fee.*` dunning events do not exist at all

`docs/PHASE_7_FINANCE_DESIGN.md` asserts repeatedly that Phase 7 emits these:

| Claim | Location | Reality |
|---|---|---|
| "Phase 7 emits `fee.invoice.overdue` for Phase 8 to consume" | `:278` | **0 occurrences** in any `.ts` or `.sql` |
| "`fee.invoice.overdue` … `finance-024` asserts the event is emitted" | `:12385` | no `finance-024` test exists anywhere |
| "`fee.parent.notification.requested` … `finance-024`" | `:12386` | same |
| `fee.billing.run.completed`, `fee.finance_document.generated` (NOOP) | `:12314, 14281, 14296` | same |

Cross-checks:

- `grep -rhoE "'fee\.[a-z0-9_.]+'" --include=*.ts apps/ packages/` → **empty**.
- `0023_fin_invoices.sql` has `due_date` (`:121`) but **no overdue trigger and no scheduled scan**.
- The only overdue *query* anywhere is in the quarantined draft `migrations-not-authorized/0026_fin_ledger.sql:247-248`.
- `outboxEventTypeSchema` contains **zero** `fee.*` members.

So B1 is not "registered-but-noop"; it is **"documented-but-nonexistent" on three layers** (emitter, enum, test).

### 5.4 Related documentation drift discovered during the census

`docs/EVENT_ARCHITECTURE.md:108` Phase 7 row claims:

> `invoice.created`, `invoice.issued`, `payment.received`, `refund.processed`, `invoice.voided`

Actual Phase 7 emission: **only `refund.*`**, all three **unregistered**. The other four are emitted nowhere. The doc is wrong in both directions.

### 5.5 DECISION D2-1 — one catalog, three-way parity, DB-side guard

**Contract:**

1. **`refund.approved`, `refund.rejected`, `refund.processed` MUST be added to `outboxEventTypeSchema`** before Phase 8 begins. This is a contract change in `packages/contracts`, not a schema change — no migration required. Unblocks the live poison state.
2. Parity is asserted by a **single test with three inputs**: (a) the TS enum, (b) every literal passed to `app_finance_emit_event(...)` extracted from `packages/db/migrations/*.sql`, (c) every literal passed to `enqueueOutbox(...)` in TS. Any set-difference fails the build. This closes the gap that let 3 types ship unregistered.
3. **A DB-side guard is mandatory for Phase 8.** A CHECK constraint or BEFORE trigger on `outbox_events.event_type` that rejects any value not in a registered set. Without it, rule (2) protects only committed code — a migration can still insert anything. *(Implementation requires migration authorization; recorded as `MIG-1` in §16.)*
4. `HANDLED` vs intentional-NOOP MUST be explicit for every new Phase 8 type. `worker-event-registry.test.ts` already requires classification of all 93; that test must be extended, not weakened.
5. `docs/EVENT_ARCHITECTURE.md:108` Phase 7 row and `:109` Phase 8 row MUST be corrected as part of Phase 8 doc work.

### 5.6 DECISION B1-1 — dunning is **out of scope for Phase 8**

**Contract:**

1. Phase 8 acceptance is taken from `docs/DEVELOPMENT_ROADMAP.md:102` **verbatim** — announcement audience correctness + DLQ visibility. **Dunning is not in it.**
2. `fee.invoice.overdue` / `fee.parent.notification.requested` are reclassified from *"Phase 7 emits, Phase 8 consumes"* to **"Phase 9+ backlog, blocked on a scheduler primitive."**
3. The five `PHASE_7_FINANCE_DESIGN.md` lines must be corrected (§14, `DOC-1..DOC-4`).
4. Prerequisite recorded: a daily scan job over `fin_invoices WHERE status IN ('issued','partially_paid') AND due_date < CURRENT_DATE` — there is no such scheduler today (only `startAttendanceSummaryScheduler`, `worker.ts:308-331`).

**Rationale:** adding dunning would require a migration (emitter trigger) plus a new recurring job — two out-of-scope changes to satisfy a doc claim that no test and no acceptance criterion depends on.

---

## 6. D5 — Recipient / audience scoping invariant (**P0 for Phase 8**)

### 6.1 Evidence

The canonical relationship ladder is `readableStudentIds()` (`apps/api/src/routes/school/attendance.ts:107-176`), classified by `attendanceVisibility()` (`:96-102`). Exam routes delegate to it (`apps/api/src/routes/school/exams.ts:305-317`).

**Parent branch, `attendance.ts:148-155`:**

```ts
.where(and(
  eq(guardians.tenantId, ctx.tenantId ?? ''),
  eq(guardians.userId, ctx.userId),
  isNull(guardians.deletedAt),
  isNull(students.deletedAt),
))
```

**`studentGuardians.deletedAt` is never filtered.** Confirmed at all three sites that reimplement the join:

| Site | `guardians.deletedAt` | `students.deletedAt` | `studentGuardians.deletedAt` |
|---|---|---|---|
| `attendance.ts:148-155` (`readableStudentIds`) | ✔ | ✔ | **✘** |
| `homework.ts:163-172` (`guardianScopesClass`) | ✔ | ✘ | **✘** |
| `homework.ts:276-290` (class list) | ✔ | ✔ | **✘** |
| `students.ts:262,274` (management routes) | ✔ | ✔ | ✔ |

Management routes get it right; portal routes do not.

### 6.2 Impact on Phase 8

Phase 8's announcement/messaging audience selectors will resolve recipients through this same relationship. A **soft-deleted** guardian↔student link currently grants read access to that student's portal data — and, in Phase 8, would make that guardian a **recipient** of announcements for a family they were removed from. That is a data disclosure, not just a UI bug.

Additional gap: **campus is not an RLS boundary.** `memberships.campus_id uuid` (`0001:97`) has **no FK** and no policy references it. `assertCampusScope` (`apps/api/src/routes/school/util.ts:397-407`) is a route-layer check only. `docs/AUTHORIZATION.md` contains no Phase 8 section.

### 6.3 DECISION D5-1 — one exported resolver, five mandatory predicates

**Contract:**

1. Phase 8 recipient resolution **MUST NOT** re-derive relationships inline. It must call a single exported resolver — extend `readableStudentIds`, or add `resolveAudience(...)` in `apps/api/src/routes/school/util.ts` that wraps it.
2. Every parent-visibility resolution MUST apply **all five** predicates:
   - `guardians.tenantId = ctx.tenantId`
   - `guardians.userId = ctx.userId`
   - `isNull(guardians.deletedAt)`
   - `isNull(students.deletedAt)`
   - **`isNull(studentGuardians.deletedAt)`** ← the missing one
3. `homework.ts:163-172` additionally MUST gain `isNull(students.deletedAt)` (it is missing there too).
4. An isolation test MUST seed (a) a soft-deleted link, (b) a soft-deleted guardian, (c) a soft-deleted student, and assert **zero** recipients from each — for announcements *and* messages, not just attendance reads.
5. **Account-linked recipients only (C-4, binding).** Every Phase 8 recipient must resolve to an authenticated application account. For guardian recipients: `guardians.user_id IS NOT NULL` (`0005:139` — the column is nullable, so contact-only guardians exist) **and** the linked `users` row must be a valid, active account. For student recipients: `students.user_id IS NOT NULL` (`0013:38` — added nullable). Contact-only guardian/student records are **never** Phase 8 communication recipients — an audience selector, recipient resolver, consent evaluator, or delivery creator must never admit one merely because the contact row carries an `email` or `phone`. Resolution **fails closed** when no account-linked recipient exists. `student_guardians.deleted_at IS NULL` remains mandatory (rule 2). Contact-only guardian communication is deferred to a later phase with its own explicit consent/contact model.

### 6.4 DECISION D5-2 — campus is an additive narrowing filter, never a widening one

**Contract:**

1. Campus filtering is applied **after** tenant scoping, inside the same query, as `AND target.campus_id = $campus`.
2. A `null`/absent campus filter means "all campuses the caller can see" — it must never mean "bypass tenant scoping".
3. Cross-tenant leakage is structurally impossible because the tenant predicate is unconditional; campus can only ever shrink the set.
4. `memberships.campus_id` remains without an FK by design (it is nullable and campus-agnostic for platform staff) — recorded as a known deviation from `docs/DATABASE_DESIGN.md:18`, **not** to be "fixed" in Phase 8.

---

## 7. Outbox payload & recipient PII (D4)

### 7.1 Evidence

`packages/events/src/outbox.ts:6-14` redacts by **top-level, 6-key denylist** only. `outbox_events.payload` is `jsonb`, **append-only** by convention (`docs/DATABASE_DESIGN.md:14`), retained indefinitely, and read by the dispatcher.

Phase 8 event payloads will be the first to plausibly carry contact data (`to`, `email`, `msisdn`) — and a nested key such as `payload.recipients[0].email` defeats the current redactor entirely.

### 7.2 DECISION PII-1 — identifiers only in the outbox; resolve contacts at send time

**Contract:**

1. **No `outbox_events.payload` may contain an email address, phone number, or message body.** Permitted fields: `notificationId`, `userId`, `studentId`, `announcementId`, `threadId`, `templateId`, `locale`, `channel`.
2. The worker resolves contact details from the database **at send time**, inside the handler transaction, with an explicit `tenant_id = event.tenantId` predicate (§3.4 rule 1).
3. Consequence: redaction (`D4`) becomes **defence in depth**, not the primary control. Shallow top-level redaction is then *acceptable*, because there is nothing deep to redact.
4. Raw provider payloads are **out of scope** — `fin_webhook_raw_payloads` is explicitly *not created* by `0029` (`docs/PHASE_7_FINANCE_DESIGN.md:13248`), and Phase 8 declares no inbound webhooks (§10).
5. Message bodies live in `notifications.body` / `messages.body`, tenant-scoped + RLS, never in the outbox. **Amended by C-3:** `notifications.body` is the **canonical, template-resolved notification content only**. Each created delivery additionally stores its own **immutable channel-specific rendering snapshot** (see §20.3) — a retry never re-renders, and a later template edit never mutates an already-created delivery's content.

**Rationale:** this is the single cheapest decision in the audit. It removes an entire class of retention/disclosure risk without any schema, dependency, or infrastructure change.

---

## 8. Template storage: global rows vs per-tenant copies

### 8.1 Evidence

- No template table exists. `docs/DATABASE_DESIGN.md:234` names `notification_templates` with no scoping guidance.
- Precedent for `tenant_id IS NULL` rows: `roles` / `role_permissions` / `platform_role_assignments` use `scope = 'platform' AND tenant_id IS NULL`, gated on `app_ctx_scope() IN ('account','platform')` (`0002:379,394,411,414`; `0001:342,354,370,373`).
- `roles_select` (`0001:286-291`) reads tenant roles via membership, platform roles via the platform flag — but **no policy grants a tenant member read access to a `tenant_id IS NULL` row** except through the explicit `scope='platform'` branch.

### 8.2 Options

| | **A — global system templates** | **B — per-tenant copies at provisioning** |
|---|---|---|
| Model | `tenant_id IS NULL, is_system = true`, read-only to tenants; tenant customizations are separate rows with `tenant_id NOT NULL, source_template_id` FK | every tenant gets its own seeded rows on provisioning |
| Migration cost | 1 seed | seed + a backfill for all existing tenants + a re-run hook for future tenants |
| Upgrade path | edit system rows once | must re-seed / diff every tenant |
| Shared-mutable risk | none — system rows are RLS-read-only | none |
| Customization | explicit override rows, clear provenance | implicit; no provenance |
| Failure mode | a bad system row affects all tenants (mitigated: overrides) | a missed seed silently yields a tenant with no templates |

### 8.3 DECISION TMPL-1 — system template + tenant override (Option A)

**Contract:**

1. `notification_templates` carries `tenant_id uuid NULL`, `is_system boolean NOT NULL DEFAULT false`, `source_template_id uuid NULL` (self-FK, only when `tenant_id IS NOT NULL`).
2. **Invariant:** `tenant_id IS NULL ⟺ is_system = true`. Enforced by CHECK.
3. RLS:
   - SELECT: `tenant_id = app_current_tenant_id()` **OR** (`tenant_id IS NULL AND is_system`).
   - INSERT/UPDATE/DELETE: `tenant_id = app_current_tenant_id() AND NOT is_system`.
   - → **a tenant can never mutate a system template**, only shadow it.
4. Rendering resolves `tenant override → fall back to system row` in one query (`COALESCE` over a lateral join), so a tenant with no overrides still renders.
5. Branding/locale substitution happens at render time with **escaped** substitution (`docs/DEVELOPMENT_ROADMAP.md:101`: *"content injection into templates escaped"*). Template bodies are stored with `{{ }}` placeholders and never `eval`'d.

**Rationale:** no per-tenant seed migration (Phase 8 gets 5 migration IDs, §12 — spending one on a backfill across all tenants is poor value), clear provenance, and the RLS shape reuses an established `tenant_id IS NULL` idiom rather than inventing a second one.

---

## 9. Delivery: queues, dedupe, consent, abuse

### 9.1 DECISION DEL-1 — send-time idempotency lives on `notifications`, not on `job_runs`

Evidence (D6): `job_runs` is specified in `docs/DATABASE_DESIGN.md:243` and referenced by `docs/JOB_ARCHITECTURE.md:43,53,61` and `docs/DECISIONS.md:130` — but **`grep -rn job_runs --include=*.ts --include=*.sql apps/ packages/` returns nothing.** The table does not exist and never has.

Three competing idempotency surfaces already exist: `outbox_events.attempts`, `idempotency_keys` (`0001:190-196`, `apps/api/src/routes/school/util.ts:378`), BullMQ `jobId`.

**Contract:**

1. Phase 8 **does not create `job_runs`.** It would be a fourth source of truth.
2. Provider-send dedupe is a **UNIQUE constraint on `notifications (tenant_id, dedupe_key, channel)`**, written in the same transaction as the notification insert. A duplicate insert is the ack.
3. `docs/DATABASE_DESIGN.md:243` §14 `job_runs` row is corrected (§14, `DOC-5`).
4. Outbound message idempotency key is derived deterministically: `sha256(eventType | aggregateId | notificationId)` — matches the pattern already used at `exams.ts:528` (`idempotencyKey: event.id`). **Amended by C-5 (binding):** the hash pre-image MUST contain the canonical recipient identity and the channel — `sha256(eventType | aggregateId | canonicalRecipientId | channel)` — or equivalently `notificationId` itself MUST be deterministically derived from `(logical communication, canonical recipient, channel)`. A random per-row UUID minted during fanout is forbidden: it breaks recipient-binding under audience union and fanout replay.
5. **C-5 union/replay semantics (binding):** the physical key is equivalent to `(tenant_id, logical communication identity, canonical recipient identity, channel)`. A recipient selected by class ∪ role ∪ explicit targeting receives **one** notification row per channel; a re-executed fanout (outbox reprocessing, BullMQ redelivery, API retry) collides on the UNIQUE constraint and the duplicate insert **is** the ack; a different channel is a separate row. Audience **provenance** (which targeting paths selected the recipient) may be recorded separately for audit/debugging — never as duplicate notification rows. Provider-send retries (§9.2 rule 4) operate on the already-created row/delivery and never re-enter fanout, so they cannot duplicate or re-charge.

### 9.2 DECISION DEL-2 — DLQ for Phase 8 means a **read-only failure surface**, not a new queue

**Direct conflict, must be resolved:**

| Source | Claim |
|---|---|
| `docs/DEVELOPMENT_ROADMAP.md:102` (Phase 8 **acceptance**) | "failed provider → retries then **DLQ visible**" |
| `docs/EVENT_ARCHITECTURE.md:119` | "A dedicated DLQ + platform alerting + replay tool is **Phase 13**" |

**Resolution — the roadmap criterion is met without contradicting the architecture doc:**

1. Phase 8 ships a **DLQ view**: `outbox_events WHERE processed_at IS NULL AND attempts >= <threshold>` plus a failed-jobs listing endpoint (`GET …/communications/failures`, gated on a new read permission), backed entirely by data already written by `failEvent` (`dispatcher.ts:106-112`).
2. "DLQ **visible**" is satisfied. "Dedicated DLQ **queue** + replay tool" remains Phase 13, unchanged.
3. `docs/EVENT_ARCHITECTURE.md:119` gains one sentence recording this reading; `docs/DEVELOPMENT_ROADMAP.md:102` is **not** reworded (it is the user-approved charter).
4. Retry policy for provider sends: **5 attempts, exponential backoff from 2 s** — identical to the dispatcher's (`dispatcher.ts:84-85`), so there is one retry story, not two.
5. **C-7 sanitized projection (binding):** the failure endpoint and any tenant-facing failure/history surface MUST project only safe operational metadata: `channel`, `provider`, delivery status, failure category, safe error code, safe human-readable reason, attempt count, timestamps, correlation identifier, idempotency identifier. It MUST NOT expose raw `last_error` (`dispatcher.ts:106` stores the raw error string, 2 KB cap), raw event payloads, raw job payloads, provider credentials/tokens/authorization headers, raw provider request/response material, unnecessary raw phone numbers or email addresses, or unnecessary full message bodies. Provider adapters normalize errors to category + safe code **at the provider boundary**. Outbox poison/failure visibility follows the same rule: `outbox_events` rows and `failEvent` output are **internal/privileged** diagnostics; the tenant-facing DLQ view is a sanitized projection, never a column dump of the outbox row.
6. **C-7 internal retention:** raw internal diagnostics, if retained at all, remain internal and privileged — accessible only outside the tenant-facing surface — and are never projected through `GET …/communications/failures` or any failure/history view.

### 9.3 DECISION CONSENT-1 — preferences are first-class rows, evaluated at resolve time

**Contract:**

1. A `communication_preferences` table keyed `(tenant_id, user_id, channel)` with `enabled boolean`, per-category. Absent rows = **enabled** (opt-out model), so the default send path is not gated on a seed.
2. Preference filtering happens in **recipient resolution**, inside the API, **before** the announcement/`notifications` rows are written — not in the worker. A suppressed recipient must never produce a row.
3. Messages in an existing thread (`message_threads`/`messages`) are **exempt** from channel preferences — a conversation is not a broadcast. Roadmap `:100` lists unsubscribe under *tests*; this defines what is actually unsubscribable: **broadcasts only** (announcements + templated notifications).
4. Opt-out is enforced in SQL (`AND NOT EXISTS (preference disabled)`), never in application code after the query.

### 9.4 DECISION ABUSE-1 — per-tenant send budget, checked-and-incremented transactionally

Evidence (D8): `apps/api/src/app.ts:113-119` registers Fastify rate limit with `keyGenerator: (req) => req.ip` — **per-IP only**, global `RATE_LIMIT_MAX`/minute, Redis-backed. Roadmap `:101` requires *"rate limits per tenant SMS budget"*. There is no per-tenant budget primitive anywhere.

**Contract:**

1. **Do not** reuse the per-IP limiter for spend control — it is a volumetric guard, is keyed by IP (unstable behind NAT/proxies), and has no notion of *cost*.
2. Per-tenant daily send counters live **in the database**, not in Redis: a `(tenant_id, channel, quota_date)` counter row, read and incremented **inside the same transaction** as the notification insert (`SELECT … FOR UPDATE`). This makes the check atomic with the write — a Redis-only counter can lose writes and over-spend real money.
3. The quota is per **calendar day per channel**, because SMS cost is per-message per-day, not per-minute.
4. Exceeding the quota marks notifications `blocked_quota` (visible in the DLQ view of §9.2) — it does **not** 500 the request and does **not** silently drop.
5. The per-IP limiter stays as-is for HTTP volumetric protection. Two distinct controls, two distinct purposes.
6. **C-6 pre-flight aggregate validation (binding, primary layer):** before **any** delivery/notification rows are created for a fanout, the system MUST validate the requested bounded fanout size against the applicable remaining quota/cap as an aggregate pre-flight check. If the operation exceeds the permitted bound there is **NO PARTIAL SILENT SEND**: the operation fails visibly into a terminal `blocked_quota` state (operation-level), no delivery rows are created for it, and recipients not admitted receive nothing. The design MUST distinguish `accepted` recipients, `suppressed/rejected` recipients, and `terminal operation failure` — never an ambiguous partially-successful state described as success. Fanout remains bounded and asynchronous via the outbox/worker path (§14 rule: no unbounded synchronous fanout).
7. **C-6 row-level concurrency backstop (binding, retained):** the rule-2 `SELECT … FOR UPDATE` checked-and-incremented counter inside the notification-insert transaction remains — it is the race-condition backstop against concurrent fanouts (T16). It MUST NOT be removed; pre-flight does not replace it. A mid-fanout exhaustion discovered by the backstop rolls the operation into the same visible terminal/suppressed outcome as rule 6 — never a silent partial.
8. **C-6 retry non-bypass (binding):** quota is charged once at fanout admission (notification row creation). Provider-send retries (§9.2 rule 4) reuse the created notification/delivery and MUST NOT re-increment the counter; outbox reprocessing collides with the C-5 dedupe key before any new quota consumption. Retry paths therefore cannot bypass the quota.

### 9.5 DECISION FEEDBACK-1 — no fake providers in prod paths; explicit `disabled` state

Roadmap `:99`: *"real keys REQUIRES USER ACTION; fake provider adapter in tests only — **no fake in prod code paths**: feature-flagged until keys provided."*

**Contract:**

1. A `CommunicationProvider` interface in `packages/`, shaped on `StorageProvider` (`packages/storage/src/index.ts:13-24`) — narrow, synchronous-failure, explicit tenant argument.
2. Env var `COMMUNICATION_PROVIDER` ∈ `{disabled, console, smtp, sms}`; **default `disabled`**. Validated by `envSchema`.
3. `console` is permitted only when `NODE_ENV !== 'production'` or an explicit `ALLOW_CONSOLE_PROVIDER=true`. Boot **fails** in production otherwise.
4. `disabled` ⇒ the send path writes the notification row with status `blocked_missing_provider` and surfaces it in the DLQ view. It **never** silently drops and **never** pretends to have sent.
5. Adapters for `smtp`/`sms` are **not written** until their dependency and credentials are approved (§10.2).

---

## 10. Provider dependencies & credentials (D7)

### 10.1 Evidence

| Check | Result |
|---|---|
| `nodemailer` in any `package.json` | **absent** |
| `SMTP_HOST/PORT/USER/PASSWORD/FROM`, `SMS_PROVIDER/API_KEY/SENDER_ID` in `.env.example` | present (`:71-79`) |
| Same names in `packages/config/src/index.ts` `envSchema` | **absent** (only `PLATFORM_ADMIN_EMAIL:81`) |
| Any code reading `SMTP_*` or `SMS_*` | **absent** (grep across `apps/` + `packages/`, `.ts` only) |
| `STRIPE_WEBHOOK_SECRET` in `.env.example` | present (`:69`) |

So D7 is understated: these variables are not merely unvalidated — **nothing consumes them.** They are placeholders.

Because `z.object()` is non-strict by default, extra env vars pass validation silently; the absence from `envSchema` does not fail boot, it simply means no schema-driven guarantee exists.

### 10.2 DECISION DEP-1 — no new dependency in this gate; SMTP/SMS adapters gated on approval

**Contract:**

1. **This audit installs nothing.** Adding `nodemailer` (or any SMS SDK) changes `pnpm-lock.yaml` — explicitly requires **user approval**, per the standing rule that lockfile changes are never made implicitly.
2. Phase 8 (as authorized) delivers: the `CommunicationProvider` interface, `disabled` + `console` adapters, full `envSchema` entries for `COMMUNICATION_PROVIDER`, `SMTP_*`, `SMS_*`, `ALLOW_CONSOLE_PROVIDER`.
3. `SMTP_*` / `SMS_*` are added to `envSchema` **now**, as `z.string().optional()`, even though no adapter consumes them — so the moment an adapter lands, misconfiguration is a boot failure rather than a runtime surprise.
4. `smtp` / `sms` adapter implementations are blocked on: (a) dependency approval, (b) real credentials. Recorded as `DEP-1`, `DEP-2` in §16.

---

## 11. Webhook contract (§17)

### 11.1 Evidence

- `grep -rn webhook apps/api/src --include=*.ts` (excluding tests) → **no inbound webhook endpoint exists**.
- `STRIPE_WEBHOOK_SECRET` (`.env.example:69`) is the only webhook-shaped credential; `BILLING_PROVIDER=manual` by default (`:66`).
- `0029` is reserved for `fin_artifacts_webhooks.sql`, which creates `fin_payment_gateway_webhooks`, `fin_provider_accounts`, `fin_document_artifacts` — and is documented as **"Unreachable for the runtime role by design — no policy and no grant on any 0029 table. These tables are written only by the webhook handler and the artifact worker through `school_migrator`."** (`PHASE_7_FINANCE_DESIGN.md:13717`)

### 11.2 DECISION WH-1 — Phase 8 declares **zero** inbound webhooks

**Contract:**

1. Phase 8 has **no** inbound HTTP webhook, provider callback, or delivery-receipt endpoint.
2. Provider delivery receipts are deferred to **Phase 8b**, at the earliest, and if ever built must satisfy: raw-body retained before parsing, HMAC-SHA256 with `crypto.timingSafeEqual`, `idempotency_key` unique constraint, explicit size cap, timestamp/replay window, and deny-by-default authorization contract.
3. Phase 8 **cannot** own `0029` tables — they are structurally migrator-only, and `0029` is reserved anyway. Payment-gateway webhooks are finance's, not communication's.
4. `notification.delivery_status` (delivered/failed) in Phase 8 is derived from the **provider adapter's synchronous return**, not from a callback. Async receipt webhooks are Phase 8b.

**Rationale:** this closes the highest-risk API-surface question in the audit with a negative answer, and prevents an accidental `POST /webhooks/…` route from being added outside the authorization gate (which would fail boot anyway, since it would have no valid contract — `apps/api/src/plugins/authorization.ts:109`).

---

## 12. Authorization & permission parity (D9)

### 12.1 Evidence

Boot-time gate — `apps/api/src/plugins/authorization.ts:68-69`:

```ts
if (!isRegisteredPermission(contract.permission)) {
  throw new AppError(`Route ${route}: permission "${contract.permission}" is not in the permission catalog`);
}
```

A route **cannot boot** with a permission absent from `PERMISSION_CATALOG`. This is fail-closed and correct.

But there is a **second, independent authorization surface** in SQL:

| Permission strings | In `PERMISSION_CATALOG` (TS) | In DB grants/backfill |
|---|---|---|
| `fees.*` | **4** (`fees.refunds.{request,read,approve,process}`, `permissions.ts:137-140`) | **25** (`0028:1690-1781`) |
| **Drift** | | **21 DB-only** |

The 21 DB-only permissions:

```
fees.adjustments.{approve,create,read}   fees.assignments.{manage,read}
fees.invoices.{create,issue,read,void}   fees.ledger.read
fees.payments.{collect,read,reverse}     fees.portal.read
fees.receipts.{read,reissue}             fees.reconciliation.{manage,read}
fees.reports.read                        fees.structures.{manage,read}
```

And they are **enforced in SQL**, not decorative: `0028:1398` `K('fees.assignments.manage')`, `0028:1029,1221,1255` `app_finance_actor_has_permission('fees.refunds.approve'/'…process')`.

A **third** copy exists: `packages/db/src/security/finance-rbac.test.ts:62` — *"The complete §20.5 `fees.*` permission catalog (the 25 in the backfill)"*.

`packages/permissions/src/permissions.test.ts` pins only *internal* TS consistency (`:70,86,101,116,144,252,301`) — it cannot see the DB.

### 12.2 Consequences for Phase 8

1. Any `communication.*` permission **must** be added to `PERMISSION_CATALOG` before any Phase 8 route can boot. Hard gate.
2. The 21 `fees.*` DB-only permissions are **inert at the API layer** — no route can ever declare them — while being live at the SQL layer. A role granted `fees.invoices.issue` gets *nothing* from the API but *everything* from a SECURITY DEFINER path. **Two surfaces, two catalogs, no parity test.**
3. `ROLE_TEMPLATES` (7 entries: 6 TS at `permissions.ts:157,164,253,293,310,317,329` + `cashier` DB-only at `0028:1683-1687`) cannot express any `fees.*` grant for `accountant` — `permissions.ts:264` shows `accountant` holding only 3 permissions.

### 12.3 DECISION PERM-1 — single catalog, DB-parity test, Phase 8 permission set

**Contract:**

1. **Parity test (Phase 8 must add):** a test that reads every `rp.permission` value the migrations can materialise (extracted from `packages/db/migrations/*.sql`) and asserts `⊆ PERMISSION_CATALOG`. Mirrors the D2 three-way parity test.
2. The **21 `fees.*` strings must be added to `PERMISSION_CATALOG`** — or explicitly retired from DB grants. Leaving them DB-only is an unenforceable grant, which is worse than no grant (it looks like access in an audit and behaves like none at runtime). **Recommendation: add all 21.** This is a contract change in `packages/permissions`, no migration required.
3. `finance-rbac.test.ts:62`'s inline copy of the 25 must be derived from `PERMISSION_CATALOG`, not hand-maintained — eliminating the third source of truth.
4. Phase 8 introduces, minimally:

| Permission | Scope | Routes |
|---|---|---|
| `communication.send` | tenant | send templated notification (roadmap `:101`) |
| `announcements.manage` | tenant | create/update/delete announcements |
| `announcements.read` | tenant | list (portal read paths use self-scoping, not this) |
| `communication.templates.manage` | tenant | template override CRUD |
| `messages.send` | tenant | post to thread |
| `communication.failures.read` | tenant | the DLQ view of §9.2 |
| `communication.preferences.manage` | tenant | admin-side preference management |

5. `ROLE_TEMPLATES` additions (contract, not implementation): `school_owner` + `principal` receive all; `teacher` receives `messages.send` + `announcements.read`; `parent`/`student` receive **only** `messages.send` (they reply in threads) and self-scoped announcement read — **never** `communication.send`, **never** `announcements.manage`. Roadmap `:101` names `communication.send` as *the* permission; the split above keeps send/manage separate so the portal templates cannot become a broadcast vector.

---

## 13. Infrastructure, config & rate limiting

Already resolved by §9.4 (ABUSE-1) and §10.2 (DEP-1). Remaining item:

### 13.1 DECISION CFG-1 — all Phase 8 configuration enters `envSchema`

**Contract:** `COMMUNICATION_PROVIDER`, `ALLOW_CONSOLE_PROVIDER`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`, `SMS_PROVIDER`, `SMS_API_KEY`, `SMS_SENDER_ID`, plus `COMMUNICATION_DAILY_SMS_QUOTA` (int, default sensible), are declared in `packages/config/src/index.ts` in the same change that introduces them. `.env.example` and `envSchema` are asserted equal by a test (a plain set comparison of `KEY=` lines vs schema keys) — this is what would have caught D7.

---

## 14. Migration allocation (§19)

| Item | Value |
|---|---|
| Last used number | `0028` |
| Reserved | **`0029`** — `fin_artifacts_webhooks.sql` (**do not touch**) |
| **Phase 8 allocation** | **`0030` – `0034`** (5 files) |
| Quarantined | `packages/db/migrations-not-authorized/*` — never move, never copy into `migrations/` |
| Runner ordering | lexicographic filename sort (`packages/db/src/cli/migrate.ts:32`) — verified against duplicate prefixes (`0025_*` ×6, `0028_*` ×2) |

**Contract:**

1. One file per number in `0030`–`0034`. The `0025`/`0028` multi-file-per-number pattern works but is a needless ordering hazard for a new phase.
2. `0030` `com_foundation.sql` (tables + RLS + isolation-test registration), `0031` `com_templates.sql`, `0032` `com_send_and_budget.sql` (incl. DB-side event-type guard from D2-1 rule 3), `0033` `com_permissions.sql` (permission + role-template backfill), `0034` reserved for forward remediation.
3. Every `0030`–`0033` tenant table MUST ship with `ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY` + policies ending in `OR app_privileged()` + an isolation test registration, per `docs/DATABASE_DESIGN.md:19`.
4. **Nothing above is executed in this gate.** These are the numbers Phase 8 will ask for.

---

## 15. Documentation drift (§22) — correction list

| ID | Location | Claim | Reality | Fix |
|---|---|---|---|---|
| `DOC-1` | `docs/PHASE_7_CURRENT_STATE.md:10-16` | HEAD `d12b904`, `origin == HEAD`, latest migration `0022` | HEAD `5bf11d0`, HEAD is 1 ahead of `origin/master`, latest `0028`, 34 migrations | rewrite baseline block |
| `DOC-2` | `docs/PHASE_7_CURRENT_STATE.md:31-43` | `0023`+ "untracked", API/Worker/Web "not started" | `0023`–`0028` committed in `5bf11d0`; API finance routes + worker handlers + web all exist | rewrite Pending block |
| `DOC-3` | `docs/PHASE_7_FINANCE_DESIGN.md:278,12314,12385,12386,12863,14281,14296` | Phase 7 emits `fee.invoice.overdue` / `fee.parent.notification.requested`; `finance-024` asserts it | 0 emissions, 0 enum members, no `finance-024` test | reclassify per §5.6 |
| `DOC-4` | `docs/EVENT_ARCHITECTURE.md:108` | Phase 7 emits `invoice.created, invoice.issued, payment.received, refund.processed, invoice.voided` | only `refund.*` emitted; all 3 unregistered | rewrite row |
| `DOC-5` | `docs/DATABASE_DESIGN.md:243` | `job_runs` table exists | absent from all code + migrations | delete row or mark Phase 13 |
| `DOC-6` | `docs/DEVELOPMENT_ROADMAP.md:102` vs `docs/EVENT_ARCHITECTURE.md:119` | Phase 8 acceptance needs DLQ / DLQ is Phase 13 | direct conflict | resolve per §9.2 |
| `DOC-7` | `docs/EVENT_ARCHITECTURE.md:110` | unregistered types "eventually re-processed … when a fix lands" | permanent poison cycle while the failed job is retained | soften + cross-ref D2 |
| `DOC-8` | `docs/AUTHORIZATION.md` | no Phase 8 section | needs one covering `communication.*` | add on Phase 8 doc pass |

---

## 16. Threat model (Phase 8 scope)

| # | Threat | Vector | Existing control | Residual | Decision |
|---|---|---|---|---|---|
| T1 | Cross-tenant announcement leak | worker handler omits `tenant_id = event.tenantId` on a join | none — worker is `school_migrator`, all policies short-circuit | **HIGH** | D3-1 (rules 1–4), D5-1 |
| T2 | Recipient includes a removed guardian | `studentGuardians.deletedAt` not filtered | portal routes filter only 2 of 3 tables | **HIGH** | D5-1 |
| T3 | Cross-tenant recipient via campus selector | campus not an RLS boundary, no FK | route-layer `assertCampusScope` only | MEDIUM | D5-2 (additive-only) |
| T4 | PII retained in append-only outbox | nested payload key defeats top-level 6-key redactor | `outbox.ts:6-14` denylist | **HIGH** | PII-1 (identifiers only) |
| T5 | SMS spend exhaustion / fraud | authenticated tenant sends unbounded volume | per-IP limiter only; no tenant budget | **HIGH** | ABUSE-1 |
| T6 | Template content injection | `{{ }}` substitution into HTML/SMS body | none | MEDIUM | TMPL-1 rule 5 (escape at render) |
| T7 | Tenant edits a shared system template | global template row writable by tenant | no template table yet | MEDIUM | TMPL-1 rule 3 (RLS `NOT is_system`) |
| T8 | Silent send (no provider / no key) | adapter absent, code drops the message | none | MEDIUM | FEEDBACK-1 rule 4 (`blocked_missing_provider`) |
| T9 | Poison outbox event stalls delivery | unregistered event type (D2) | enum validation + `failEvent` | **HIGH (live)** | D2-1 |
| T10 | Report/queue job silently never runs | D1 ternary mis-route | none | **HIGH (live)** | D1-1 |
| T11 | Permission granted but unenforceable (false sense of access) | 21 `fees.*` DB-only | boot gate blocks the API side only | MEDIUM | PERM-1 rules 1–2 |
| T12 | Two authorization surfaces disagree | SQL `K()`/`app_finance_actor_has_permission` vs API `requirePermission` | none — no parity test | MEDIUM | PERM-1 rule 1 |
| T13 | Duplicate provider send on retry | BullMQ at-least-once redelivery | `notifications` unique dedupe key | LOW once DEL-1 | DEL-1 |
| T14 | Inbound webhook forgery | future provider callback | **no inbound webhooks exist** | CLOSED | WH-1 |
| T15 | Template override affects other tenants | wrong RLS on `tenant_id IS NULL` rows | pattern exists for `roles`, untested for content | MEDIUM | TMPL-1 rules 2–3 + isolation test |
| T16 | Quota bypass via concurrent requests | read-then-write counter in app code | none | MEDIUM | ABUSE-1 rule 2 (`FOR UPDATE` in txn) |
| T17 | Platform-scope event with `tenantId = NULL` handled as tenant event | handler assumes non-null | none | LOW | D3-1 rule 2 (fail-closed) |
| T18 | Cross-tenant read via `school_migrator` in a *management* path | migrator URL reused outside the worker | API uses `DATABASE_URL_APP` (`server.ts:8`); only `bootstrap-platform-admin` + CLI use migrator | LOW | monitor — do not extend migrator usage |

---

## 17. Decision register

| ID | Decision | Priority | Blocks Phase 8? | Requires migration? | Requires dep approval? |
|---|---|---|---|---|---|
| **D3-1** | Worker tenant isolation = test-enforced data invariant; `school_worker_rw` deferred | **P0** | **YES** | no (follow-up: yes) | no |
| **D1-1** | Table-driven queue routing, fail-closed, delete ternary | **P0** | **YES** | no | no |
| **D2-1** | Register `refund.*` ×3; three-way catalog parity; DB-side type guard | **P0** | **YES** | guard = yes (`0032`) | no |
| **D5-1** | Single recipient resolver with 5 mandatory predicates | **P0** | **YES** | no | no |
| **B1-1** | Dunning out of scope for Phase 8; reclassify + fix docs | **P1** | no | — | — |
| **D5-2** | Campus = additive narrowing filter only | **P1** | **YES** (audience selectors) | no | no |
| **PII-1** | Identifiers only in outbox; resolve contacts at send time | **P1** | **YES** | no | no |
| **TMPL-1** | System template + tenant override, `is_system` RLS | **P1** | **YES** | yes (`0031`) | no |
| **DEL-1** | Send idempotency on `notifications`; no `job_runs` | **P1** | **YES** | yes (`0032`) | no |
| **DEL-2** | Phase 8 DLQ = read-only failure view; queue stays Phase 13 | **P1** | **YES** (acceptance) | no | no |
| **CONSENT-1** | Preferences filtered at resolve time; broadcasts only | **P1** | **YES** | yes (`0030`) | no |
| **ABUSE-1** | Per-tenant daily quota, `FOR UPDATE` in the write txn | **P1** | **YES** | yes (`0032`) | no |
| **FEEDBACK-1** | `CommunicationProvider`; `disabled` default; no fake prod providers | **P1** | **YES** | no | no |
| **DEP-1** | `nodemailer` / SMS SDK **not** installed; adapters gated | **P1** | **YES** | no | **YES — user action** |
| **WH-1** | Zero inbound webhooks in Phase 8 | **P1** | **YES** | no | no |
| **PERM-1** | Single permission catalog + DB-parity test + 21 `fees.*` backfill | **P1** | **YES** | yes (`0033`) | no |
| **CFG-1** | All Phase 8 config in `envSchema`; `.env.example` ↔ schema test | **P2** | no | no | no |
| **MIG-1** | Migrations `0030`–`0034`; `0029` reserved | **P2** (allocation) | **YES** (allocation) | — | — |
| **DOC-1..8** | Correct eight documentation drifts | **P2** | no | — | — |
| **C-1** | Exactly-one recipient identity, DB-enforced CHECK | **P0** | **YES** | yes (`0030`) | no |
| **C-2** | Canonical notification RLS on actual recipient columns | **P0** | **YES** | yes (`0030`) | no |
| **C-3** | Immutable per-delivery rendering snapshot | **P1** | **YES** | yes (`0030`/`0032`) | no |
| **C-4** | Account-linked recipients only; contact-only excluded | **P0** | **YES** | yes (`0030`/`0032`) | no |
| **C-5** | Recipient-bound deterministic dedupe (amends DEL-1) | **P0** | **YES** | yes (`0032`) | no |
| **C-6** | Quota preflight + row-lock backstop (amends ABUSE-1) | **P1** | **YES** | yes (`0030`/`0032`) | no |
| **C-7** | Sanitized failure visibility (amends DEL-2) | **P1** | **YES** | yes (`0032`) | no |

---

## 18. Open items requiring explicit user action

1. **`DEP-1` — approve or refuse a mail dependency.** `nodemailer` is absent from all `package.json`; installing it changes `pnpm-lock.yaml`. Without it, Phase 8 can ship only `disabled` + `console` adapters, which satisfies the roadmap's feature-flag rule but means no real email in Phase 8.
2. **`DEP-2` — approve or refuse an SMS SDK** (or a plain-HTTPS adapter against a documented gateway API, which would avoid a dependency entirely — preferred if a gateway is chosen).
3. **Confirm §9.2 DLQ resolution** — met by a read-only failure view rather than a real dead-letter queue. This changes how `docs/DEVELOPMENT_ROADMAP.md:102` is read; the roadmap text itself is left untouched.
4. **Confirm §5.6** — dunning (`fee.invoice.overdue`) is dropped from Phase 8 into a later phase.
5. **Confirm §17 `D3-1`** — accept "test-enforced data invariant" as the Phase 8 answer for worker RLS, with `school_worker_rw` recorded as post-gate hardening.

---

## 19. Overall verdict

**GO WITH CONDITIONS — and no implementation may begin until the five P0 conditions below are acknowledged.**

Phase 8 itself is clean: greenfield, no legacy tables/routes/permissions to preserve, an established RLS + deny-by-default + outbox architecture to build on, and an unambiguous charter in `docs/DEVELOPMENT_ROADMAP.md:93-102`.

The blockers are **inherited**, not native:

- **D3** — worker runs as `school_migrator` with every RLS policy short-circuited by `OR app_privileged()`. Documented and deliberate, but unenforced. Resolution: `D3-1`.
- **D1** — a two-value ternary silently routes `reports` jobs into `events`, so `report.studentReportCard` has **never run**. Resolution: `D1-1`.
- **D2** — three DB-emitted event types are absent from the enum, producing a **permanent, non-converging poison state** on every refund approval. Resolution: `D2-1`.
- **D5** — the canonical recipient resolver omits `studentGuardians.deletedAt`, which would make removed guardians recipients in Phase 8. Resolution: `D5-1`.
- **Acceptance conflict** — the Phase 8 acceptance criterion requires a DLQ that the architecture assigns to Phase 13. Resolution: `DEL-2`.

Everything else (P1/P2) is resolvable at contract level without touching code, schema, dependencies, or git — which is precisely what this gate was for.

**Explicitly NOT done in this audit, per the standing prohibition:** no migration created, executed, or modified; no communication table, API route, permission, provider, webhook, or queue introduced; no dependency installed; no commit, stage, branch, or config change; `0029` untouched; `migrations-not-authorized/` untouched; test suites not re-run (they mutate `school_saas_dev` / `school_saas_test`); `school_saas_dev` not queried.

---

## 20. Design corrections C-1…C-7 — binding amendments (baseline closure gate)

Recorded from the Phase 8 pre-implementation baseline closure report (baseline `0da5e5c`). These amendments are **binding** for every Phase 8 design and implementation artifact. Where an earlier section of this report conflicts with §20, **§20 governs.** Migration mapping stays inside the approved `0030`–`0033` allocation (§14); `0029` remains reserved; `0034` remains unallocated.

### 20.1 C-1 — exactly one recipient identity (DB-enforced)

1. The notification model carries exactly three candidate recipient columns: `recipient_user_id`, `recipient_student_id`, `recipient_guardian_id`.
2. **Exactly ONE must be populated.** All-NULL is forbidden. Two- or three-populated is forbidden.
3. Enforcement is a **database CHECK constraint** on `notifications` (shipped in `0030`) — application validation alone is insufficient. Failure of the invariant must fail closed (insert rejected).
4. The selected canonical recipient identity is the single identity that drives: **RLS, deduplication, audience resolution, delivery creation, audit/history, and permission checks.** No subsystem may read a different recipient column than the one selected by the constraint.

### 20.2 C-2 — canonical notification RLS

1. Notification RLS MUST reference the actual canonical recipient columns from C-1 (or a canonical relationship derived from them) — never a conceptual/generic `user_id` unless `user_id` is genuinely the canonical column.
2. Explicit visibility rules, per recipient type:
   - **user recipient** (`recipient_user_id`): visible when `recipient_user_id = app_current_user_id()` within the tenant scope.
   - **student recipient** (`recipient_student_id`): visible to the authenticated user linked to that student (`students.user_id = app_current_user_id()` for the matching student row) within the tenant scope.
   - **guardian recipient** (`recipient_guardian_id`): visible to the authenticated user linked to that guardian (`guardians.user_id = app_current_user_id()` for the matching guardian row) within the tenant scope — with `guardians.deleted_at IS NULL` and `student_guardians.deleted_at IS NULL` respected by the underlying relationship.
3. All policies additionally carry the mandatory tenant predicate (`tenant_id = app_current_tenant_id()`) and end in `OR app_privileged()` per §14 rule 3. Runtime access remains fail closed.
4. **Worker security model unchanged:** `assertEventTenant(event)` remains the first statement of handler execution (`apps/worker/src/worker.ts:61`); `tenantIdOf(event)` remains authoritative for event tenant identity; worker operations continue using explicit `tenant_id = event.tenantId` predicates (D3-1). This correction does not redesign worker privileges/RLS.
5. Account-linked recipient resolution (C-4) remains explicit in every visibility path.

### 20.3 C-3 — immutable per-delivery content snapshot

1. `notifications.body` = **canonical / template-resolved notification content only.**
2. Each **delivery** (one per channel) stores its own immutable channel-specific rendering snapshot: `subject`, `body`, `bodyHtml`, channel-normalized content (applicable fields per channel).
3. Lifecycle: `delivery created → render once → snapshot stored → every retry reuses the same snapshot`.
4. **A template modification after delivery creation MUST NOT alter an existing delivery's content.** Template edits affect only future deliveries. Rendering is deterministic and auditable.
5. No architecture text may assume one generic `body` string serves all channels or is re-rendered per attempt.

### 20.4 C-4 — account-linked recipients only

1. Phase 8 audience/recipient resolution MUST require a resolvable authenticated application account: guardian recipients require `guardians.user_id IS NOT NULL` plus a valid, active linked `users` account; student recipients require `students.user_id IS NOT NULL` plus a valid account.
2. **Contact-only guardian records (`user_id IS NULL`, possibly carrying `email`/`phone`) are NOT Phase 8 delivery recipients.** Never send because a contact row contains an address. Resolution fails closed when no account-linked recipient exists.
3. Soft-unlinked relationships remain excluded: `student_guardians.deleted_at IS NULL` (plus `guardians.deleted_at IS NULL`, `students.deleted_at IS NULL`) — D5-1's five predicates are mandatory in every resolution.
4. Contact-only guardian communication is deferred to a later phase with its own explicit consent/contact model.
5. Applied consistently across: audience resolution, guardian targeting, recipient resolution, consent evaluation (C-4 makes CONSENT-1's `(tenant_id, user_id, channel)` preference key well-defined for every recipient), delivery creation, RLS (§20.2), and the isolation-test invariants.

### 20.5 C-5 — recipient-bound deterministic deduplication (amends §9.1 DEL-1)

Binding amendment recorded in §9.1 rules 4–5: the dedupe identity is equivalent to `(tenant_id, logical communication identity, canonical recipient identity, channel)`; the hash pre-image contains the canonical recipient identity and channel; DB uniqueness enforces it; multi-path audience union and fanout replay cannot duplicate deliveries; provenance is stored separately, never as duplicate rows. Reconciled with T13 (duplicate provider send on retry — the unique constraint is the ack), announcement audience union semantics (union then dedupe at insert), retries, idempotency, and outbox reprocessing (§9.1 rule 5).

### 20.6 C-6 — fanout quota preflight + concurrency backstop (amends §9.4 ABUSE-1)

Binding amendment recorded in §9.4 rules 6–8: aggregate pre-flight validation before any delivery rows are created (no partial silent send; explicit accepted / suppressed / terminal states), the row-level `SELECT … FOR UPDATE` backstop retained and not removed, and retry paths charged once at admission so retries cannot bypass quota.

### 20.7 C-7 — sanitized failure visibility (amends §9.2 DEL-2)

Binding amendment recorded in §9.2 rules 5–6: tenant-facing failure/history views project only safe operational metadata; raw `last_error`, raw event/job payloads, credentials/tokens/headers, provider material, unnecessary raw contact details, and unnecessary full bodies are never tenant-visible; adapters normalize errors at the provider boundary; internal raw diagnostics remain internal/privileged; outbox poison visibility follows the same rule.

### 20.8 G8 — provider fail-closed (reconfirmed, unchanged)

FEEDBACK-1 (§9.5) + DEP-1 (§10.2) remain consistent with G8, branch-for-branch: production + configured real provider → real attempt (reachable only after DEP-1/2 approval); production + missing provider → fail closed (`blocked_missing_provider`, never a drop, never fake success); production + `console` → boot failure unless the explicit `ALLOW_CONSOLE_PROVIDER` override; development/test + explicit console → permitted; provider runtime failure → bounded, idempotent 5-attempt retry/failure state machine (§9.2 rule 4). The path `provider unavailable → pretend sent → delivery = success` must never exist.

### 20.9 Migration allocation reconciliation (C-1…C-7 ⊆ `0030`–`0033`)

| Correction | Migration home | Content |
|---|---|---|
| C-1 | `0030` | recipient columns + exactly-one CHECK on `notifications` |
| C-2 | `0030` (`0032` for deliveries RLS, shipped with its table) | notification RLS on canonical recipient relationships + isolation-test registration |
| C-3 | `0030` (canonical `notifications.body`) / `0032` (delivery snapshot columns) | immutable per-delivery snapshot |
| C-4 | `0030` (FK/resolver contract) / `0032` (delivery-time account-link assertion) | account-linked-only enforcement + tests |
| C-5 | `0032` | recipient-bound dedupe UNIQUE constraint (per §17 DEL-1 row) |
| C-6 | `0030`/`0032` | quota counter table + preflight/terminal-state semantics |
| C-7 | `0032` | delivery failure category/safe-code fields; sanitized view projection |

`0029` = RESERVED (untouched). `0034` = RESERVED / **UNALLOCATED** — no correction consumes it. Nothing requires `0035+`. **No migration is created by this gate.**

### 20.10 Reconciliation with the eight supporting Phase 8 decisions

| Supporting decision | Status vs C-1…C-7 |
|---|---|
| 1. Snapshot-at-dispatch audience resolution | **Consistent** — audience fixed at dispatch; C-5 dedupes the resolved set at insert. |
| 2. `announcement.published` as the one new event type | **Consistent** — its `aggregateId` feeds C-5's logical-communication identity. |
| 3. Six Phase-8 permissions | **Consistent, one count discrepancy reported, not silently resolved:** PERM-1 §12.3 rule 4's table lists **seven** rows (`communication.send`, `announcements.manage`, `announcements.read`, `communication.templates.manage`, `messages.send`, `communication.failures.read`, `communication.preferences.manage`), while the approved gate decision counts **six** (the seven minus `communication.preferences.manage`). C-7's `communication.failures.read` is present under either count. The table is left unchanged; the 6-vs-7 count must be confirmed at the next implementation-readiness review. |
| 4. TMPL-1 template model | **Consistent** — render-at-delivery with escaped substitution (TMPL-1 rule 5) feeds C-3's once-rendered immutable snapshot. |
| 5. DEL-1 dedupe model | **Corrected** by C-5 (§20.5) — recipient-bound pre-image. |
| 6. CONSENT-1 opt-out preferences | **Consistent** — resolve-time filtering before notification rows exist, so suppressed recipients never contend with C-5/C-6; its `(tenant_id, user_id, channel)` key is well-defined because C-4 makes every recipient account-linked. |
| 7. WH-1 zero inbound provider webhooks | **Consistent** — C-7 concerns outbound-facing failure reads only. |
| 8. DEP-1/2 no new dependencies | **Consistent** — C-7's provider-boundary normalization is a design requirement for future approved adapters; nothing is installed here. |

---
*Generated by the Phase 8 readiness gate (prompt 2 of 2). §20 (C-1…C-7) added by the Phase 8 design-correction reconciliation gate — documentation only, no code/schema/dependency changes.*
