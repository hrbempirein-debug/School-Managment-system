import { z } from 'zod';

export const outboxEventTypeSchema = z.enum([
  'user.created',
  'user.login',
  'user.logout',
  'session.created',
  'membership.created',
  'tenant.created',
  'campus.created',
  'campus.updated',
  'campus.activated',
  'campus.deactivated',
  'academic.year.created',
  'academic.year.updated',
  'academic.year.opened',
  'academic.year.closed',
  'academic.term.created',
  'academic.term.updated',
  'academic.term.opened',
  'academic.term.closed',
  'holiday.created',
  'holiday.updated',
  'holiday.deleted',
  'calendar.created',
  'calendar.updated',
  'calendar.deleted',
  'calendar.event.created',
  'calendar.event.updated',
  'calendar.event.deleted',
  'department.created',
  'department.updated',
  'department.activated',
  'department.deactivated',
  'school.settings.updated',
  'student.created',
  'student.enrolled',
  'student.transferred',
  'student.graduated',
  // Phase 3.5: admission application lifecycle. Emitted by the action routes
  // (submit/review/approve/reject/withdraw) and create/PATCH metadata updates.
  // Payloads stay minimal (ids only — no applicant PII in events). approve carries
  // the studentId materialized at approval time.
  'admission.application.created',
  'admission.application.updated',
  'admission.application.submitted',
  'admission.application.review_started',
  'admission.application.approved',
  'admission.application.rejected',
  'admission.application.withdrawn',
  // Phase 3.3: worker-driven promotion execution. POST /promotion-batches/:id/execute
  // grabs the batch (draft -> in_progress) and enqueues this event; the worker runs the
  // promotion transaction (enrollments for each pending item) asynchronously. Imperative
  // naming ("domain.entity.verb") is the deliberate exception to the past-tense catalog
  // rule so the queue item self-documents the command it represents (cf. EVENT_ARCHITECTURE
  // §4 counter-example notification.requested).
  'promotion.batch.execute',
  // Phase 3.4: student document upload. POST /students/:id/documents enqueues this
  // once per accepted upload; the worker's document scan-hook runs on the same
  // event (reads the stored object, re-verifies magic bytes + sha256 against the
  // files.content_hash row, marks files.scan_status clean|blocked). Redelivery only
  // re-runs an idempotent scan — see apps/worker/src/documents.ts.
  'student.document.uploaded',
  // Phase 3.5: student CSV import. submitted carries only { tenantId, importId };
  // the worker reads the stored CSV object, processes rows and emits completed
  // with aggregate counts (never row PII). Retries/concurrency are row-result
  // guarded in the worker (see apps/worker/src/student-import.ts).
  'student.import.submitted',
  'student.import.completed',
  // Phase 4.1: classes, sections & academic placement.
  'class.created',
  'class.updated',
  'class.activated',
  'class.deactivated',
  'class.deleted',
  'section.created',
  'section.updated',
  'section.activated',
  'section.deactivated',
  'section.deleted',
  'placement.assigned',
  'placement.moved',
  'placement.unassigned',
  // Phase 4.2: grade-level & subject catalogs, class-subject links, teacher assignments.
  'grade.level.created',
  'grade.level.updated',
  'grade.level.activated',
  'grade.level.deactivated',
  'grade.level.deleted',
  'subject.created',
  'subject.updated',
  'subject.activated',
  'subject.deactivated',
  'subject.deleted',
  'class.subject.assigned',
  'class.subject.unassigned',
  'teacher.assigned',
  'teacher.unassigned',
  // Phase 4.3: timetable (periods + weekly entries + publish) & homework.
  // Payloads stay ids-only — timetable.entry.* carry the entry id (subject/teacher
  // resolvable from the grid), publish carries the tenant scope; homework.* carry
  // homeworkId only (no assignment text/PII in events).
  'period.created',
  'period.updated',
  'period.deleted',
  'timetable.entry.created',
  'timetable.entry.updated',
  'timetable.entry.deleted',
  'timetable.published',
  'homework.created',
  'homework.updated',
  'homework.deleted',
  // Phase 5: attendance marking/correction and the student leave lifecycle.
  // Payloads stay ids-only plus AGGREGATE counts — never per-student PII, never a
  // free-text note, never a correction reason. `attendance.marked` and
  // `attendance.corrected` carry { tenantId, attendanceDate, markedCount,
  // correctionCount? } so the worker's daily summary and late-notification stubs
  // have everything they need without reading student names. Leave events carry
  // the request + student ids only.
  'attendance.marked',
  'attendance.corrected',
  'leave.requested',
  'leave.approved',
  'leave.rejected',
  // Phase 6: exams, result computation and the report-card lifecycle.
  // `exam.result.compute` is an IMPERATIVE COMMAND (same shape as
  // `promotion.batch.execute`): the API validates and enqueues it inside the
  // publish-request transaction, the worker performs the computation. It carries
  // the exam id, and — when a correction triggered it — the correction and mark
  // ids plus `reason` as context for the worker's log line. Publication is not its
  // only emitter: `correctMark` enqueues it in the same transaction as the
  // ledger row and the mark UPDATE, which is what makes a published correction
  // actually move the report card instead of leaving it stale (F-02).
  // `exam.published` is the publication boundary (audit `exam.result.published` is
  // written in the same transaction) and its ids let the worker notify the linked
  // guardians through the stub channel. `report_card.generated` is emitted BY the
  // computation handler and triggers the `reports`-queue PDF job. `result.corrected`
  // records the correction workflow (old/new/reason live in `mark_corrections`; the
  // event itself stays ids-only) and remains a fact, not the recomputation command.
  // No event carries a grade, a score or any PII.
  'exam.result.compute',
  'exam.published',
  'report_card.generated',
  'result.corrected',
]);

export type OutboxEventType = z.infer<typeof outboxEventTypeSchema>;

/** Sole envelope schema version the worker understands today (see EVENT_ARCHITECTURE §8). */
export const SUPPORTED_EVENT_VERSION = 1;

export const outboxEventSchema = z.object({
  /**
   * Envelope schema version. Integer within 1..SUPPORTED_EVENT_VERSION; missing/undefined
   * is normalized to 1 (backward compatible with pre-versioning rows). Versions above the
   * supported maximum are rejected at worker validation (no silent processing), so an
   * in-flight N vs N-1 payload change can never be misread as the current version.
   */
  version: z
    .number()
    .int()
    .min(1)
    .max(SUPPORTED_EVENT_VERSION)
    .default(SUPPORTED_EVENT_VERSION),
  id: z.string().uuid(),
  tenantId: z.string().uuid().nullable(),
  eventType: outboxEventTypeSchema,
  aggregateType: z.string(),
  aggregateId: z.string(),
  payload: z.record(z.unknown()),
  correlationId: z.string().nullable(),
  causationId: z.string().nullable(),
  createdAt: z.string(),
});

export type OutboxEvent = z.infer<typeof outboxEventSchema>;

export interface NewOutboxEvent {
  tenantId: string | null;
  eventType: OutboxEventType;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  correlationId?: string | null;
  causationId?: string | null;
}