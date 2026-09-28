import type { FastifyInstance } from 'fastify';
import { and, count, desc, eq, inArray, isNull, lte, gte } from 'drizzle-orm';
import {
  acdClasses,
  sections,
  periods,
  enrollments,
  students,
  guardians,
  studentGuardians,
  teacherAssignments,
  attendanceDays,
  attendancePeriods,
  staffAttendance,
  withTenant,
  type Tx,
} from '@sms/db';
import { HttpError } from '@sms/core';
import { writeAudit } from '@sms/audit';
import { enqueueOutbox } from '@sms/events';
import { requestFingerprint, withIdempotency } from '@sms/idempotency';
import {
  attendanceListQuerySchema,
  attendancePeriodListQuerySchema,
  attendanceRosterQuerySchema,
  attendanceStudentReportQuerySchema,
  staffAttendanceListQuerySchema,
  attendanceRangeQuerySchema,
  attendanceDaySchema,
  attendancePeriodSchema,
  staffAttendanceSchema,
  markAttendanceRequestSchema,
  markAttendancePeriodsRequestSchema,
  markStaffAttendanceRequestSchema,
  correctAttendanceRequestSchema,
  correctAttendancePeriodRequestSchema,
  type AttendanceContext,
  type AttendanceContextStudent,
  type AttendanceDay,
  type AttendancePeriod,
  type AttendanceReportCounts,
  type AttendancePortalResponse,
  type AttendancePortalView,
  type AttendanceRangeQuery,
  type AttendanceRosterEntry,
  type AttendanceStatus,
  type CorrectAttendancePeriodRequest,
  type CorrectAttendanceRequest,
  type MarkAttendancePeriodsRequest,
  type MarkAttendanceRequest,
  type MarkStaffAttendanceRequest,
  type StaffAttendanceRow,
} from '@sms/contracts';
import {
  requireSession,
  requireTenantContext,
  requirePermission,
  requireCsrf,
} from '../../plugins/auth.js';
import {
  mapDomainError,
  idempotencyKeyFromHeader,
  notFoundError,
  assertCampusScope,
} from './util.js';
import { tenantRoleCodes } from './homework.js';

type Ctx = { userId: string; tenantId: string | null; campusId: string | null };
type DayRow = typeof attendanceDays.$inferSelect;
type PeriodRow = typeof attendancePeriods.$inferSelect;
type StaffRow = typeof staffAttendance.$inferSelect;

const EMPTY_COUNTS: AttendanceReportCounts = {
  present: 0,
  absent: 0,
  late: 0,
  excused: 0,
  unmarked: 0,
};

/**
 * Phase 5 read visibility for an `attendance.read` holder. Mirrors the Phase 4.3
 * homework ladder exactly (AUTHORIZATION.md): the permission unlocks the route,
 * this decides which ROWS are reachable.
 *   * school_owner / principal -> every live row in the tenant
 *   * teacher                 -> rows for students they actively teach
 *   * parent                  -> rows for students they are a LIVE guardian of
 *   * student                 -> rows for their own linked student
 *   * any other holder        -> nothing (an honest empty result, not a 403)
 * Narrowing is expressed as a SET of student ids so it composes with date and
 * campus filters; detail reads that fall outside the set resolve to 404 so the
 * existence of another child's record is never observable.
 */
export type AttendanceVisibility = 'all' | 'teacher' | 'parent' | 'student' | 'none';

export function attendanceVisibility(codes: readonly string[]): AttendanceVisibility {
  if (codes.includes('school_owner') || codes.includes('principal')) return 'all';
  if (codes.includes('teacher')) return 'teacher';
  if (codes.includes('parent')) return 'parent';
  if (codes.includes('student')) return 'student';
  return 'none';
}

type StudentRef = { id: string; studentNo: string; firstName: string; lastName: string };

/** Students the caller may READ, or null for the school-wide ('all') visibility. */
export async function readableStudentIds(
  tx: Tx,
  ctx: Ctx,
  vis: AttendanceVisibility,
): Promise<readonly string[] | null> {
  if (vis === 'all') return null;
  if (vis === 'teacher') {
    const rows = await tx
      .selectDistinct({ studentId: enrollments.studentId })
      .from(teacherAssignments)
      .innerJoin(
        enrollments,
        and(
          eq(enrollments.tenantId, teacherAssignments.tenantId),
          eq(enrollments.classId, teacherAssignments.classId),
        ),
      )
      .where(
        and(
          eq(teacherAssignments.tenantId, ctx.tenantId ?? ''),
          eq(teacherAssignments.teacherUserId, ctx.userId),
          isNull(teacherAssignments.deletedAt),
          isNull(enrollments.deletedAt),
          eq(enrollments.status, 'active'),
        ),
      )
      .execute();
    return rows.map((r) => r.studentId);
  }
  if (vis === 'parent') {
    const rows = await tx
      .selectDistinct({ studentId: studentGuardians.studentId })
      .from(guardians)
      .innerJoin(
        studentGuardians,
        and(
          eq(studentGuardians.tenantId, guardians.tenantId),
          eq(studentGuardians.guardianId, guardians.id),
        ),
      )
      .innerJoin(students, and(eq(students.tenantId, studentGuardians.tenantId), eq(students.id, studentGuardians.studentId)))
      .where(
        and(
          eq(guardians.tenantId, ctx.tenantId ?? ''),
          eq(guardians.userId, ctx.userId),
          isNull(guardians.deletedAt),
          isNull(students.deletedAt),
        ),
      )
      .execute();
    return rows.map((r) => r.studentId);
  }
  if (vis === 'student') {
    const rows = await tx
      .select({ id: students.id })
      .from(students)
      .where(
        and(
          eq(students.tenantId, ctx.tenantId ?? ''),
          eq(students.userId, ctx.userId),
          isNull(students.deletedAt),
        ),
      )
      .execute();
    return rows.map((r) => r.id);
  }
  return [];
}

/** The students a portal should render: the same relationship the read scoping uses. */
async function visibleStudentRefs(
  tx: Tx,
  ctx: Ctx,
  vis: AttendanceVisibility,
): Promise<StudentRef[]> {
  const ids = await readableStudentIds(tx, ctx, vis);
  if (ids === null) {
    return tx
      .select({
        id: students.id,
        studentNo: students.studentNo,
        firstName: students.firstName,
        lastName: students.lastName,
      })
      .from(students)
      .where(and(eq(students.tenantId, ctx.tenantId ?? ''), isNull(students.deletedAt)))
      .orderBy(students.studentNo)
      .execute();
  }
  if (ids.length === 0) return [];
  return tx
    .select({
      id: students.id,
      studentNo: students.studentNo,
      firstName: students.firstName,
      lastName: students.lastName,
    })
    .from(students)
    .where(
      and(
        eq(students.tenantId, ctx.tenantId ?? ''),
        inArray(students.id, ids as string[]),
        isNull(students.deletedAt),
      ),
    )
    .orderBy(students.studentNo)
    .execute();
}

function toContextStudent(row: StudentRef): AttendanceContextStudent {
  return { id: row.id, studentNo: row.studentNo, firstName: row.firstName, lastName: row.lastName };
}

/**
 * Self-scoped portal context (GET /api/v1/me/attendance-context). Built from the
 * caller's ACTIVE tenant role codes and exactly the same relationship joins the
 * list routes use, so a portal can never advertise a student whose attendance the
 * API would refuse to return.
 */
export async function resolveAttendanceContext(
  tx: Tx,
  ctx: Ctx,
): Promise<AttendanceContext> {
  const vis = attendanceVisibility(await tenantRoleCodes(tx, ctx));
  const role: AttendanceContext['role'] = vis === 'none' ? 'none' : vis === 'all' ? 'staff' : vis;
  let refs = await visibleStudentRefs(tx, ctx, vis);
  if (ctx.campusId) {
    const scoped = await tx
      .select({ id: students.id, primaryCampusId: students.primaryCampusId })
      .from(students)
      .where(
        and(
          eq(students.tenantId, ctx.tenantId ?? ''),
          isNull(students.deletedAt),
          eq(students.primaryCampusId, ctx.campusId),
        ),
      )
      .execute();
    const allowed = new Set(scoped.map((r) => r.id));
    refs = refs.filter((r) => allowed.has(r.id));
  }
  return { role, students: refs.map(toContextStudent) };
}

/** Longest span a portal read may request; wider is refused instead of scanned. */
const PORTAL_MAX_SPAN_DAYS = 180;
const PORTAL_DEFAULT_SPAN_DAYS = 30;
const PORTAL_MAX_RECORDS = 200;

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function spanDays(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000) + 1;
}

/**
 * Self-scoped portal read (GET /api/v1/me/attendance). One bucket per student
 * the caller may already see, each with its own tally and day rows — the shape
 * a parent/student dashboard renders without any client-side filtering, so the
 * browser never gets a row the API would not serve.
 */
export async function resolveAttendancePortal(
  tx: Tx,
  ctx: Ctx,
  query: AttendanceRangeQuery,
): Promise<AttendancePortalResponse> {
  const context = await resolveAttendanceContext(tx, ctx);
  // Derive the range from the DATABASE clock (the same `current_date` the
  // marking triggers use) so a read and a mark agree on what "today" is even
  // when the API process and Postgres are in different zones.
  const dbToday = await tx.execute(
    `select to_char(current_date, 'YYYY-MM-DD') as today`,
  ) as unknown as { rows: { today: string }[] };
  const today = dbToday.rows[0]!.today;

  const to = query.to ?? today;
  const from = query.from ?? addDays(to, -(PORTAL_DEFAULT_SPAN_DAYS - 1));
  if (spanDays(from, to) > PORTAL_MAX_SPAN_DAYS) {
    throw new HttpError(`Attendance range may not exceed ${PORTAL_MAX_SPAN_DAYS} days`, {
      status: 400,
      code: 'attendance_range_too_wide',
    });
  }

  const views: AttendancePortalView[] = [];
  for (const student of context.students) {
    const rows = await tx
      .select()
      .from(attendanceDays)
      .where(
        and(
          eq(attendanceDays.tenantId, ctx.tenantId ?? ''),
          eq(attendanceDays.studentId, student.id),
          isNull(attendanceDays.deletedAt),
          gte(attendanceDays.attendanceDate, from),
          lte(attendanceDays.attendanceDate, to),
        ),
      )
      .orderBy(desc(attendanceDays.attendanceDate))
      .limit(PORTAL_MAX_RECORDS)
      .execute();
    const counts: AttendanceReportCounts = { ...EMPTY_COUNTS };
    for (const row of rows) tally(counts, row.status);
    views.push({ student, counts, records: rows.map(toDay) });
  }
  return { context, views };
}

// ------------------------------------------------------------------ marking scope

function markScopeDenied(): HttpError {
  return new HttpError('You may only mark attendance for students in your own classes', {
    status: 403,
    code: 'attendance_scope_denied',
  });
}

type MarkableStudent = { id: string; primaryCampusId: string | null };

/**
 * Write scope for `attendance.mark`. A teacher may only mark students they
 * actively teach; school_owner/principal may mark any student in the school. The
 * target must also be an ACTIVE student of this tenant — the same check the DB
 * trigger performs, mirrored here so the API answers 404 rather than leaking a
 * raw domain conflict for a student it refuses to expose.
 */
export async function resolveMarkableStudent(
  tx: Tx,
  ctx: Ctx,
  codes: readonly string[],
  studentId: string,
): Promise<MarkableStudent> {
  const student = await tx
    .select({ id: students.id, primaryCampusId: students.primaryCampusId, status: students.status })
    .from(students)
    .where(
      and(
        eq(students.tenantId, ctx.tenantId ?? ''),
        eq(students.id, studentId),
        isNull(students.deletedAt),
      ),
    )
    .limit(1)
    .execute()
    .then((r) => r[0]);
  if (!student || student.status !== 'active') throw notFoundError('Student not found');
  assertCampusScope(ctx, student.primaryCampusId);

  if (codes.includes('school_owner') || codes.includes('principal')) {
    return { id: student.id, primaryCampusId: student.primaryCampusId };
  }
  if (!codes.includes('teacher')) throw markScopeDenied();

  const teaches = await tx
    .select({ id: enrollments.id })
    .from(teacherAssignments)
    .innerJoin(
      enrollments,
      and(
        eq(enrollments.tenantId, teacherAssignments.tenantId),
        eq(enrollments.classId, teacherAssignments.classId),
      ),
    )
    .where(
      and(
        eq(teacherAssignments.tenantId, ctx.tenantId ?? ''),
        eq(teacherAssignments.teacherUserId, ctx.userId),
        isNull(teacherAssignments.deletedAt),
        eq(enrollments.studentId, studentId),
        isNull(enrollments.deletedAt),
        eq(enrollments.status, 'active'),
      ),
    )
    .limit(1)
    .execute();
  if (!teaches.length) throw markScopeDenied();
  return { id: student.id, primaryCampusId: student.primaryCampusId };
}

/** A teacher may only mark the sections of classes they are assigned to teach. */
export async function assertMarkableSection(
  tx: Tx,
  ctx: Ctx,
  codes: readonly string[],
  sectionId: string,
): Promise<{ id: string; classId: string; code: string; campusId: string }> {
  const section = await tx
    .select({
      id: sections.id,
      classId: sections.classId,
      code: sections.code,
      campusId: sections.campusId,
    })
    .from(sections)
    .where(
      and(
        eq(sections.tenantId, ctx.tenantId ?? ''),
        eq(sections.id, sectionId),
        isNull(sections.deletedAt),
      ),
    )
    .limit(1)
    .execute()
    .then((r) => r[0]);
  if (!section) throw notFoundError('Section not found');
  assertCampusScope(ctx, section.campusId);

  if (codes.includes('school_owner') || codes.includes('principal')) return section;
  if (!codes.includes('teacher')) throw markScopeDenied();
  const assigned = await tx
    .select({ id: teacherAssignments.id })
    .from(teacherAssignments)
    .where(
      and(
        eq(teacherAssignments.tenantId, ctx.tenantId ?? ''),
        eq(teacherAssignments.classId, section.classId),
        eq(teacherAssignments.teacherUserId, ctx.userId),
        isNull(teacherAssignments.deletedAt),
      ),
    )
    .limit(1)
    .execute();
  if (!assigned.length) throw markScopeDenied();
  return section;
}

/** Read scope for a section register: the same rule, applied to reads. */
export async function assertReadableSection(
  tx: Tx,
  ctx: Ctx,
  codes: readonly string[],
  sectionId: string,
): Promise<{ id: string; classId: string; code: string; campusId: string }> {
  return assertMarkableSection(tx, ctx, codes, sectionId);
}

function toDay(row: DayRow): AttendanceDay {
  return {
    id: row.id,
    tenantId: row.tenantId,
    studentId: row.studentId,
    campusId: row.campusId,
    attendanceDate: row.attendanceDate,
    status: row.status as AttendanceStatus,
    source: row.source as AttendanceDay['source'],
    markedBy: row.markedBy,
    note: row.note,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toPeriod(row: PeriodRow): AttendancePeriod {
  return {
    id: row.id,
    tenantId: row.tenantId,
    studentId: row.studentId,
    sectionId: row.sectionId,
    periodId: row.periodId,
    attendanceDate: row.attendanceDate,
    status: row.status as AttendanceStatus,
    markedBy: row.markedBy,
    note: row.note,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toStaff(row: StaffRow): StaffAttendanceRow {
  return {
    id: row.id,
    tenantId: row.tenantId,
    userId: row.userId,
    attendanceDate: row.attendanceDate,
    clockIn: row.clockIn ? row.clockIn.toISOString() : null,
    clockOut: row.clockOut ? row.clockOut.toISOString() : null,
    status: row.status as StaffAttendanceRow['status'],
    note: row.note,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Counts are COMPUTED from rows, never accumulated, so a report is a snapshot. */
function tally(counts: AttendanceReportCounts, status: string | null): void {
  if (status === null) {
    counts.unmarked += 1;
    return;
  }
  if (status === 'present') counts.present += 1;
  else if (status === 'absent') counts.absent += 1;
  else if (status === 'late') counts.late += 1;
  else if (status === 'excused') counts.excused += 1;
}

// ------------------------------------------------------------------ domain services

export interface MarkResult {
  inserted: AttendanceDay[];
  updated: AttendanceDay[];
}

/**
 * Bulk daily mark, idempotent per (student, date). The unique index is the
 * arbiter: a mark for a day that has no row is an INSERT, a mark for today that
 * already has a row is an UPDATE of that row (the same-day correction path, which
 * is why a `reason` is not required here — the initial mark of the day is not a
 * correction). A PAST date that already has a row is refused by the DB trigger,
 * so history stays frozen.
 *
 * `markedBy` is the caller (never client-supplied) and `campus_id` is the
 * student's own campus, so neither is a mass-assignment surface.
 */
export async function markAttendance(
  tx: Tx,
  ctx: Ctx,
  codes: readonly string[],
  input: MarkAttendanceRequest,
  requestId: string,
): Promise<MarkResult> {
  try {
    const date = input.date;
    const inserted: AttendanceDay[] = [];
    const updated: AttendanceDay[] = [];

    for (const entry of input.entries) {
      const student = await resolveMarkableStudent(tx, ctx, codes, entry.studentId);
      const existing = await tx
        .select()
        .from(attendanceDays)
        .where(
          and(
            eq(attendanceDays.tenantId, ctx.tenantId ?? ''),
            eq(attendanceDays.studentId, student.id),
            eq(attendanceDays.attendanceDate, date),
          ),
        )
        .limit(1)
        .execute()
        .then((r) => r[0]);

      if (existing) {
        const before = existing;
        const rows = await tx
          .update(attendanceDays)
          .set({ status: entry.status, note: entry.note ?? null, markedBy: ctx.userId })
          .where(
            and(
              eq(attendanceDays.tenantId, ctx.tenantId ?? ''),
              eq(attendanceDays.id, existing.id),
            ),
          )
          .returning();
        const row = rows[0]!;
        updated.push(toDay(row));
        await writeAudit(tx, {
          scope: 'tenant',
          tenantId: ctx.tenantId,
          actorUserId: ctx.userId,
          action: 'attendance.corrected',
          resourceType: 'attendance_day',
          resourceId: row.id,
          oldValue: { status: before.status, note: before.note },
          newValue: { status: row.status, note: row.note },
          requestId,
        });
      } else {
        const rows = await tx
          .insert(attendanceDays)
          .values({
            tenantId: ctx.tenantId ?? '',
            studentId: student.id,
            campusId: student.primaryCampusId,
            attendanceDate: date,
            status: entry.status,
            source: 'manual',
            markedBy: ctx.userId,
            note: entry.note ?? null,
          })
          .returning();
        const row = rows[0]!;
        inserted.push(toDay(row));
        await writeAudit(tx, {
          scope: 'tenant',
          tenantId: ctx.tenantId,
          actorUserId: ctx.userId,
          action: 'attendance.marked',
          resourceType: 'attendance_day',
          resourceId: row.id,
          newValue: { status: row.status, date: row.attendanceDate },
          requestId,
        });
      }
    }

    await enqueueOutbox(tx, {
      tenantId: ctx.tenantId,
      eventType: 'attendance.marked',
      aggregateType: 'attendance_day',
      aggregateId: date,
      payload: {
        tenantId: ctx.tenantId,
        attendanceDate: date,
        markedCount: inserted.length,
        correctionCount: updated.length,
      },
      correlationId: requestId,
    });

    return { inserted, updated };
  } catch (err) {
    throw mapDomainError(err);
  }
}

/** Explicit same-day correction with a mandatory reason (the audit trail). */
export async function correctAttendanceDay(
  tx: Tx,
  ctx: Ctx,
  codes: readonly string[],
  id: string,
  input: CorrectAttendanceRequest,
  requestId: string,
): Promise<AttendanceDay> {
  try {
    const before = await tx
      .select()
      .from(attendanceDays)
      .where(and(eq(attendanceDays.tenantId, ctx.tenantId ?? ''), eq(attendanceDays.id, id)))
      .limit(1)
      .execute()
      .then((r) => r[0]);
    if (!before) throw notFoundError('Attendance record not found');
    const visible = await readableStudentIds(tx, ctx, attendanceVisibility(codes));
    if (visible !== null && !visible.includes(before.studentId)) {
      throw notFoundError('Attendance record not found');
    }
    await resolveMarkableStudent(tx, ctx, codes, before.studentId);

    const rows = await tx
      .update(attendanceDays)
      .set({
        status: input.status,
        markedBy: ctx.userId,
        note: input.note === undefined ? before.note : input.note,
      })
      .where(and(eq(attendanceDays.tenantId, ctx.tenantId ?? ''), eq(attendanceDays.id, id)))
      .returning();
    const row = rows[0]!;

    await writeAudit(tx, {
      scope: 'tenant',
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action: 'attendance.corrected',
      resourceType: 'attendance_day',
      resourceId: row.id,
      oldValue: { status: before.status, note: before.note },
      newValue: { status: row.status, note: row.note },
      requestId,
    });
    await enqueueOutbox(tx, {
      tenantId: ctx.tenantId,
      eventType: 'attendance.corrected',
      aggregateType: 'attendance_day',
      aggregateId: row.id,
      payload: {
        tenantId: ctx.tenantId,
        attendanceDate: row.attendanceDate,
        markedCount: 0,
        correctionCount: 1,
      },
      correlationId: requestId,
    });
    return toDay(row);
  } catch (err) {
    throw mapDomainError(err);
  }
}

export interface MarkPeriodsResult {
  inserted: AttendancePeriod[];
  updated: AttendancePeriod[];
}

/** Bulk period mark for one section + one bell period, idempotent per (student, date, period). */
export async function markAttendancePeriods(
  tx: Tx,
  ctx: Ctx,
  codes: readonly string[],
  input: MarkAttendancePeriodsRequest,
  requestId: string,
): Promise<MarkPeriodsResult> {
  try {
    const section = await assertMarkableSection(tx, ctx, codes, input.sectionId);
    const period = await tx
      .select({ id: periods.id })
      .from(periods)
      .where(
        and(
          eq(periods.tenantId, ctx.tenantId ?? ''),
          eq(periods.id, input.periodId),
          isNull(periods.deletedAt),
          eq(periods.status, 'active'),
        ),
      )
      .limit(1)
      .execute()
      .then((r) => r[0]);
    if (!period) throw notFoundError('Period not found');

    const inserted: AttendancePeriod[] = [];
    const updated: AttendancePeriod[] = [];

    for (const entry of input.entries) {
      await resolveMarkableStudent(tx, ctx, codes, entry.studentId);
      const existing = await tx
        .select()
        .from(attendancePeriods)
        .where(
          and(
            eq(attendancePeriods.tenantId, ctx.tenantId ?? ''),
            eq(attendancePeriods.studentId, entry.studentId),
            eq(attendancePeriods.attendanceDate, input.date),
            eq(attendancePeriods.periodId, input.periodId),
          ),
        )
        .limit(1)
        .execute()
        .then((r) => r[0]);

      if (existing) {
        const rows = await tx
          .update(attendancePeriods)
          .set({ status: entry.status, note: entry.note ?? null, markedBy: ctx.userId })
          .where(
            and(
              eq(attendancePeriods.tenantId, ctx.tenantId ?? ''),
              eq(attendancePeriods.id, existing.id),
            ),
          )
          .returning();
        const row = rows[0]!;
        updated.push(toPeriod(row));
        await writeAudit(tx, {
          scope: 'tenant',
          tenantId: ctx.tenantId,
          actorUserId: ctx.userId,
          action: 'attendance.corrected',
          resourceType: 'attendance_period',
          resourceId: row.id,
          oldValue: { status: existing.status, note: existing.note },
          newValue: { status: row.status, note: row.note },
          requestId,
        });
      } else {
        const rows = await tx
          .insert(attendancePeriods)
          .values({
            tenantId: ctx.tenantId ?? '',
            studentId: entry.studentId,
            sectionId: section.id,
            periodId: input.periodId,
            attendanceDate: input.date,
            status: entry.status,
            markedBy: ctx.userId,
            note: entry.note ?? null,
          })
          .returning();
        const row = rows[0]!;
        inserted.push(toPeriod(row));
        await writeAudit(tx, {
          scope: 'tenant',
          tenantId: ctx.tenantId,
          actorUserId: ctx.userId,
          action: 'attendance.marked',
          resourceType: 'attendance_period',
          resourceId: row.id,
          newValue: { status: row.status, date: row.attendanceDate },
          requestId,
        });
      }
    }

    await enqueueOutbox(tx, {
      tenantId: ctx.tenantId,
      eventType: 'attendance.marked',
      aggregateType: 'attendance_period',
      aggregateId: input.periodId,
      payload: {
        tenantId: ctx.tenantId,
        attendanceDate: input.date,
        sectionId: section.id,
        periodId: input.periodId,
        markedCount: inserted.length,
        correctionCount: updated.length,
      },
      correlationId: requestId,
    });

    return { inserted, updated };
  } catch (err) {
    throw mapDomainError(err);
  }
}

export async function correctAttendancePeriod(
  tx: Tx,
  ctx: Ctx,
  codes: readonly string[],
  id: string,
  input: CorrectAttendancePeriodRequest,
  requestId: string,
): Promise<AttendancePeriod> {
  try {
    const before = await tx
      .select()
      .from(attendancePeriods)
      .where(and(eq(attendancePeriods.tenantId, ctx.tenantId ?? ''), eq(attendancePeriods.id, id)))
      .limit(1)
      .execute()
      .then((r) => r[0]);
    if (!before) throw notFoundError('Period attendance record not found');
    const visible = await readableStudentIds(tx, ctx, attendanceVisibility(codes));
    if (visible !== null && !visible.includes(before.studentId)) {
      throw notFoundError('Period attendance record not found');
    }
    await resolveMarkableStudent(tx, ctx, codes, before.studentId);

    const rows = await tx
      .update(attendancePeriods)
      .set({
        status: input.status,
        markedBy: ctx.userId,
        note: input.note === undefined ? before.note : input.note,
      })
      .where(and(eq(attendancePeriods.tenantId, ctx.tenantId ?? ''), eq(attendancePeriods.id, id)))
      .returning();
    const row = rows[0]!;

    await writeAudit(tx, {
      scope: 'tenant',
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action: 'attendance.corrected',
      resourceType: 'attendance_period',
      resourceId: row.id,
      oldValue: { status: before.status, note: before.note },
      newValue: { status: row.status, note: row.note },
      requestId,
    });
    await enqueueOutbox(tx, {
      tenantId: ctx.tenantId,
      eventType: 'attendance.corrected',
      aggregateType: 'attendance_period',
      aggregateId: row.id,
      payload: {
        tenantId: ctx.tenantId,
        attendanceDate: row.attendanceDate,
        markedCount: 0,
        correctionCount: 1,
      },
      correlationId: requestId,
    });
    return toPeriod(row);
  } catch (err) {
    throw mapDomainError(err);
  }
}

/** Light staff clock. Idempotent per (user, date): a second call updates the row. */
export async function markStaffAttendance(
  tx: Tx,
  ctx: Ctx,
  codes: readonly string[],
  input: MarkStaffAttendanceRequest,
  requestId: string,
): Promise<StaffAttendanceRow> {
  try {
    if (!codes.includes('school_owner') && !codes.includes('principal')) throw markScopeDenied();
    const existing = await tx
      .select()
      .from(staffAttendance)
      .where(
        and(
          eq(staffAttendance.tenantId, ctx.tenantId ?? ''),
          eq(staffAttendance.userId, input.userId),
          eq(staffAttendance.attendanceDate, input.date),
        ),
      )
      .limit(1)
      .execute()
      .then((r) => r[0]);

    let row: StaffAttendanceRow;
    let before: StaffAttendanceRow | null = null;
    if (existing) {
      before = toStaff(existing);
      const rows = await tx
        .update(staffAttendance)
        .set({
          status: input.status,
          clockIn: input.clockIn ? new Date(input.clockIn) : existing.clockIn,
          clockOut: input.clockOut ? new Date(input.clockOut) : existing.clockOut,
          note: input.note ?? existing.note,
        })
        .where(
          and(
            eq(staffAttendance.tenantId, ctx.tenantId ?? ''),
            eq(staffAttendance.id, existing.id),
          ),
        )
        .returning();
      row = toStaff(rows[0]!);
    } else {
      const rows = await tx
        .insert(staffAttendance)
        .values({
          tenantId: ctx.tenantId ?? '',
          userId: input.userId,
          attendanceDate: input.date,
          status: input.status,
          clockIn: input.clockIn ? new Date(input.clockIn) : null,
          clockOut: input.clockOut ? new Date(input.clockOut) : null,
          note: input.note ?? null,
        })
        .returning();
      row = toStaff(rows[0]!);
    }

    await writeAudit(tx, {
      scope: 'tenant',
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action: before ? 'attendance.corrected' : 'attendance.marked',
      resourceType: 'staff_attendance',
      resourceId: row.id,
      oldValue: before ? { status: before.status, clockIn: before.clockIn } : null,
      newValue: { status: row.status, clockIn: row.clockIn, clockOut: row.clockOut },
      requestId,
    });
    await enqueueOutbox(tx, {
      tenantId: ctx.tenantId,
      eventType: before ? 'attendance.corrected' : 'attendance.marked',
      aggregateType: 'staff_attendance',
      aggregateId: row.id,
      payload: {
        tenantId: ctx.tenantId,
        attendanceDate: row.attendanceDate,
        markedCount: before ? 0 : 1,
        correctionCount: before ? 1 : 0,
      },
      correlationId: requestId,
    });
    return row;
  } catch (err) {
    throw mapDomainError(err);
  }
}

// ------------------------------------------------------------------ routes

export default async function attendanceRoutes(app: FastifyInstance) {
  app.get(
    '/api/v1/attendance',
    {
      config: { authorization: { kind: 'tenant', permission: 'attendance.read' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('attendance.read')],
    },
    async (request) => {
      const ctx = request.ctx!;
      const query = attendanceListQuerySchema.parse(request.query);
      const codes = await withTenant(app.db, ctx, (tx) => tenantRoleCodes(tx, ctx));
      const vis = attendanceVisibility(codes);
      const allowed = await withTenant(app.db, ctx, (tx) => readableStudentIds(tx, ctx, vis));
      if (allowed !== null && allowed.length === 0) return { items: [], total: 0 };

      const conditions = [eq(attendanceDays.tenantId, ctx.tenantId ?? ''), isNull(attendanceDays.deletedAt)];
      if (allowed !== null) conditions.push(inArray(attendanceDays.studentId, allowed as string[]));
      if (query.date) conditions.push(eq(attendanceDays.attendanceDate, query.date));
      if (query.from) conditions.push(gte(attendanceDays.attendanceDate, query.from));
      if (query.to) conditions.push(lte(attendanceDays.attendanceDate, query.to));
      if (query.studentId) conditions.push(eq(attendanceDays.studentId, query.studentId));
      if (query.status) conditions.push(eq(attendanceDays.status, query.status));
      if (query.campusId) conditions.push(eq(attendanceDays.campusId, query.campusId));

      const rows = await withTenant(app.db, ctx, (tx) =>
        tx
          .select()
          .from(attendanceDays)
          .where(and(...conditions))
          .orderBy(desc(attendanceDays.attendanceDate), attendanceDays.studentId)
          .limit(query.limit)
          .offset(query.offset)
          .execute(),
      );
      const totalRow = await withTenant(app.db, ctx, (tx) =>
        tx.select({ total: count() }).from(attendanceDays).where(and(...conditions)).execute(),
      );
      return {
        items: rows.map(toDay),
        total: totalRow[0]?.total ?? 0,
      };
    },
  );

  app.get(
    '/api/v1/attendance/periods',
    {
      config: { authorization: { kind: 'tenant', permission: 'attendance.read' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('attendance.read')],
    },
    async (request) => {
      const ctx = request.ctx!;
      const query = attendancePeriodListQuerySchema.parse(request.query);
      const codes = await withTenant(app.db, ctx, (tx) => tenantRoleCodes(tx, ctx));
      const vis = attendanceVisibility(codes);
      const allowed = await withTenant(app.db, ctx, (tx) => readableStudentIds(tx, ctx, vis));
      if (allowed !== null && allowed.length === 0) return { items: [], total: 0 };

      const conditions = [
        eq(attendancePeriods.tenantId, ctx.tenantId ?? ''),
        isNull(attendancePeriods.deletedAt),
      ];
      if (allowed !== null) conditions.push(inArray(attendancePeriods.studentId, allowed as string[]));
      if (query.date) conditions.push(eq(attendancePeriods.attendanceDate, query.date));
      if (query.from) conditions.push(gte(attendancePeriods.attendanceDate, query.from));
      if (query.to) conditions.push(lte(attendancePeriods.attendanceDate, query.to));
      if (query.sectionId) conditions.push(eq(attendancePeriods.sectionId, query.sectionId));
      if (query.periodId) conditions.push(eq(attendancePeriods.periodId, query.periodId));
      if (query.studentId) conditions.push(eq(attendancePeriods.studentId, query.studentId));
      if (query.status) conditions.push(eq(attendancePeriods.status, query.status));

      const rows = await withTenant(app.db, ctx, (tx) =>
        tx
          .select()
          .from(attendancePeriods)
          .where(and(...conditions))
          .orderBy(desc(attendancePeriods.attendanceDate), attendancePeriods.studentId, attendancePeriods.periodId)
          .limit(query.limit)
          .offset(query.offset)
          .execute(),
      );
      const totalRow = await withTenant(app.db, ctx, (tx) =>
        tx.select({ total: count() }).from(attendancePeriods).where(and(...conditions)).execute(),
      );
      return { items: rows.map(toPeriod), total: totalRow[0]?.total ?? 0 };
    },
  );

  /**
   * Section register for one date. Serves BOTH the teacher marking UI and the
   * admin class/day dashboard — one read, one shape, so the two surfaces can
   * never disagree about who is on the register. Reads are scoped to the same
   * rule as writes, so a teacher cannot page another teacher's register.
   */
  app.get(
    '/api/v1/attendance/reports/class',
    {
      config: { authorization: { kind: 'tenant', permission: 'attendance.read' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('attendance.read')],
    },
    async (request) => {
      const ctx = request.ctx!;
      const query = attendanceRosterQuerySchema.parse(request.query);
      const result = await withTenant(app.db, ctx, async (tx) => {
        const codes = await tenantRoleCodes(tx, ctx);
        const section = await assertReadableSection(tx, ctx, codes, query.sectionId);
        const klass = await tx
          .select({ id: acdClasses.id, name: acdClasses.name })
          .from(acdClasses)
          .where(and(eq(acdClasses.tenantId, ctx.tenantId ?? ''), eq(acdClasses.id, section.classId)))
          .limit(1)
          .execute()
          .then((r) => r[0]);

        const roster = await tx
          .select({
            studentId: students.id,
            studentNo: students.studentNo,
            firstName: students.firstName,
            lastName: students.lastName,
            rollNo: enrollments.rollNo,
          })
          .from(enrollments)
          .innerJoin(
            students,
            and(eq(students.tenantId, enrollments.tenantId), eq(students.id, enrollments.studentId)),
          )
          .where(
            and(
              eq(enrollments.tenantId, ctx.tenantId ?? ''),
              eq(enrollments.sectionId, section.id),
              eq(enrollments.status, 'active'),
              isNull(enrollments.deletedAt),
              isNull(students.deletedAt),
            ),
          )
          .orderBy(enrollments.rollNo, students.studentNo)
          .execute();

        const marked = await tx
          .select()
          .from(attendanceDays)
          .where(
            and(
              eq(attendanceDays.tenantId, ctx.tenantId ?? ''),
              eq(attendanceDays.attendanceDate, query.date),
              isNull(attendanceDays.deletedAt),
            ),
          )
          .execute();
        const byStudent = new Map(marked.map((m) => [m.studentId, m]));

        const entries: AttendanceRosterEntry[] = roster.map((r) => {
          const hit = byStudent.get(r.studentId);
          return {
            studentId: r.studentId,
            studentNo: r.studentNo,
            firstName: r.firstName,
            lastName: r.lastName,
            rollNo: r.rollNo,
            status: (hit?.status as AttendanceStatus | undefined) ?? null,
            attendanceId: hit?.id ?? null,
          };
        });

        const counts: AttendanceReportCounts = { ...EMPTY_COUNTS };
        for (const e of entries) tally(counts, e.status);

        return {
          sectionId: section.id,
          sectionCode: section.code,
          classId: section.classId,
          className: klass?.name ?? '',
          campusId: section.campusId,
          date: query.date,
          counts,
          entries,
        };
      });
      return result;
    },
  );

  app.get(
    '/api/v1/attendance/reports/student',
    {
      config: { authorization: { kind: 'tenant', permission: 'attendance.read' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('attendance.read')],
    },
    async (request) => {
      const ctx = request.ctx!;
      const query = attendanceStudentReportQuerySchema.parse(request.query);
      const result = await withTenant(app.db, ctx, async (tx) => {
        const codes = await tenantRoleCodes(tx, ctx);
        const vis = attendanceVisibility(codes);
        const allowed = await readableStudentIds(tx, ctx, vis);
        // Outside the caller's reachable students the student is simply not found
        // — a parent asking for another family's child gets 404, never data.
        if (allowed !== null && !allowed.includes(query.studentId)) {
          throw notFoundError('Student not found');
        }
        // School-wide visibility still resolves the student INSIDE this tenant
        // first: without this an id from another tenant (or a deleted student)
        // would answer 200 with a zeroed tally instead of 404.
        const target = await tx
          .select({ id: students.id })
          .from(students)
          .where(
            and(
              eq(students.tenantId, ctx.tenantId ?? ''),
              eq(students.id, query.studentId),
              isNull(students.deletedAt),
            ),
          )
          .limit(1)
          .execute()
          .then((r) => r[0]);
        if (!target) throw notFoundError('Student not found');

        const rows = await tx
          .select({ status: attendanceDays.status })
          .from(attendanceDays)
          .where(
            and(
              eq(attendanceDays.tenantId, ctx.tenantId ?? ''),
              eq(attendanceDays.studentId, query.studentId),
              gte(attendanceDays.attendanceDate, query.from),
              lte(attendanceDays.attendanceDate, query.to),
              isNull(attendanceDays.deletedAt),
            ),
          )
          .execute();
        const counts: AttendanceReportCounts = { ...EMPTY_COUNTS };
        for (const r of rows) tally(counts, r.status);
        return { studentId: query.studentId, from: query.from, to: query.to, counts };
      });
      return result;
    },
  );

  app.post(
    '/api/v1/attendance/mark',
    {
      config: { authorization: { kind: 'tenant', permission: 'attendance.mark' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('attendance.mark'), requireCsrf()],
    },
    async (request, reply) => {
      const ctx = request.ctx!;
      const body = markAttendanceRequestSchema.parse(request.body);
      const idemKey = idempotencyKeyFromHeader(request.headers);
      const fingerprint = requestFingerprint(request.method, request.url, body);
      const outcome = await withTenant(app.db, ctx, (tx) =>
        withIdempotency(tx, { tenantId: ctx.tenantId, key: idemKey }, fingerprint, async () => {
          const codes = await tenantRoleCodes(tx, ctx);
          const result = await markAttendance(tx, ctx, codes, body, request.requestId);
          return {
            status: 200,
            body: {
              attendance: {
                date: body.date,
                marked: result.inserted.length + result.updated.length,
                inserted: result.inserted.length,
                corrected: result.updated.length,
                items: [...result.inserted, ...result.updated],
              },
            },
          };
        }),
      );
      return reply.code(outcome.status).send(outcome.body);
    },
  );

  app.patch(
    '/api/v1/attendance/:id/correct',
    {
      config: { authorization: { kind: 'tenant', permission: 'attendance.mark' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('attendance.mark'), requireCsrf()],
    },
    async (request, reply) => {
      const ctx = request.ctx!;
      const { id } = request.params as { id: string };
      const body = correctAttendanceRequestSchema.parse(request.body);
      const idemKey = idempotencyKeyFromHeader(request.headers);
      const fingerprint = requestFingerprint(request.method, request.url, body);
      const outcome = await withTenant(app.db, ctx, (tx) =>
        withIdempotency(tx, { tenantId: ctx.tenantId, key: idemKey }, fingerprint, async () => {
          const codes = await tenantRoleCodes(tx, ctx);
          const row = await correctAttendanceDay(tx, ctx, codes, id, body, request.requestId);
          return { status: 200, body: { attendance: row, reason: body.reason } };
        }),
      );
      return reply.code(outcome.status).send(outcome.body);
    },
  );

  app.post(
    '/api/v1/attendance/periods/mark',
    {
      config: { authorization: { kind: 'tenant', permission: 'attendance.mark' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('attendance.mark'), requireCsrf()],
    },
    async (request, reply) => {
      const ctx = request.ctx!;
      const body = markAttendancePeriodsRequestSchema.parse(request.body);
      const idemKey = idempotencyKeyFromHeader(request.headers);
      const fingerprint = requestFingerprint(request.method, request.url, body);
      const outcome = await withTenant(app.db, ctx, (tx) =>
        withIdempotency(tx, { tenantId: ctx.tenantId, key: idemKey }, fingerprint, async () => {
          const codes = await tenantRoleCodes(tx, ctx);
          const result = await markAttendancePeriods(tx, ctx, codes, body, request.requestId);
          return {
            status: 200,
            body: {
              attendance: {
                date: body.date,
                sectionId: body.sectionId,
                periodId: body.periodId,
                marked: result.inserted.length + result.updated.length,
                inserted: result.inserted.length,
                corrected: result.updated.length,
                items: [...result.inserted, ...result.updated],
              },
            },
          };
        }),
      );
      return reply.code(outcome.status).send(outcome.body);
    },
  );

  app.patch(
    '/api/v1/attendance/periods/:id/correct',
    {
      config: { authorization: { kind: 'tenant', permission: 'attendance.mark' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('attendance.mark'), requireCsrf()],
    },
    async (request, reply) => {
      const ctx = request.ctx!;
      const { id } = request.params as { id: string };
      const body = correctAttendancePeriodRequestSchema.parse(request.body);
      const idemKey = idempotencyKeyFromHeader(request.headers);
      const fingerprint = requestFingerprint(request.method, request.url, body);
      const outcome = await withTenant(app.db, ctx, (tx) =>
        withIdempotency(tx, { tenantId: ctx.tenantId, key: idemKey }, fingerprint, async () => {
          const codes = await tenantRoleCodes(tx, ctx);
          const row = await correctAttendancePeriod(tx, ctx, codes, id, body, request.requestId);
          return { status: 200, body: { attendance: row, reason: body.reason } };
        }),
      );
      return reply.code(outcome.status).send(outcome.body);
    },
  );

  app.get(
    '/api/v1/staff-attendance',
    {
      config: { authorization: { kind: 'tenant', permission: 'attendance.read' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('attendance.read')],
    },
    async (request) => {
      const ctx = request.ctx!;
      const query = staffAttendanceListQuerySchema.parse(request.query);
      const conditions = [
        eq(staffAttendance.tenantId, ctx.tenantId ?? ''),
        isNull(staffAttendance.deletedAt),
      ];
      if (query.date) conditions.push(eq(staffAttendance.attendanceDate, query.date));
      if (query.userId) conditions.push(eq(staffAttendance.userId, query.userId));
      if (query.status) conditions.push(eq(staffAttendance.status, query.status));
      const rows = await withTenant(app.db, ctx, (tx) =>
        tx
          .select()
          .from(staffAttendance)
          .where(and(...conditions))
          .orderBy(desc(staffAttendance.attendanceDate), staffAttendance.userId)
          .limit(query.limit)
          .offset(query.offset)
          .execute(),
      );
      const totalRow = await withTenant(app.db, ctx, (tx) =>
        tx.select({ total: count() }).from(staffAttendance).where(and(...conditions)).execute(),
      );
      return { items: rows.map(toStaff), total: totalRow[0]?.total ?? 0 };
    },
  );

  app.post(
    '/api/v1/staff-attendance/mark',
    {
      config: { authorization: { kind: 'tenant', permission: 'attendance.mark' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('attendance.mark'), requireCsrf()],
    },
    async (request, reply) => {
      const ctx = request.ctx!;
      const body = markStaffAttendanceRequestSchema.parse(request.body);
      const idemKey = idempotencyKeyFromHeader(request.headers);
      const fingerprint = requestFingerprint(request.method, request.url, body);
      const outcome = await withTenant(app.db, ctx, (tx) =>
        withIdempotency(tx, { tenantId: ctx.tenantId, key: idemKey }, fingerprint, async () => {
          const codes = await tenantRoleCodes(tx, ctx);
          const row = await markStaffAttendance(tx, ctx, codes, body, request.requestId);
          return { status: 200, body: { attendance: row } };
        }),
      );
      return reply.code(outcome.status).send(outcome.body);
    },
  );
}
