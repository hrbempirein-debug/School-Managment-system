import { and, count, countDistinct, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  attendanceDays,
  enrollments,
  guardians,
  students,
  studentGuardians,
  users,
  type Db,
  type Tx,
} from '@sms/db';
import { writeAudit } from '@sms/audit';
import type { JobPayload, OutboxEvent } from '@sms/contracts';

type Logger = (level: 'info' | 'warn' | 'error', msg: string, data?: unknown) => void;

export interface AttendanceHandlerDeps {
  tx: Tx;
  event: OutboxEvent;
  /** Registers a job to run AFTER the handler's transaction has committed. */
  defer: (job: JobPayload) => void;
}

export type AttendanceHandler = (deps: AttendanceHandlerDeps) => Promise<void>;

/** Channel used for the Phase 5 notification stubs; Phase 8 owns real delivery. */
const LATE_TEMPLATE = 'attendance.student.late';
const LEAVE_DECISION_TEMPLATE = 'attendance.leave.decision';

function tenantIdOf(event: OutboxEvent): string {
  const tenantId = typeof event.payload['tenantId'] === 'string' ? event.payload['tenantId'] : event.tenantId;
  if (!tenantId) throw new Error('attendance event requires a tenantId');
  return tenantId;
}

function dateOf(event: OutboxEvent): string {
  const date = event.payload['attendanceDate'];
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error("attendance event requires an ISO 'attendanceDate' in payload");
  }
  return date;
}

/**
 * `attendance.marked` -> a late-notification STUB per late student.
 *
 * Recipients are the LIVE guardians of the student (their portal users), so the
 * notification can only ever reach a family that is already linked to the
 * student. The handler runs inside the system transaction and therefore only
 * DEFERS the job: the BullMQ enqueue happens after the commit, so a rolled-back
 * mark can never produce a "your child was late" message.
 */
export function makeLateNotificationHandler(log: Logger): AttendanceHandler {
  return async ({ tx, event, defer }) => {
    const tenantId = tenantIdOf(event);
    const date = dateOf(event);

    const late = await tx
      .select({
        id: attendanceDays.id,
        studentId: attendanceDays.studentId,
        studentNo: students.studentNo,
        firstName: students.firstName,
        lastName: students.lastName,
      })
      .from(attendanceDays)
      .innerJoin(
        students,
        and(eq(students.tenantId, attendanceDays.tenantId), eq(students.id, attendanceDays.studentId)),
      )
      .where(
        and(
          eq(attendanceDays.tenantId, tenantId),
          eq(attendanceDays.attendanceDate, date),
          eq(attendanceDays.status, 'late'),
          isNull(attendanceDays.deletedAt),
          isNull(students.deletedAt),
        ),
      )
      .execute();
    if (!late.length) {
      log('info', 'attendance.marked: no late students to notify', { tenantId, date });
      return;
    }

    const ids = late.map((r) => r.studentId);
    const recipients = await tx
      .selectDistinct({ studentId: studentGuardians.studentId, email: users.email })
      .from(studentGuardians)
      .innerJoin(
        guardians,
        and(eq(guardians.tenantId, studentGuardians.tenantId), eq(guardians.id, studentGuardians.guardianId)),
      )
      .innerJoin(users, eq(users.id, guardians.userId))
      .where(
        and(
          eq(studentGuardians.tenantId, tenantId),
          inArray(studentGuardians.studentId, ids),
        ),
      )
      .execute();

    let deferred = 0;
    for (const row of late) {
      const family = recipients.filter((r) => r.studentId === row.studentId);
      for (const to of family) {
        defer({
          name: 'mail.stub.send',
          queue: 'mail',
          data: {
            to: to.email,
            template: LATE_TEMPLATE,
            tenantId,
            correlationId: event.correlationId,
            data: {
              studentId: row.studentId,
              studentNo: row.studentNo,
              studentName: `${row.firstName} ${row.lastName}`,
              attendanceDate: date,
              status: 'late',
            },
          },
        });
        deferred += 1;
      }
    }
    log('info', 'attendance.marked: deferred late notifications', {
      tenantId,
      date,
      lateStudents: late.length,
      notifications: deferred,
    });
  };
}

/**
 * `leave.approved` / `leave.rejected` -> a decision STUB to the requester.
 *
 * The requester is a portal user of this tenant, so the recipient email is
 * resolved from the request row itself rather than from client input. Like the
 * late notification this only DEFERS: a rolled-back decision sends nothing.
 */
export function makeLeaveDecisionHandler(log: Logger): AttendanceHandler {
  return async ({ tx, event, defer }) => {
    const tenantId = tenantIdOf(event);
    const leaveRequestId = event.payload['leaveRequestId'];
    if (typeof leaveRequestId !== 'string') {
      throw new Error("leave decision requires a string 'leaveRequestId' in payload");
    }
    const decided = event.eventType === 'leave.approved' ? 'approved' : 'rejected';

    const request = await tx.execute(
      sql`select lr.id, lr.student_id, lr.status, lr.decision_note, u.email
            from leave_requests lr
            join users u on u.id = lr.requested_by
           where lr.tenant_id = ${tenantId}
             and lr.id = ${leaveRequestId}
             and lr.deleted_at is null
             and lr.status = ${decided}`,
    ) as unknown as { rows: Record<string, unknown>[] };
    const row = request.rows[0];
    if (!row) {
      // A redriven dispatch after the decision was already recorded converges as
      // a no-op ack rather than re-notifying the family.
      log('info', 'leave decision: no matching decided request, no-op', {
        tenantId,
        leaveRequestId,
      });
      return;
    }

    defer({
      name: 'mail.stub.send',
      queue: 'mail',
      data: {
        to: String(row['email']),
        template: LEAVE_DECISION_TEMPLATE,
        tenantId,
        correlationId: event.correlationId,
        data: {
          leaveRequestId: leaveRequestId,
          studentId: String(row['student_id']),
          status: decided,
          decisionNote: row['decision_note'] === null ? null : String(row['decision_note']),
        },
      },
    });
    log('info', 'leave decision: deferred notification', { tenantId, leaveRequestId, status: decided });
  };
}

export interface DailyAttendanceSummary {
  tenantId: string;
  attendanceDate: string;
  expectedStudents: number;
  present: number;
  absent: number;
  late: number;
  excused: number;
  unmarked: number;
}

/**
 * Day tally for one tenant, computed from the database (never accumulated in the
 * worker). The EXPECTED population is the distinct set of actively enrolled
 * students, and `unmarked` is that set minus the marked rows — so a day where
 * nobody was marked reads as fully unmarked rather than as "0 present".
 */
export async function summarizeTenantAttendance(
  tx: Tx,
  tenantId: string,
  attendanceDate: string,
): Promise<DailyAttendanceSummary> {
  const expectedRow = await tx
    .select({ total: countDistinct(enrollments.studentId) })
    .from(enrollments)
    .innerJoin(
      students,
      and(eq(students.tenantId, enrollments.tenantId), eq(students.id, enrollments.studentId)),
    )
    .where(
      and(
        eq(enrollments.tenantId, tenantId),
        eq(enrollments.status, 'active'),
        isNull(enrollments.deletedAt),
        eq(students.status, 'active'),
        isNull(students.deletedAt),
      ),
    )
    .execute()
    .then((r) => r[0]!.total);

  const byStatus = await tx
    .select({ status: attendanceDays.status, total: count() })
    .from(attendanceDays)
    .where(
      and(
        eq(attendanceDays.tenantId, tenantId),
        eq(attendanceDays.attendanceDate, attendanceDate),
        isNull(attendanceDays.deletedAt),
      ),
    )
    .groupBy(attendanceDays.status)
    .execute();

  const counts = { present: 0, absent: 0, late: 0, excused: 0 };
  for (const row of byStatus) {
    if (row.status in counts) counts[row.status as keyof typeof counts] = row.total;
  }
  const marked = byStatus.reduce((sum, row) => sum + row.total, 0);
  return {
    tenantId,
    attendanceDate,
    expectedStudents: expectedRow,
    ...counts,
    unmarked: Math.max(0, expectedRow - marked),
  };
}

/**
 * Daily attendance summary across every active tenant, at most ONE audit row per
 * (tenant, date) so a repeating scheduler or a redriven run cannot duplicate it.
 */
export async function runDailyAttendanceSummaries(
  db: Db,
  log: Logger,
  opts: { attendanceDate?: string } = {},
): Promise<DailyAttendanceSummary[]> {
  return db.transaction(async (tx) => {
    const today = await tx
      .execute(sql`select to_char(current_date, 'YYYY-MM-DD') d`)
      .then((r) => (r as unknown as { rows: { d: string }[] }).rows[0]!.d);
    const attendanceDate = opts.attendanceDate ?? today;

    const tenants = await tx
      .execute(sql`select id from tenants where status = 'active'`)
      .then((r) => (r as unknown as { rows: { id: string }[] }).rows);
    if (!tenants.length) return [];

    const written: DailyAttendanceSummary[] = [];
    for (const { id: tenantId } of tenants) {
      const existing = await tx
        .execute(
          sql`select 1 from audit_logs
                where tenant_id = ${tenantId}
                  and action = 'attendance.daily_summary'
                  and new_value ->> 'attendanceDate' = ${attendanceDate}
                limit 1`,
        )
        .then((r) => (r as unknown as { rows: unknown[] }).rows);
      if (existing.length) continue;

      const summary = await summarizeTenantAttendance(tx, tenantId, attendanceDate);
      await writeAudit(tx, {
        scope: 'tenant',
        tenantId,
        actorUserId: null,
        actorType: 'system',
        action: 'attendance.daily_summary',
        resourceType: 'attendance_day',
        resourceId: attendanceDate,
        newValue: summary as unknown as Record<string, unknown>,
        requestId: null,
      });
      written.push(summary);
      log('info', 'attendance.daily_summary', summary as unknown as Record<string, unknown>);
    }
    return written;
  });
}
