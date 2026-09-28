# Event Architecture (Outbox)

Status: Phase 2B.5 (catalog + delivery + worker verified) | Related: ADR-008, JOB_ARCHITECTURE.md

## 1. Goals

- Atomicity: domain change + event emission in **one** DB transaction.
- At-least-once delivery from DB to consumers.
- Tenant-aware events; ordered per aggregate where required.
- Audit-friendly (events are factual records of what happened).

## 2. Pattern

```text
Service code (same tx as INSERT/UPDATE)
   └── INSERT INTO outbox_events (tenant_id, event_type, aggregate_type, aggregate_id,
                                  payload, causation_id, correlation_id)
Dispatcher (apps/worker): 1.5s polling fallback (LISTEN/NOTIFY pg deferred)
   └── SELECT … WHERE processed_at IS NULL
             AND (dispatched_at IS NULL OR dispatched_at < now() - INTERVAL '5 min')
        ORDER BY created_at LIMIT batch FOR UPDATE SKIP LOCKED
        → enqueue BullMQ job (jobId = event.id → idempotent) → UPDATE dispatched_at
Consumer (worker) — BullMQ processor
   └── validate envelope (Zod) → run handler → UPDATE processed_at
```

`NOTIFY outbox_channel` on insert (trigger) is designed but not yet implemented; the
polling dispatcher guarantees delivery on its own, so this is non-blocking.

## 3. Event taxonomy

Naming: `domain.entity.past_tense` — `student.created`, `student.enrolled`, `attendance.marked`, `invoice.created`, `payment.received`, `exam.published`, `notification.requested`, `subscription.changed`, `user.role.changed`.

Envelope (payload jsonb):

```json
{
  "eventId": "uuid",
  "eventType": "payment.received",
  "tenantId": "uuid",
  "occurredAt": "ISO-8601",
  "actor": { "userId": "uuid|null", "type": "user|system|job" },
  "correlationId": "uuid",
  "causationId": "uuid|null",
  "data": { }
}
```

- `tenant_id` column always populated for tenant events (NULL only for platform events).
- Platform events: `subscription.changed`, `school.created`.

## 4. Ownership & catalog

Event **names** are defined in `packages/contracts/src/events.ts` as a single Zod enum (`outboxEventTypeSchema`); the worker envelope is one shared Zod schema (`outboxEventSchema`) whose `payload` is a generic `Record<string, unknown>`. There is no per-event-type payload schema in this phase — payload contracts for school resources live in `packages/contracts/src/school.ts` (API contracts) and are not yet bound to event types. Unknown event names fail Zod validation at the worker.

### 4.1 Implemented catalog (through Phase 4.2, `outboxEventTypeSchema`)

Every declared type has a **registered disposition** in the worker (`buildHandlers`, `apps/worker/src/worker.ts`); current dispositions are **log-only ack** (no external side effects yet). A type NOT in this enum **fails Zod validation** at the worker — it is never silently acked: the row is stamped `last_error` and `processed_at` stays NULL so the redrive/retry path converges on the failure.

| Event types | Aggregate |
|---|---|
| `user.created`, `user.login`, `user.logout`, `session.created`, `membership.created`, `tenant.created` | auth / identity |
| `campus.created`, `campus.updated`, `campus.activated`, `campus.deactivated` | campus |
| `academic.year.created`, `academic.year.updated`, `academic.year.opened`, `academic.year.closed` | academic_year |
| `academic.term.created`, `academic.term.updated`, `academic.term.opened`, `academic.term.closed` | academic_term |
| `holiday.created`, `holiday.updated`, `holiday.deleted` | holiday |
| `calendar.created`, `calendar.updated`, `calendar.deleted` | calendar |
| `calendar.event.created`, `calendar.event.updated`, `calendar.event.deleted` | calendar_event |
| `department.created`, `department.updated`, `department.activated`, `department.deactivated` | department |
| `school.settings.updated` | school_settings |
| `student.created`, `student.enrolled`, `student.transferred`, `student.graduated` | students / enrollments |
| `admission.application.created`, `admission.application.updated`, `admission.application.submitted`, `admission.application.review_started`, `admission.application.approved`, `admission.application.rejected`, `admission.application.withdrawn` | admission_application |
| `promotion.batch.execute` | promotion batch (imperative command) |
| `student.document.uploaded` | student_document |
| `student.import.submitted`, `student.import.completed` | student_import |
| `class.created`, `class.updated`, `class.activated`, `class.deactivated`, `class.deleted` | class |
| `section.created`, `section.updated`, `section.activated`, `section.deactivated`, `section.deleted` | section |
| `placement.assigned`, `placement.moved`, `placement.unassigned` | enrollment placement |
| `grade.level.created`, `grade.level.updated`, `grade.level.activated`, `grade.level.deactivated`, `grade.level.deleted` | grade_level |
| `subject.created`, `subject.updated`, `subject.activated`, `subject.deactivated`, `subject.deleted` | subject |
| `class.subject.assigned`, `class.subject.unassigned` | class_subject |
| `teacher.assigned`, `teacher.unassigned` | teacher_assignment |
| `period.created`, `period.updated`, `period.deleted` | period |
| `timetable.entry.created`, `timetable.entry.updated`, `timetable.entry.deleted`, `timetable.published` | timetable_entry / timetable |
| `homework.created`, `homework.updated`, `homework.deleted` | homework |

The full enum now declares **84 event types** (verified by `apps/worker/src/outbox-integration.test.ts`).

The 10 Phase 4.3 events (`period.*`, `timetable.entry.*`, `timetable.published`, `homework.*`) are
**log-only acks**: `buildHandlers` auto-registers a generic log handler for every catalog value, so they
enqueue, redrive and ack exactly like the rest of the Phase 4.1/4.2 events. `timetable.published` is the
documented notification trigger for the (future) parent/student portal push subsystem; today the outbox
row is its only externally-observable artifact. None of the Phase 4.3 payloads carry assignment text or
student/homework PII — homework events carry ids only.

Envelope version is **1** for all rows today (see §8). Proof of the catalog, delivery, redrive and worker behaviour is in `apps/worker/src/outbox-integration.test.ts` (gated: `RUN_RUNTIME_SECURITY_TESTS=1`).

Phase-gated catalog (grows with modules):

| Phase | Events |
|---|---|
| 1 | `user.created`, `user.invited`, `membership.role.changed`, `tenant.created` |
| 2 | `academic_year.opened`, `campus.created` |
| 3 | `student.created`, `student.enrolled`, `student.transferred`, `student.graduated` |
| 4 | `teacher.assigned`, `timetable.published` |
| 5 | `attendance.marked`, `leave.approved` |
| 6 | `exam.published`, `report_card.generated`, `result.corrected` (+ the `exam.result.compute` COMMAND, see below) |
| 7 | `invoice.created`, `invoice.issued`, `payment.received`, `refund.processed`, `invoice.voided` |
| 8 | `notification.requested`, `announcement.published` |
| 10 | `payroll.posted` |
| 11 | `subscription.changed`, `entitlement.exceeded` |
| 12 | `ai.tool.invoked` (audited sample / always for sensitive tools) |

## 5. Delivery guarantees

- Outbox → queue: at-least-once. `dispatchPendingEvents` claims rows with `FOR UPDATE SKIP LOCKED` (multi-replica safe) where `processed_at IS NULL AND (dispatched_at IS NULL OR dispatched_at < now() - '5 min')`, ordered by `created_at`. It enqueues with `jobId = event.id` (idempotent slot) and stamps **only `dispatched_at`** — `attempts` is reserved for *processing* attempts (written via `failEvent`) and is never inflated at dispatch. Fresh in-flight rows are left alone until the 5-minute redrive window, so a lost Redis job is re-added without duplicate slots.
- Queue → consumer: BullMQ at-least-once; **every handler idempotent** (single outbox row, ack = idempotent `UPDATE processed_at`). Malformed envelopes and unregistered types fail validation/registry and are recorded with `last_error` (`processed_at` stays NULL), so BullMQ retries and the redriver converge deterministically — there is no silent ack.
- Ordering: per `aggregate_id` use BullMQ group/key (`jobId = eventType:aggregateId` won't work for repeats) → use custom job id `{eventType}:{aggregateId}:{eventId}` for dedupe + `limiter`/single active job per aggregate via BullMQ groups feature **or** accept at-least-once with version checks. Default stance: **handlers tolerate reordering** using state-machine guards (e.g., `payment.received` after `invoice.voided` → handler no-ops + logs).
- DLQ (current): no separate dead-letter queue yet — a job exhausts its BullMQ `attempts`/backoff (default 5, exponential) and the outbox row keeps `last_error` (2 KB cap) with `processed_at` NULL; the stale redrive path keeps it visible so it is not lost, and it is eventually re-processed after the redrive window when a fix lands. A dedicated DLQ + platform alerting + replay tool is Phase 13.

## 6. What is NOT an event

- Anything needed synchronously for the HTTP response (call service directly).
- Internal UI state.
- High-volume telemetry (goes to metrics, not outbox).

## 6.1 Phase 6: exam result flow

The result pipeline is the first place where a command and an event are deliberately
separated, because publication is a one-shot boundary that must not be replayable as
"compute again":

| Type | Kind | Emitted by | Handler does |
|---|---|---|---|
| `exam.result.compute` | **command** (imperative) | `POST /exams/:id/publish`, one per affected student | computes the card snapshot; a no-op on a published card whose totals already match |
| `exam.published` | event | the publish endpoint, once per exam | audit stamp + parent/guardian notification fan-out |
| `report_card.generated` | event | the compute handler, once per new card version | enqueues the `report.studentReportCard` job on the `reports` queue |
| `result.corrected` | event | the correction endpoint | recomputes that student's card (the next version), and notifies |

Rules that keep the flow safe under at-least-once delivery:

- **No PDF for a mutable draft.** The compute handler only emits
  `report_card.generated` for a PUBLISHED card, so a draft card never burns storage
  or produces a file that a later version invalidates.
- **Convergence, not duplication.** A published card with identical totals is left
  alone; only changed totals mint a new `version` row. A missing artifact on an
  otherwise-current card re-enqueues the PDF job.
- The audit trail is written by the API transaction (`exam.result.published`,
  `exam.mark_corrected`), not by the worker, so an event that is never delivered
  cannot erase the record of the action.

## 7. Consumers

| Consumer | Uses events for |
|---|---|
| notifications module | fan-out email/sms/push jobs |
| finance module | balance recomputation, dunning |
| reports module | aggregates |
| ai module | optional indexing (never raw PII beyond need) |
| platform billing | usage counting |
| external webhooks (future) | outbound delivery with own outbox |

## 8. Failure modes

| Failure | Result | Mitigation |
|---|---|---|
| Crash after commit before NOTIFY | Poll picks up ≤ interval | 1.5s polling floor |
| Dispatcher crash mid-batch | Rows unprocessed (processed_at still NULL) | SKIP LOCKED + retry |
| Consumer crash after side effect before ack | Redelivery | idempotent handler |
| Redis flush / queue purge mid-flight | BullMQ job lost | stale redrive (dispatched_at older than 5 min, processed_at NULL → re-enqueue; jobId dedupe keeps it single-slot) |
| Redis down | Outbox grows | alert on backlog age; dispatcher retry |
| Schema change of payload | Old events in flight | envelope `version` field (integer, defaults to 1) discriminates N vs N-1. Supported envelope version is `SUPPORTED_EVENT_VERSION = 1` only: a missing/absent version is normalized to 1; version 1 is accepted; a non-integer version, version < 1, or version > 1 (a future unsupported format) is **rejected explicitly at worker validation** (`last_error` recorded via `failEvent`, `processed_at` stays NULL) — never silently processed |

## 9. Testing

- Unit: handler idempotency (process same event twice → same state).
- Integration: tx rollback emits nothing; commit emits exactly one row; dispatcher → handler e2e; poison → DLQ.
