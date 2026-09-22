# Event Architecture (Outbox)

Status: Phase 0 | Related: ADR-008, JOB_ARCHITECTURE.md

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
Dispatcher (worker): LISTEN/NOTIFY pg + 1s polling fallback
   └── SELECT … WHERE processed_at IS NULL ORDER BY created_at FOR UPDATE SKIP LOCKED
        → enqueue BullMQ job (or fan-out) → UPDATE processed_at, attempts
Consumer (worker/api module)
   └── idempotent handler keyed by (event_id) in job_runs / handler dedupe table
```

`NOTIFY outbox_channel` fired on insert (trigger) for low latency; polling guarantees delivery if NOTIFY missed.

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

Events are defined in `packages/contracts/src/events.ts` (Zod per event type). The **producing module owns** the schema; consumers import types — no stringly-typed event names.

Phase-gated catalog (grows with modules):

| Phase | Events |
|---|---|
| 1 | `user.created`, `user.invited`, `membership.role.changed`, `tenant.created` |
| 2 | `academic_year.opened`, `campus.created` |
| 3 | `student.created`, `student.enrolled`, `student.transferred`, `student.graduated` |
| 4 | `teacher.assigned`, `timetable.published` |
| 5 | `attendance.marked`, `leave.approved` |
| 6 | `exam.published`, `report_card.generated`, `result.corrected` |
| 7 | `invoice.created`, `invoice.issued`, `payment.received`, `refund.processed`, `invoice.voided` |
| 8 | `notification.requested`, `announcement.published` |
| 10 | `payroll.posted` |
| 11 | `subscription.changed`, `entitlement.exceeded` |
| 12 | `ai.tool.invoked` (audited sample / always for sensitive tools) |

## 5. Delivery guarantees

- Outbox → queue: at-least-once; dispatcher uses `SKIP LOCKED` so multiple dispatcher replicas are safe.
- Queue → consumer: BullMQ at-least-once; **every handler idempotent** (upsert on event id, or natural idempotency like `payment_no`).
- Ordering: per `aggregate_id` use BullMQ group/key (`jobId = eventType:aggregateId` won't work for repeats) → use custom job id `{eventType}:{aggregateId}:{eventId}` for dedupe + `limiter`/single active job per aggregate via BullMQ groups feature **or** accept at-least-once with version checks. Default stance: **handlers tolerate reordering** using state-machine guards (e.g., `payment.received` after `invoice.voided` → handler no-ops + logs).
- Poison events: after N attempts → dead-letter queue + `outbox_events.last_error` retained; platform alerting; replay tool required (Phase 13).

## 6. What is NOT an event

- Anything needed synchronously for the HTTP response (call service directly).
- Internal UI state.
- High-volume telemetry (goes to metrics, not outbox).

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
| Crash after commit before NOTIFY | Poll picks up ≤1s | polling floor |
| Dispatcher crash mid-batch | Rows unprocessed (processed_at still NULL) | SKIP LOCKED + retry |
| Consumer crash after side effect before ack | Redelivery | idempotent handler |
| Redis down | Outbox grows | alert on backlog age; dispatcher retry |
| Schema change of payload | Old events in flight | version field in envelope; consumers accept N and N-1 versions |

## 9. Testing

- Unit: handler idempotency (process same event twice → same state).
- Integration: tx rollback emits nothing; commit emits exactly one row; dispatcher → handler e2e; poison → DLQ.
