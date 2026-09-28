import type { FastifyInstance } from 'fastify';
import { and, asc, count, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  academicTerms,
  academicYears,
  acdClasses,
  classSubjects,
  enrollments,
  examSchedules,
  examSubjects,
  examTypes,
  exams,
  files,
  gradingScales,
  markCorrections,
  marks,
  reportCards,
  reportCardSubjects,
  sections,
  students,
  subjects,
  teacherAssignments,
  withTenant,
  type Tx,
} from '@sms/db';
import { HttpError } from '@sms/core';
import { writeAudit } from '@sms/audit';
import { enqueueOutbox } from '@sms/events';
import { requestFingerprint, withIdempotency } from '@sms/idempotency';
import {
  correctMarkRequestSchema,
  createExamRequestSchema,
  createExamScheduleRequestSchema,
  createExamSubjectRequestSchema,
  createExamTypeRequestSchema,
  createGradingScaleRequestSchema,
  enterMarksRequestSchema,
  examListQuerySchema,
  examStatusTransitionRequestSchema,
  reportCardListQuerySchema,
  resultsPortalQuerySchema,
  updateExamRequestSchema,
  updateExamScheduleRequestSchema,
  updateExamSubjectRequestSchema,
  updateExamTypeRequestSchema,
  updateGradingScaleRequestSchema,
  type CorrectMarkRequest,
  type CreateExamRequest,
  type CreateExamScheduleRequest,
  type CreateExamSubjectRequest,
  type CreateExamTypeRequest,
  type CreateGradingScaleRequest,
  type EnterMarksRequest,
  type Exam,
  type ExamListQuery,
  type ExamSchedule,
  type ExamStatusTransitionRequest,
  type ExamSubject,
  type ExamType,
  type GradebookResponse,
  type GradingScale,
  type Mark,
  type MarkCorrection,
  type MarkEntryResponse,
  type ReportCard,
  type ReportCardDetail,
  type ResultsPortalResponse,
  type ResultsPortalView,
  type TranscriptEntry,
  type UpdateExamRequest,
  type UpdateExamScheduleRequest,
  type UpdateExamSubjectRequest,
  type UpdateExamTypeRequest,
  type UpdateGradingScaleRequest,
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
  parsePagination,
} from './util.js';
import { attendanceVisibility, readableStudentIds, type AttendanceVisibility } from './attendance.js';
import { tenantRoleCodes } from './homework.js';

type Ctx = { userId: string; tenantId: string | null; campusId: string | null };

type ExamTypeRow = typeof examTypes.$inferSelect;
type GradingScaleRow = typeof gradingScales.$inferSelect;
type ExamRow = typeof exams.$inferSelect;
type ExamSubjectRow = typeof examSubjects.$inferSelect;
type ExamScheduleRow = typeof examSchedules.$inferSelect;
type MarkRow = typeof marks.$inferSelect;
type ReportCardRow = typeof reportCards.$inferSelect;
type MarkCorrectionRow = typeof markCorrections.$inferSelect;

type Numeric = string | number | null | undefined;

/** Postgres `numeric` arrives as a string; the API contract is a JS number. */
function num(value: Numeric): number | null {
  if (value === null || value === undefined) return null;
  return Number(value);
}

// ------------------------------------------------------------------ mappers

export function toExamType(row: ExamTypeRow): ExamType {
  return {
    id: row.id,
    tenantId: row.tenantId,
    code: row.code,
    name: row.name,
    isActive: row.isActive,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toGradingScale(row: GradingScaleRow): GradingScale {
  return {
    id: row.id,
    tenantId: row.tenantId,
    code: row.code,
    name: row.name,
    version: row.version,
    isActive: row.isActive,
    bands: row.bands.map((band) => ({
      label: band.label,
      minPercent: Number(band.minPercent),
      maxPercent: Number(band.maxPercent),
      gradePoint: Number(band.gradePoint),
    })),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toExam(row: ExamRow): Exam {
  return {
    id: row.id,
    tenantId: row.tenantId,
    academicTermId: row.academicTermId,
    academicYearId: row.academicYearId,
    examTypeId: row.examTypeId,
    campusId: row.campusId,
    name: row.name,
    status: row.status as Exam['status'],
    publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toExamSubject(row: ExamSubjectRow): ExamSubject {
  return {
    id: row.id,
    tenantId: row.tenantId,
    examId: row.examId,
    classSubjectId: row.classSubjectId,
    academicYearId: row.academicYearId,
    classId: row.classId,
    subjectId: row.subjectId,
    maxMarks: Number(row.maxMarks),
    weight: Number(row.weight),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toExamSchedule(row: ExamScheduleRow): ExamSchedule {
  return {
    id: row.id,
    tenantId: row.tenantId,
    examSubjectId: row.examSubjectId,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    room: row.room,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toMark(row: MarkRow): Mark {
  return {
    id: row.id,
    tenantId: row.tenantId,
    examSubjectId: row.examSubjectId,
    enrollmentId: row.enrollmentId,
    studentId: row.studentId,
    sectionId: row.sectionId,
    marksObtained: num(row.marksObtained),
    percentage: num(row.percentage),
    gradeLabel: row.gradeLabel,
    gradePoint: num(row.gradePoint),
    status: row.status as Mark['status'],
    enteredBy: row.enteredBy,
    lockedAt: row.lockedAt ? row.lockedAt.toISOString() : null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toReportCard(row: ReportCardRow): ReportCard {
  return {
    id: row.id,
    tenantId: row.tenantId,
    examId: row.examId,
    studentId: row.studentId,
    enrollmentId: row.enrollmentId,
    version: row.version,
    status: row.status as ReportCard['status'],
    gpa: num(row.gpa),
    totalObtained: num(row.totalObtained),
    totalPossible: Number(row.totalPossible),
    subjectCount: row.subjectCount,
    fileId: row.fileId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toMarkCorrection(row: MarkCorrectionRow): MarkCorrection {
  return {
    id: row.id,
    tenantId: row.tenantId,
    markId: row.markId,
    oldMarksObtained: num(row.oldMarksObtained),
    newMarksObtained: Number(row.newMarksObtained),
    reason: row.reason,
    correctedBy: row.correctedBy,
    createdAt: row.createdAt.toISOString(),
  };
}

// ------------------------------------------------------------------ loaders & guards

async function loadExam(tx: Tx, ctx: Ctx, id: string): Promise<ExamRow> {
  const row = await tx
    .select()
    .from(exams)
    .where(and(eq(exams.tenantId, ctx.tenantId ?? ''), eq(exams.id, id), isNull(exams.deletedAt)))
    .limit(1)
    .execute()
    .then((r) => r[0]);
  if (!row) throw notFoundError('Exam not found');
  return row;
}

async function loadExamSubject(tx: Tx, ctx: Ctx, id: string): Promise<ExamSubjectRow> {
  const row = await tx
    .select()
    .from(examSubjects)
    .where(
      and(eq(examSubjects.tenantId, ctx.tenantId ?? ''), eq(examSubjects.id, id), isNull(examSubjects.deletedAt)),
    )
    .limit(1)
    .execute()
    .then((r) => r[0]);
  if (!row) throw notFoundError('Exam subject not found');
  return row;
}

/**
 * Teacher ownership of an exam subject. Mark entry is scoped to the caller's own
 * class subject: `exams.mark` proves the caller may enter marks SOMEWHERE, this
 * join proves it is this exam subject. A principal holds `exams.manage`/`publish`
 * but deliberately NOT `exams.mark`, so there is no administrative bypass here.
 */
export async function assertTeacherOwnsExamSubject(tx: Tx, ctx: Ctx, examSubjectId: string): Promise<ExamSubjectRow> {
  const es = await loadExamSubject(tx, ctx, examSubjectId);
  const owns = await tx
    .select({ id: teacherAssignments.id })
    .from(teacherAssignments)
    .where(
      and(
        eq(teacherAssignments.tenantId, ctx.tenantId ?? ''),
        eq(teacherAssignments.classId, es.classId),
        eq(teacherAssignments.subjectId, es.subjectId),
        eq(teacherAssignments.teacherUserId, ctx.userId),
        isNull(teacherAssignments.deletedAt),
      ),
    )
    .limit(1)
    .execute()
    .then((r) => r[0]);
  if (!owns) {
    throw new HttpError('You may only enter marks for your own class subjects', {
      status: 403,
      code: 'exam_subject_not_assigned',
    });
  }
  return es;
}

/**
 * Result-read visibility. Same relationship ladder as attendance (staff all,
 * teacher own students, parent linked children, student self) and additionally
 * PUBLISHED-ONLY for everyone who is not school staff: an unpublished result set
 * is a staff working document.
 */
export function resultsVisibility(codes: readonly string[]): AttendanceVisibility {
  return attendanceVisibility(codes);
}

/** Student ids the caller may read RESULTS for, or null for school-wide staff. */
export async function readableResultStudentIds(
  tx: Tx,
  ctx: Ctx,
  vis: AttendanceVisibility,
): Promise<readonly string[] | null> {
  return readableStudentIds(tx, ctx, vis);
}

function isStaff(vis: AttendanceVisibility): boolean {
  return vis === 'all' || vis === 'teacher';
}

/**
 * The gradebook is a STAFF working document: a class roster plus every student's
 * mark, including ungraded and provisional cells. `exams.read` is also granted to
 * parents and students, so the permission alone is not enough — school-wide staff
 * (principal/owner) may read any gradebook, and a teacher only the exam subjects
 * they are assigned to teach. Everyone else gets 403, never an empty grid.
 */
export async function assertResultsStaff(
  tx: Tx,
  ctx: Ctx,
  examSubjectId: string,
): Promise<ExamSubjectRow> {
  const codes = await tenantRoleCodes(tx, ctx);
  const vis = resultsVisibility(codes);
  if (vis === 'all') return loadExamSubject(tx, ctx, examSubjectId);
  if (vis === 'teacher') return assertTeacherOwnsExamSubject(tx, ctx, examSubjectId);
  throw new HttpError('The gradebook is available to school staff only', {
    status: 403,
    code: 'gradebook_scope_denied',
  });
}

/**
 * An exam's configuration (subjects, schedule, weight) is a working document until
 * the exam is published: a parent or student sees only published exams, so a draft
 * mid-term and its unpublished subject list never leak through a list route.
 */
export function assertPublishedExamForNonStaff(exam: ExamRow, vis: AttendanceVisibility): void {
  if (isStaff(vis)) return;
  if (exam.status !== 'published') throw notFoundError('Exam not found');
}

// ------------------------------------------------------------------ exam types

export async function createExamType(
  tx: Tx,
  ctx: Ctx,
  input: CreateExamTypeRequest,
  requestId: string,
): Promise<ExamType> {
  try {
    const rows = await tx
      .insert(examTypes)
      .values({
        tenantId: ctx.tenantId ?? '',
        code: input.code,
        name: input.name,
        isActive: true,
      })
      .returning();
    const row = rows[0]!;
    await writeAudit(tx, {
      scope: 'tenant',
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action: 'exam.type.created',
      resourceType: 'exam_type',
      resourceId: row.id,
      newValue: { code: row.code, name: row.name },
      requestId,
    });
    return toExamType(row);
  } catch (err) {
    throw mapDomainError(err);
  }
}

export async function updateExamType(
  tx: Tx,
  ctx: Ctx,
  id: string,
  input: UpdateExamTypeRequest,
  requestId: string,
): Promise<ExamType | null> {
  try {
    const before = await tx
      .select()
      .from(examTypes)
      .where(and(eq(examTypes.tenantId, ctx.tenantId ?? ''), eq(examTypes.id, id), isNull(examTypes.deletedAt)))
      .limit(1)
      .execute()
      .then((r) => r[0]);
    if (!before) return null;
    const set: Partial<ExamTypeRow> = {};
    if (input.name !== undefined) set.name = input.name;
    if (input.isActive !== undefined) set.isActive = input.isActive;
    const rows = await tx
      .update(examTypes)
      .set(set)
      .where(and(eq(examTypes.tenantId, ctx.tenantId ?? ''), eq(examTypes.id, id), isNull(examTypes.deletedAt)))
      .returning();
    const row = rows[0];
    if (!row) return null;
    await writeAudit(tx, {
      scope: 'tenant',
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action: 'exam.type.updated',
      resourceType: 'exam_type',
      resourceId: row.id,
      oldValue: { name: before.name, isActive: before.isActive },
      newValue: { name: row.name, isActive: row.isActive },
      requestId,
    });
    return toExamType(row);
  } catch (err) {
    throw mapDomainError(err);
  }
}

// ------------------------------------------------------------------ grading scales

export async function createGradingScale(
  tx: Tx,
  ctx: Ctx,
  input: CreateGradingScaleRequest,
  requestId: string,
): Promise<GradingScale> {
  try {
    // The version is the HISTORY axis of a scale, so it is server-owned: the next
    // version for this code. Bands are validated (tiling 0..100) by the trigger.
    const current = await tx
      .select({ version: gradingScales.version })
      .from(gradingScales)
      .where(and(eq(gradingScales.tenantId, ctx.tenantId ?? ''), eq(gradingScales.code, input.code), isNull(gradingScales.deletedAt)))
      .orderBy(desc(gradingScales.version))
      .limit(1)
      .execute()
      .then((r) => r[0]);

    const rows = await tx
      .insert(gradingScales)
      .values({
        tenantId: ctx.tenantId ?? '',
        code: input.code,
        name: input.name,
        version: (current?.version ?? 0) + 1,
        // A new version never silently displaces the active one.
        isActive: input.isActive ?? false,
        bands: input.bands,
      })
      .returning();
    const row = rows[0]!;
    await writeAudit(tx, {
      scope: 'tenant',
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action: 'grading_scale.created',
      resourceType: 'grading_scale',
      resourceId: row.id,
      newValue: { code: row.code, version: row.version, bands: row.bands },
      requestId,
    });
    return toGradingScale(row);
  } catch (err) {
    throw mapDomainError(err);
  }
}

export async function updateGradingScale(
  tx: Tx,
  ctx: Ctx,
  id: string,
  input: UpdateGradingScaleRequest,
  requestId: string,
): Promise<GradingScale | null> {
  try {
    const before = await tx
      .select()
      .from(gradingScales)
      .where(
        and(eq(gradingScales.tenantId, ctx.tenantId ?? ''), eq(gradingScales.id, id), isNull(gradingScales.deletedAt)),
      )
      .limit(1)
      .execute()
      .then((r) => r[0]);
    if (!before) return null;
    const set: Partial<GradingScaleRow> = {};
    if (input.name !== undefined) set.name = input.name;
    if (input.isActive !== undefined) set.isActive = input.isActive;
    const rows = await tx
      .update(gradingScales)
      .set(set)
      .where(
        and(eq(gradingScales.tenantId, ctx.tenantId ?? ''), eq(gradingScales.id, id), isNull(gradingScales.deletedAt)),
      )
      .returning();
    const row = rows[0];
    if (!row) return null;
    await writeAudit(tx, {
      scope: 'tenant',
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action: 'grading_scale.updated',
      resourceType: 'grading_scale',
      resourceId: row.id,
      oldValue: { name: before.name, isActive: before.isActive },
      newValue: { name: row.name, isActive: row.isActive },
      requestId,
    });
    return toGradingScale(row);
  } catch (err) {
    throw mapDomainError(err);
  }
}

// ------------------------------------------------------------------ exams

export async function createExam(
  tx: Tx,
  ctx: Ctx,
  input: CreateExamRequest,
  requestId: string,
): Promise<Exam> {
  try {
    // The academic year is DERIVED from the term, so an exam can never be pinned
    // to a year the term does not belong to.
    const term = await tx
      .select({ id: academicTerms.id, academicYearId: academicTerms.academicYearId })
      .from(academicTerms)
      .where(
        and(
          eq(academicTerms.tenantId, ctx.tenantId ?? ''),
          eq(academicTerms.id, input.academicTermId),
          isNull(academicTerms.deletedAt),
        ),
      )
      .limit(1)
      .execute()
      .then((r) => r[0]);
    if (!term) throw notFoundError('Academic term not found');

    if (input.gradingScaleId) {
      const scale = await tx
        .select({ id: gradingScales.id })
        .from(gradingScales)
        .where(
          and(
            eq(gradingScales.tenantId, ctx.tenantId ?? ''),
            eq(gradingScales.id, input.gradingScaleId),
            isNull(gradingScales.deletedAt),
          ),
        )
        .limit(1)
        .execute()
        .then((r) => r[0]);
      if (!scale) throw notFoundError('Grading scale not found');
    }

    assertCampusScope(ctx, input.campusId ?? null);

    const rows = await tx
      .insert(exams)
      .values({
        tenantId: ctx.tenantId ?? '',
        academicTermId: term.id,
        academicYearId: term.academicYearId,
        examTypeId: input.examTypeId,
        campusId: input.campusId ?? null,
        gradingScaleId: input.gradingScaleId ?? null,
        name: input.name,
        // Lifecycle is server-owned: an exam is always created as a draft.
        status: 'draft',
      })
      .returning();
    const row = rows[0]!;
    await writeAudit(tx, {
      scope: 'tenant',
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action: 'exam.created',
      resourceType: 'exam',
      resourceId: row.id,
      newValue: {
        name: row.name,
        academicTermId: row.academicTermId,
        academicYearId: row.academicYearId,
        examTypeId: row.examTypeId,
        status: row.status,
      },
      requestId,
    });
    return toExam(row);
  } catch (err) {
    throw mapDomainError(err);
  }
}

export async function updateExam(
  tx: Tx,
  ctx: Ctx,
  id: string,
  input: UpdateExamRequest,
  requestId: string,
): Promise<Exam | null> {
  try {
    const before = await loadExam(tx, ctx, id);
    const set: Partial<ExamRow> = {};
    if (input.name !== undefined) set.name = input.name;
    const rows = await tx
      .update(exams)
      .set(set)
      .where(and(eq(exams.tenantId, ctx.tenantId ?? ''), eq(exams.id, id), isNull(exams.deletedAt)))
      .returning();
    const row = rows[0];
    if (!row) return null;
    await writeAudit(tx, {
      scope: 'tenant',
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action: 'exam.updated',
      resourceType: 'exam',
      resourceId: row.id,
      oldValue: { name: before.name },
      newValue: { name: row.name },
      requestId,
    });
    return toExam(row);
  } catch (err) {
    throw mapDomainError(err);
  }
}

/**
 * Lifecycle transition for the NON-publication states. Publication is a separate
 * endpoint and permission, so `exams.manage` can never publish results. The DB
 * lifecycle trigger is the authority on which transition is legal.
 */
export async function transitionExamStatus(
  tx: Tx,
  ctx: Ctx,
  id: string,
  input: ExamStatusTransitionRequest,
  requestId: string,
): Promise<Exam> {
  try {
    const before = await loadExam(tx, ctx, id);
    if (before.status === input.status) return toExam(before);
    const rows = await tx
      .update(exams)
      .set({ status: input.status })
      .where(
        and(
          eq(exams.tenantId, ctx.tenantId ?? ''),
          eq(exams.id, id),
          isNull(exams.deletedAt),
          eq(exams.status, before.status),
        ),
      )
      .returning();
    const row = rows[0];
    if (!row) {
      throw new HttpError('Exam status changed concurrently; reload and retry', {
        status: 409,
        code: 'exam_status_conflict',
      });
    }
    await writeAudit(tx, {
      scope: 'tenant',
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action: 'exam.status_changed',
      resourceType: 'exam',
      resourceId: row.id,
      oldValue: { status: before.status },
      newValue: { status: row.status },
      requestId,
    });
    return toExam(row);
  } catch (err) {
    throw mapDomainError(err);
  }
}

/**
 * Publication. `exams.publish` is held by principal/owner only, and the whole
 * publication is ONE transaction:
 *   * the exam flips to `published` (the trigger sweeps its provisional marks to
 *     `locked` in the same transaction, so a published exam can never show a
 *     provisional value);
 *   * any report cards computed while the exam is grading are reconciled with their
 *     own frozen subject lines and published with it;
 *   * `exam.result.published` is audited;
 *   * `exam.result.compute` is queued so the WORKER computes/refreshes the result
 *     set for every enrolled student, and `exam.published` for the family
 *     notification stub.
 * Nothing is readable by a family before the worker has produced the cards, so a
 * half-computed publication is never observable.
 */
export async function publishExam(
  tx: Tx,
  ctx: Ctx,
  id: string,
  requestId: string,
): Promise<{ exam: Exam; publishedReportCards: number }> {
  try {
    const before = await loadExam(tx, ctx, id);
    if (before.status === 'published') {
      return { exam: toExam(before), publishedReportCards: 0 };
    }
    if (!['draft', 'scheduled', 'grading'].includes(before.status)) {
      throw new HttpError(`An exam in status ${before.status} cannot be published`, {
        status: 409,
        code: 'exam_not_publishable',
      });
    }

    const subjects = await tx
      .select({ id: examSubjects.id })
      .from(examSubjects)
      .where(
        and(eq(examSubjects.tenantId, ctx.tenantId ?? ''), eq(examSubjects.examId, id), isNull(examSubjects.deletedAt)),
      )
      .execute();
    if (!subjects.length) {
      throw new HttpError('An exam needs at least one subject before publication', {
        status: 409,
        code: 'exam_has_no_subjects',
      });
    }

    const publishedAt = new Date();
    const rows = await tx
      .update(exams)
      .set({ status: 'published', publishedAt })
      .where(
        and(
          eq(exams.tenantId, ctx.tenantId ?? ''),
          eq(exams.id, id),
          isNull(exams.deletedAt),
          eq(exams.status, before.status),
        ),
      )
      .returning();
    const row = rows[0];
    if (!row) {
      throw new HttpError('Exam status changed concurrently; reload and retry', {
        status: 409,
        code: 'exam_status_conflict',
      });
    }

    // Cards computed during grading ride out with the exam. A card that does not
    // exist yet is the worker's job (see the queued compute command below).
    //
    // A published card must agree with its own frozen subject lines, and the
    // aggregate is the database's to derive, so each draft's totals are refreshed
    // from `fn_report_card_totals` immediately before it is frozen. That makes the
    // freeze safe for a card written before the snapshot existed, and it is a no-op
    // for one the worker wrote through the same function. A draft with no lines
    // publishes as an empty card (no total, no GPA, zero subjects) rather than
    // carrying numbers that describe nothing.
    await tx.execute(
      sql`update report_cards rc
             set gpa = t.gpa, total_obtained = t.total_obtained,
                 total_possible = t.total_possible, subject_count = t.subject_count
            from (
              select d.id, f.gpa, f.total_obtained, f.total_possible, f.subject_count
                from report_cards d,
                     lateral fn_report_card_totals(${ctx.tenantId}::uuid, d.id) as f
               where d.tenant_id = ${ctx.tenantId}::uuid
                 and d.exam_id = ${id}::uuid
                 and d.status = 'draft'
                 and d.deleted_at is null
            ) t
           where t.id = rc.id`,
    );
    const published = await tx
      .update(reportCards)
      .set({ status: 'published', publishedAt })
      .where(
        and(
          eq(reportCards.tenantId, ctx.tenantId ?? ''),
          eq(reportCards.examId, id),
          eq(reportCards.status, 'draft'),
          isNull(reportCards.deletedAt),
        ),
      )
      .returning({ id: reportCards.id });

    await writeAudit(tx, {
      scope: 'tenant',
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action: 'exam.result.published',
      resourceType: 'exam',
      resourceId: row.id,
      oldValue: { status: before.status, publishedAt: null },
      newValue: {
        status: row.status,
        publishedAt: publishedAt.toISOString(),
        subjects: subjects.length,
        reportCards: published.length,
      },
      requestId,
    });

    await enqueueOutbox(tx, {
      tenantId: ctx.tenantId,
      eventType: 'exam.result.compute',
      aggregateType: 'exam',
      aggregateId: row.id,
      payload: {
        tenantId: ctx.tenantId,
        examId: row.id,
        actorUserId: ctx.userId,
      },
      correlationId: requestId,
    });
    await enqueueOutbox(tx, {
      tenantId: ctx.tenantId,
      eventType: 'exam.published',
      aggregateType: 'exam',
      aggregateId: row.id,
      payload: { tenantId: ctx.tenantId, examId: row.id, actorUserId: ctx.userId },
      correlationId: requestId,
    });

    return { exam: toExam(row), publishedReportCards: published.length };
  } catch (err) {
    throw mapDomainError(err);
  }
}

// ------------------------------------------------------------------ exam subjects

export async function createExamSubject(
  tx: Tx,
  ctx: Ctx,
  input: CreateExamSubjectRequest,
  requestId: string,
): Promise<ExamSubject> {
  try {
    const exam = await loadExam(tx, ctx, input.examId);
    // The class/year/subject copies are DERIVED from the class subject row; a
    // client cannot attach an exam subject to a class of another year.
    const cs = await tx
      .select({
        id: classSubjects.id,
        academicYearId: classSubjects.academicYearId,
        classId: classSubjects.classId,
        subjectId: classSubjects.subjectId,
      })
      .from(classSubjects)
      .where(
        and(
          eq(classSubjects.tenantId, ctx.tenantId ?? ''),
          eq(classSubjects.id, input.classSubjectId),
          isNull(classSubjects.deletedAt),
        ),
      )
      .limit(1)
      .execute()
      .then((r) => r[0]);
    if (!cs) throw notFoundError('Class subject not found');

    const rows = await tx
      .insert(examSubjects)
      .values({
        tenantId: ctx.tenantId ?? '',
        examId: exam.id,
        classSubjectId: cs.id,
        academicYearId: cs.academicYearId,
        classId: cs.classId,
        subjectId: cs.subjectId,
        maxMarks: String(input.maxMarks),
        weight: String(input.weight),
      })
      .returning();
    const row = rows[0]!;
    await writeAudit(tx, {
      scope: 'tenant',
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action: 'exam.subject.created',
      resourceType: 'exam_subject',
      resourceId: row.id,
      newValue: {
        examId: row.examId,
        classSubjectId: row.classSubjectId,
        maxMarks: Number(row.maxMarks),
        weight: Number(row.weight),
      },
      requestId,
    });
    return toExamSubject(row);
  } catch (err) {
    throw mapDomainError(err);
  }
}

export async function updateExamSubject(
  tx: Tx,
  ctx: Ctx,
  id: string,
  input: UpdateExamSubjectRequest,
  requestId: string,
): Promise<ExamSubject | null> {
  try {
    const before = await loadExamSubject(tx, ctx, id);
    const set: Partial<ExamSubjectRow> = {};
    if (input.maxMarks !== undefined) set.maxMarks = String(input.maxMarks);
    if (input.weight !== undefined) set.weight = String(input.weight);
    if (Object.keys(set).length === 0) return toExamSubject(before);
    const rows = await tx
      .update(examSubjects)
      .set(set)
      .where(
        and(
          eq(examSubjects.tenantId, ctx.tenantId ?? ''),
          eq(examSubjects.id, id),
          isNull(examSubjects.deletedAt),
        ),
      )
      .returning();
    const row = rows[0];
    if (!row) return null;
    await writeAudit(tx, {
      scope: 'tenant',
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action: 'exam.subject.updated',
      resourceType: 'exam_subject',
      resourceId: row.id,
      oldValue: { maxMarks: Number(before.maxMarks), weight: Number(before.weight) },
      newValue: { maxMarks: Number(row.maxMarks), weight: Number(row.weight) },
      requestId,
    });
    return toExamSubject(row);
  } catch (err) {
    throw mapDomainError(err);
  }
}

// ------------------------------------------------------------------ exam schedules

export async function createExamSchedule(
  tx: Tx,
  ctx: Ctx,
  input: CreateExamScheduleRequest,
  requestId: string,
): Promise<ExamSchedule> {
  try {
    const es = await loadExamSubject(tx, ctx, input.examSubjectId);
    const rows = await tx
      .insert(examSchedules)
      .values({
        tenantId: ctx.tenantId ?? '',
        examSubjectId: es.id,
        startsAt: new Date(input.startsAt),
        endsAt: new Date(input.endsAt),
        room: input.room ?? null,
      })
      .returning();
    const row = rows[0]!;
    await writeAudit(tx, {
      scope: 'tenant',
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action: 'exam.schedule.created',
      resourceType: 'exam_schedule',
      resourceId: row.id,
      newValue: {
        examSubjectId: row.examSubjectId,
        startsAt: row.startsAt.toISOString(),
        endsAt: row.endsAt.toISOString(),
        room: row.room,
      },
      requestId,
    });
    return toExamSchedule(row);
  } catch (err) {
    throw mapDomainError(err);
  }
}

export async function updateExamSchedule(
  tx: Tx,
  ctx: Ctx,
  id: string,
  input: UpdateExamScheduleRequest,
  requestId: string,
): Promise<ExamSchedule | null> {
  try {
    const before = await tx
      .select()
      .from(examSchedules)
      .where(
        and(eq(examSchedules.tenantId, ctx.tenantId ?? ''), eq(examSchedules.id, id), isNull(examSchedules.deletedAt)),
      )
      .limit(1)
      .execute()
      .then((r) => r[0]);
    if (!before) return null;
    const set: Partial<ExamScheduleRow> = {};
    if (input.startsAt !== undefined) set.startsAt = new Date(input.startsAt);
    if (input.endsAt !== undefined) set.endsAt = new Date(input.endsAt);
    if (input.room !== undefined) set.room = input.room;
    if (Object.keys(set).length === 0) return toExamSchedule(before);
    const rows = await tx
      .update(examSchedules)
      .set(set)
      .where(
        and(eq(examSchedules.tenantId, ctx.tenantId ?? ''), eq(examSchedules.id, id), isNull(examSchedules.deletedAt)),
      )
      .returning();
    const row = rows[0];
    if (!row) return null;
    await writeAudit(tx, {
      scope: 'tenant',
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action: 'exam.schedule.updated',
      resourceType: 'exam_schedule',
      resourceId: row.id,
      oldValue: { startsAt: before.startsAt.toISOString(), endsAt: before.endsAt.toISOString(), room: before.room },
      newValue: { startsAt: row.startsAt.toISOString(), endsAt: row.endsAt.toISOString(), room: row.room },
      requestId,
    });
    return toExamSchedule(row);
  } catch (err) {
    throw mapDomainError(err);
  }
}

// ------------------------------------------------------------------ gradebook

/**
 * The gradebook grid for one exam subject: every actively enrolled student of the
 * class subject's class, with whatever mark exists (a missing mark is a `null`
 * row, never an absent row, so the grid is stable before marking starts).
 * `canMark` is the caller's own-subject verdict, so the UI never offers a save
 * the API would refuse.
 */
export async function loadGradebook(
  tx: Tx,
  ctx: Ctx,
  examSubjectId: string,
): Promise<GradebookResponse> {
  const es = await loadExamSubject(tx, ctx, examSubjectId);
  const exam = await loadExam(tx, ctx, es.examId);

  const meta = await tx
    .select({
      subjectName: subjects.name,
      className: acdClasses.name,
    })
    .from(subjects)
    .innerJoin(acdClasses, and(eq(acdClasses.tenantId, es.tenantId), eq(acdClasses.id, es.classId)))
    .where(and(eq(subjects.tenantId, es.tenantId), eq(subjects.id, es.subjectId)))
    .limit(1)
    .execute()
    .then((r) => r[0]);
  if (!meta) throw notFoundError('Exam subject configuration not found');

  const sectionRow = await tx
    .select({ id: sections.id, code: sections.code })
    .from(enrollments)
    .innerJoin(sections, and(eq(sections.tenantId, enrollments.tenantId), eq(sections.id, enrollments.sectionId)))
    .where(
      and(
        eq(enrollments.tenantId, es.tenantId),
        eq(enrollments.classId, es.classId),
        isNull(enrollments.deletedAt),
        isNull(sections.deletedAt),
      ),
    )
    .limit(1)
    .execute()
    .then((r) => r[0]);

  const roster = await tx
    .select({
      enrollmentId: enrollments.id,
      studentId: enrollments.studentId,
      rollNo: enrollments.rollNo,
      sectionId: enrollments.sectionId,
      firstName: students.firstName,
      lastName: students.lastName,
    })
    .from(enrollments)
    .innerJoin(
      students,
      and(eq(students.tenantId, enrollments.tenantId), eq(students.id, enrollments.studentId)),
    )
    .where(
      and(
        eq(enrollments.tenantId, es.tenantId),
        eq(enrollments.classId, es.classId),
        eq(enrollments.academicYearId, es.academicYearId),
        eq(enrollments.status, 'active'),
        isNull(enrollments.deletedAt),
        isNull(students.deletedAt),
      ),
    )
    .orderBy(asc(enrollments.rollNo), asc(students.lastName), asc(students.firstName))
    .execute();

  const existing = await tx
    .select()
    .from(marks)
    .where(
      and(
        eq(marks.tenantId, es.tenantId),
        eq(marks.examSubjectId, es.id),
        isNull(marks.deletedAt),
      ),
    )
    .execute();
  const byEnrollment = new Map(existing.map((m) => [m.enrollmentId, m]));

  const canMark = await teacherOwnsExamSubject(tx, ctx, es);

  return {
    exam: toExam(exam),
    examSubject: toExamSubject(es),
    subjectName: meta.subjectName,
    className: meta.className,
    sectionName: sectionRow?.code ?? null,
    maxMarks: Number(es.maxMarks),
    canMark,
    locked: exam.status === 'published',
    rows: roster.map((r) => {
      const mark = byEnrollment.get(r.enrollmentId);
      return {
        enrollmentId: r.enrollmentId,
        studentId: r.studentId,
        rollNo: r.rollNo,
        studentName: `${r.firstName} ${r.lastName}`,
        sectionId: r.sectionId,
        marksObtained: mark ? num(mark.marksObtained) : null,
        percentage: mark ? num(mark.percentage) : null,
        gradeLabel: mark?.gradeLabel ?? null,
        gradePoint: mark ? num(mark.gradePoint) : null,
        status: (mark?.status ?? 'provisional') as Mark['status'],
      };
    }),
  };
}

async function teacherOwnsExamSubject(tx: Tx, ctx: Ctx, es: ExamSubjectRow): Promise<boolean> {
  const owns = await tx
    .select({ id: teacherAssignments.id })
    .from(teacherAssignments)
    .where(
      and(
        eq(teacherAssignments.tenantId, es.tenantId),
        eq(teacherAssignments.classId, es.classId),
        eq(teacherAssignments.subjectId, es.subjectId),
        eq(teacherAssignments.teacherUserId, ctx.userId),
        isNull(teacherAssignments.deletedAt),
      ),
    )
    .limit(1)
    .execute();
  return owns.length > 0;
}

// ------------------------------------------------------------------ mark entry

/**
 * Bulk mark entry for one exam subject. The client posts `{enrollmentId,
 * marksObtained}` pairs and NOTHING else: the student, section and year copies are
 * derived from the enrollment, `enteredBy` is the session user, and
 * percentage/grade/status are derived by the trigger. Re-posting the same pair is
 * an UPSERT on unique(exam_subject, enrollment), so a teacher re-saving a grid is
 * idempotent rather than a duplicate-key error.
 */
export async function enterMarks(
  tx: Tx,
  ctx: Ctx,
  input: EnterMarksRequest,
  requestId: string,
): Promise<MarkEntryResponse> {
  try {
    const es = await assertTeacherOwnsExamSubject(tx, ctx, input.examSubjectId);
    const exam = await loadExam(tx, ctx, es.examId);

    const seen = new Set<string>();
    for (const entry of input.entries) {
      if (seen.has(entry.enrollmentId)) {
        throw new HttpError('Duplicate enrollment in mark entry', {
          status: 400,
          code: 'duplicate_enrollment',
        });
      }
      seen.add(entry.enrollmentId);
    }

    const enrollmentsIn = await tx
      .select({
        id: enrollments.id,
        studentId: enrollments.studentId,
        sectionId: enrollments.sectionId,
        academicYearId: enrollments.academicYearId,
      })
      .from(enrollments)
      .where(
        and(
          eq(enrollments.tenantId, es.tenantId),
          eq(enrollments.classId, es.classId),
          eq(enrollments.academicYearId, es.academicYearId),
          eq(enrollments.status, 'active'),
          isNull(enrollments.deletedAt),
          inArray(
            enrollments.id,
            input.entries.map((e) => e.enrollmentId),
          ),
        ),
      )
      .execute();
    const enrollmentById = new Map(enrollmentsIn.map((e) => [e.id, e]));
    const missing = input.entries.filter((e) => !enrollmentById.has(e.enrollmentId));
    if (missing.length) {
      throw new HttpError('One or more students are not actively enrolled in this class', {
        status: 409,
        code: 'enrollment_not_in_class',
      });
    }

    const before = await tx
      .select({ enrollmentId: marks.enrollmentId })
      .from(marks)
      .where(
        and(
          eq(marks.tenantId, es.tenantId),
          eq(marks.examSubjectId, es.id),
          isNull(marks.deletedAt),
          inArray(
            marks.enrollmentId,
            input.entries.map((e) => e.enrollmentId),
          ),
        ),
      )
      .execute();
    const existingCount = before.length;

    const rows = await tx
      .insert(marks)
      .values(
        input.entries.map((entry) => {
          const enrollment = enrollmentById.get(entry.enrollmentId)!;
          return {
            tenantId: es.tenantId,
            examSubjectId: es.id,
            enrollmentId: enrollment.id,
            studentId: enrollment.studentId,
            sectionId: enrollment.sectionId,
            academicYearId: enrollment.academicYearId,
            marksObtained: entry.marksObtained === null ? null : String(entry.marksObtained),
            // The acting teacher is the session user — never a client field.
            enteredBy: ctx.userId,
            status: 'provisional',
          };
        }),
      )
      .onConflictDoUpdate({
        target: [marks.tenantId, marks.examSubjectId, marks.enrollmentId],
        set: {
          marksObtained: sqlCase(input.entries),
          enteredBy: ctx.userId,
        },
      })
      .returning();

    await writeAudit(tx, {
      scope: 'tenant',
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action: 'exam.marks_entered',
      resourceType: 'exam_subject',
      resourceId: es.id,
      newValue: {
        examId: exam.id,
        entered: input.entries.length,
        inserted: input.entries.length - existingCount,
        updated: existingCount,
      },
      requestId,
    });

    return {
      marks: rows.map(toMark),
      entered: input.entries.length,
      inserted: input.entries.length - existingCount,
      updated: existingCount,
    };
  } catch (err) {
    throw mapDomainError(err);
  }
}

/**
 * The upsert's SET clause cannot reference the excluded row per-entry, so the new
 * value is rebuilt from the request: a CASE over the posted enrollment ids. A value
 * that is not part of this request keeps its current column untouched by falling
 * through to `marks.marks_obtained`.
 */
function sqlCase(entries: readonly { enrollmentId: string; marksObtained: number | null }[]) {
  const cases = entries.map((entry) =>
    entry.marksObtained === null
      ? sql`when ${marks.enrollmentId} = ${entry.enrollmentId} then null`
      : sql`when ${marks.enrollmentId} = ${entry.enrollmentId} then ${entry.marksObtained}`,
  );
  return sql`case ${sql.join(cases, sql` `)} else ${marks.marksObtained} end`;
}

// ------------------------------------------------------------------ corrections

/**
 * Correction workflow. A published (or locked) mark can only move through here:
 * the append-only `mark_corrections` row is inserted FIRST — carrying the old
 * value, the new value, the reason and the session user — and the mark is then
 * updated in the SAME transaction. The marks trigger looks for that row, so a
 * direct UPDATE without a correction is impossible even if this service is
 * bypassed. The corrected mark becomes `rechecked`; the derived grade is
 * recomputed by the trigger.
 */
export async function correctMark(
  tx: Tx,
  ctx: Ctx,
  markId: string,
  input: CorrectMarkRequest,
  requestId: string,
): Promise<{ mark: Mark; correction: MarkCorrection }> {
  try {
    const before = await tx
      .select()
      .from(marks)
      .where(and(eq(marks.tenantId, ctx.tenantId ?? ''), eq(marks.id, markId), isNull(marks.deletedAt)))
      .limit(1)
      .execute()
      .then((r) => r[0]);
    if (!before) throw notFoundError('Mark not found');
    if (before.status === 'provisional') {
      throw new HttpError('A provisional mark is edited through mark entry, not the correction workflow', {
        status: 409,
        code: 'mark_not_published',
      });
    }
    if (num(before.marksObtained) === input.marksObtained) {
      throw new HttpError('A correction must change the mark', {
        status: 409,
        code: 'mark_unchanged',
      });
    }

    const es = await loadExamSubject(tx, ctx, before.examSubjectId);
    const exam = await loadExam(tx, ctx, es.examId);

    const correctionRows = await tx
      .insert(markCorrections)
      .values({
        tenantId: ctx.tenantId ?? '',
        markId: before.id,
        examId: exam.id,
        examSubjectId: es.id,
        studentId: before.studentId,
        oldMarksObtained: before.marksObtained,
        newMarksObtained: String(input.marksObtained),
        reason: input.reason,
        // The correcting principal is the session user.
        correctedBy: ctx.userId,
      })
      .returning();
    const correction = correctionRows[0]!;

    const updated = await tx
      .update(marks)
      .set({ marksObtained: String(input.marksObtained) })
      .where(
        and(
          eq(marks.tenantId, ctx.tenantId ?? ''),
          eq(marks.id, before.id),
          eq(marks.status, before.status),
          // The score itself must be part of the compare-and-swap, not just the
          // status. A repeated correction leaves the status at `rechecked`, so a
          // status-only guard would let two concurrent corrections both succeed:
          // the second would overwrite the first's value while both ledger rows
          // recorded the same `old_marks_obtained` (F-02).
          sql`${marks.marksObtained} = ${before.marksObtained}::numeric`,
        ),
      )
      .returning();
    const mark = updated[0];
    if (!mark) {
      throw new HttpError('The mark changed concurrently; reload and retry', {
        status: 409,
        code: 'mark_conflict',
      });
    }

    await writeAudit(tx, {
      scope: 'tenant',
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action: 'exam.mark_corrected',
      resourceType: 'mark',
      resourceId: mark.id,
      oldValue: { marksObtained: num(before.marksObtained), status: before.status },
      // The reason lives in mark_corrections (the append-only ledger); the audit
      // records that a correction happened, not its narrative.
      newValue: { marksObtained: input.marksObtained, status: mark.status, correctionId: correction.id },
      requestId,
    });
    await enqueueOutbox(tx, {
      tenantId: ctx.tenantId,
      eventType: 'result.corrected',
      aggregateType: 'mark',
      aggregateId: mark.id,
      payload: {
        tenantId: ctx.tenantId,
        examId: exam.id,
        markId: mark.id,
        studentId: mark.studentId,
        correctionId: correction.id,
        actorUserId: ctx.userId,
      },
      correlationId: requestId,
    });
    // The recomputation REQUEST, in the SAME transaction as the ledger row and the
    // mark UPDATE. Without it a published correction left the card stale: the
    // mark moved but the aggregate, the per-subject lines and the PDF kept the
    // pre-correction numbers, because `result.corrected` is a fact about the
    // correction and had no handler that recomputes (F-02).
    //
    // `exam.result.compute` is the existing machinery, reused verbatim rather than
    // re-implemented here: the worker mints version + 1 for the affected student
    // and leaves every other student converged, and it re-derives the PDF job for
    // the new version. Because the enqueue is inside `tx`, a correction can never
    // commit without the request that makes the published card catch up.
    await enqueueOutbox(tx, {
      tenantId: ctx.tenantId,
      eventType: 'exam.result.compute',
      aggregateType: 'exam',
      aggregateId: exam.id,
      payload: {
        tenantId: ctx.tenantId,
        examId: exam.id,
        actorUserId: ctx.userId,
        // Context only: the worker re-reads the marks, it never trusts the payload.
        reason: 'mark_corrected',
        correctionId: correction.id,
        markId: mark.id,
      },
      correlationId: requestId,
    });

    return { mark: toMark(mark), correction: toMarkCorrection(correction) };
  } catch (err) {
    throw mapDomainError(err);
  }
}

// ------------------------------------------------------------------ report cards & transcript

interface TranscriptSource {
  reportCard: ReportCardRow;
  exam: ExamRow;
  termName: string;
  academicYearName: string;
  studentFirstName: string;
  studentLastName: string;
  className: string;
}

function toTranscriptEntry(source: TranscriptSource): TranscriptEntry {
  return {
    examId: source.exam.id,
    examName: source.exam.name,
    termName: source.termName,
    academicYearName: source.academicYearName,
    publishedAt: source.exam.publishedAt ? source.exam.publishedAt.toISOString() : null,
    gpa: num(source.reportCard.gpa),
    totalObtained: num(source.reportCard.totalObtained),
    totalPossible: Number(source.reportCard.totalPossible),
    subjectCount: source.reportCard.subjectCount,
  };
}

/** The latest report-card version per (exam, student) — the transcript axis. */
const LATEST_VERSION = sql`(
  select max(rc2.version) from report_cards rc2
   where rc2.tenant_id = ${reportCards.tenantId}
     and rc2.exam_id = ${reportCards.examId}
     and rc2.student_id = ${reportCards.studentId}
     and rc2.deleted_at is null
     and rc2.status = 'published'
)`;

async function loadPublishedCards(
  tx: Tx,
  ctx: Ctx,
  studentIds: readonly string[] | null,
): Promise<TranscriptSource[]> {
  const conditions = [
    eq(reportCards.tenantId, ctx.tenantId ?? ''),
    eq(reportCards.status, 'published'),
    isNull(reportCards.deletedAt),
    sql`${reportCards.version} = ${LATEST_VERSION}`,
  ];
  if (studentIds !== null) {
    if (studentIds.length === 0) return [];
    conditions.push(inArray(reportCards.studentId, studentIds as string[]));
  }
  return tx
    .select({
      reportCard: reportCards,
      exam: exams,
      termName: academicTerms.name,
      academicYearName: academicYears.name,
      studentFirstName: students.firstName,
      studentLastName: students.lastName,
      className: acdClasses.name,
    })
    .from(reportCards)
    .innerJoin(exams, and(eq(exams.tenantId, reportCards.tenantId), eq(exams.id, reportCards.examId)))
    .innerJoin(academicTerms, and(eq(academicTerms.tenantId, exams.tenantId), eq(academicTerms.id, exams.academicTermId)))
    .innerJoin(academicYears, and(eq(academicYears.tenantId, reportCards.tenantId), eq(academicYears.id, reportCards.academicYearId)))
    .innerJoin(students, and(eq(students.tenantId, reportCards.tenantId), eq(students.id, reportCards.studentId)))
    .innerJoin(
      enrollments,
      and(
        eq(enrollments.tenantId, reportCards.tenantId),
        eq(enrollments.id, reportCards.enrollmentId),
      ),
    )
    .innerJoin(acdClasses, and(eq(acdClasses.tenantId, enrollments.tenantId), eq(acdClasses.id, enrollments.classId)))
    .where(and(...conditions))
    .orderBy(desc(exams.publishedAt), desc(reportCards.id))
    .execute();
}

/**
 * Per-subject lines of one report card, in the order the exam defined them.
 *
 * Read from `report_card_subjects` - the card's own FROZEN snapshot - and never from
 * `marks`. This used to re-read the detail from live marks, so the body of an
 * already-published card moved under its reader the moment a mark was corrected:
 * the totals stayed frozen while the lines beside them showed the new marks, and one
 * document came to describe two different results. It also used to scope the lines to
 * the card's exam with a predicate bolted onto that live join (F-01); the snapshot is
 * scoped to the card by construction, and the database refuses a line that names a
 * sibling exam's subject, so the predicate is now a property of the data rather than
 * a condition this query has to remember.
 */
async function loadSubjectLines(
  tx: Tx,
  ctx: Ctx,
  reportCard: ReportCardRow,
): Promise<ReportCardDetail['subjects']> {
  const rows = await tx
    .select({
      subjectName: reportCardSubjects.subjectName,
      maxMarks: reportCardSubjects.maxMarks,
      weight: reportCardSubjects.weight,
      marksObtained: reportCardSubjects.marksObtained,
      percentage: reportCardSubjects.percentage,
      gradeLabel: reportCardSubjects.gradeLabel,
      gradePoint: reportCardSubjects.gradePoint,
    })
    .from(reportCardSubjects)
    .where(
      and(
        eq(reportCardSubjects.tenantId, ctx.tenantId ?? ''),
        eq(reportCardSubjects.reportCardId, reportCard.id),
      ),
    )
    .orderBy(asc(reportCardSubjects.subjectName))
    .execute();
  return rows.map((r) => ({
    subjectName: r.subjectName,
    marksObtained: num(r.marksObtained),
    maxMarks: Number(r.maxMarks),
    percentage: num(r.percentage),
    gradeLabel: r.gradeLabel,
    gradePoint: num(r.gradePoint),
    weight: Number(r.weight),
  }));
}

async function toReportCardDetail(
  tx: Tx,
  ctx: Ctx,
  source: TranscriptSource,
): Promise<ReportCardDetail> {
  return {
    ...toReportCard(source.reportCard),
    exam: toExam(source.exam),
    studentName: `${source.studentFirstName} ${source.studentLastName}`,
    className: source.className,
    termName: source.termName,
    subjects: await loadSubjectLines(tx, ctx, source.reportCard),
  };
}

export async function loadTranscript(
  tx: Tx,
  ctx: Ctx,
  studentId: string,
): Promise<{ studentId: string; studentName: string; entries: TranscriptEntry[] }> {
  const student = await tx
    .select({ id: students.id, firstName: students.firstName, lastName: students.lastName })
    .from(students)
    .where(and(eq(students.tenantId, ctx.tenantId ?? ''), eq(students.id, studentId), isNull(students.deletedAt)))
    .limit(1)
    .execute()
    .then((r) => r[0]);
  if (!student) throw notFoundError('Student not found');

  const cards = await loadPublishedCards(tx, ctx, [studentId]);
  return {
    studentId: student.id,
    studentName: `${student.firstName} ${student.lastName}`,
    entries: cards.map(toTranscriptEntry),
  };
}

/**
 * Self-scoped results portal read. The students come from the caller's OWN
 * relationship (linked children for a parent, self for a student) and only
 * PUBLISHED report cards are ever loaded, so the payload cannot contain a
 * provisional result no matter what the client asks for.
 *
 * The response is the published `ResultsPortalResponse` envelope: a `context`
 * describing who the caller is and which students they may read, plus one
 * `views` entry per resolved student. A parent/student with a handful of
 * linked children gets every panel at once; school-wide staff (whose readable
 * set is unbounded) and large rosters must name the student instead, so the
 * payload can never grow with the size of the school.
 */
const MAX_UNNAMED_VIEWS = 25;

export async function resolveResultsPortal(
  tx: Tx,
  ctx: Ctx,
  query: { studentId?: string },
): Promise<ResultsPortalResponse> {
  const codes = await tenantRoleCodes(tx, ctx);
  const vis = resultsVisibility(codes);
  if (vis === 'none') {
    throw new HttpError('Results are not available for your role', {
      status: 403,
      code: 'results_scope_denied',
    });
  }
  const allowed = await readableResultStudentIds(tx, ctx, vis);
  const candidates = allowed === null ? null : [...allowed];

  let studentIds: readonly string[];
  if (query.studentId) {
    if (candidates !== null && !candidates.includes(query.studentId)) {
      // Relationship denial is explicit so a cross-child probe is distinguishable
      // from an empty result set.
      throw new HttpError('You may only view results for students linked to you', {
        status: 403,
        code: 'results_scope_denied',
      });
    }
    studentIds = [query.studentId];
  } else {
    if (candidates === null || candidates.length === 0) {
      throw new HttpError(
        candidates === null ? 'Name the student to view' : 'No linked student to view',
        { status: 400, code: 'results_student_required' },
      );
    }
    if (vis !== 'parent' && candidates.length > 1) {
      throw new HttpError('Name the student to view: several students are linked to you', {
        status: 400,
        code: 'results_student_required',
      });
    }
    if (candidates.length > MAX_UNNAMED_VIEWS) {
      throw new HttpError('Name the student to view: too many students are linked to you', {
        status: 400,
        code: 'results_student_required',
      });
    }
    studentIds = candidates;
  }

  const resolved = await tx
    .select({ id: students.id, studentNo: students.studentNo, firstName: students.firstName, lastName: students.lastName })
    .from(students)
    .where(
      and(
        eq(students.tenantId, ctx.tenantId ?? ''),
        inArray(students.id, [...studentIds]),
        isNull(students.deletedAt),
      ),
    )
    .execute();
  const studentById = new Map(resolved.map((s) => [s.id, s]));
  const views: ResultsPortalView[] = [];
  for (const id of studentIds) {
    const student = studentById.get(id);
    if (!student) throw notFoundError('Student not found');
    const cards = await loadPublishedCards(tx, ctx, [student.id]);
    views.push({
      student: {
        id: student.id,
        studentNo: student.studentNo,
        firstName: student.firstName,
        lastName: student.lastName,
      },
      entries: cards.map(toTranscriptEntry),
      reportCards: await Promise.all(cards.map((c) => toReportCardDetail(tx, ctx, c))),
    });
  }

  return {
    context: {
      // `attendanceContextRoleSchema` is the published vocabulary and the
      // visibility levels map onto it one-to-one (minus 'none', handled above).
      role: vis === 'all' ? 'staff' : vis,
      students: views.map((v) => v.student),
    },
    views,
  };
}

// ------------------------------------------------------------------ routes

export default async function examRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------- exam types
  app.get(
    '/api/v1/exam-types',
    {
      config: { authorization: { kind: 'tenant', permission: 'exams.read' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('exams.read')],
    },
    async (request) => {
      const ctx = request.ctx!;
      const rows = await withTenant(app.db, ctx, (tx) =>
        tx
          .select()
          .from(examTypes)
          .where(and(eq(examTypes.tenantId, ctx.tenantId ?? ''), isNull(examTypes.deletedAt)))
          .orderBy(asc(examTypes.code))
          .execute(),
      );
      return { items: rows.map(toExamType), total: rows.length };
    },
  );

  app.post(
    '/api/v1/exam-types',
    {
      config: { authorization: { kind: 'tenant', permission: 'exams.manage' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('exams.manage'), requireCsrf()],
    },
    async (request, reply) => {
      const ctx = request.ctx!;
      const body = createExamTypeRequestSchema.parse(request.body);
      const idemKey = idempotencyKeyFromHeader(request.headers);
      const fingerprint = requestFingerprint(request.method, request.url, body);
      const outcome = await withTenant(app.db, ctx, (tx) =>
        withIdempotency(tx, { tenantId: ctx.tenantId, key: idemKey }, fingerprint, async () => {
          const row = await createExamType(tx, ctx, body, request.requestId);
          return { status: 201, body: { examType: row } };
        }),
      );
      return reply.code(outcome.status).send(outcome.body);
    },
  );

  app.patch(
    '/api/v1/exam-types/:id',
    {
      config: { authorization: { kind: 'tenant', permission: 'exams.manage' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('exams.manage'), requireCsrf()],
    },
    async (request, reply) => {
      const ctx = request.ctx!;
      const { id } = request.params as { id: string };
      const body = updateExamTypeRequestSchema.parse(request.body);
      const idemKey = idempotencyKeyFromHeader(request.headers);
      const fingerprint = requestFingerprint(request.method, request.url, body);
      const outcome = await withTenant(app.db, ctx, (tx) =>
        withIdempotency(tx, { tenantId: ctx.tenantId, key: idemKey }, fingerprint, async () => {
          const row = await updateExamType(tx, ctx, id, body, request.requestId);
          if (!row) throw notFoundError('Exam type not found');
          return { status: 200, body: { examType: row } };
        }),
      );
      return reply.code(outcome.status).send(outcome.body);
    },
  );

  // ---------------------------------------------------------------- grading scales
  app.get(
    '/api/v1/grading-scales',
    {
      config: { authorization: { kind: 'tenant', permission: 'exams.read' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('exams.read')],
    },
    async (request) => {
      const ctx = request.ctx!;
      const rows = await withTenant(app.db, ctx, (tx) =>
        tx
          .select()
          .from(gradingScales)
          .where(and(eq(gradingScales.tenantId, ctx.tenantId ?? ''), isNull(gradingScales.deletedAt)))
          .orderBy(asc(gradingScales.code), desc(gradingScales.version))
          .execute(),
      );
      return { items: rows.map(toGradingScale), total: rows.length };
    },
  );

  app.post(
    '/api/v1/grading-scales',
    {
      config: { authorization: { kind: 'tenant', permission: 'exams.manage' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('exams.manage'), requireCsrf()],
    },
    async (request, reply) => {
      const ctx = request.ctx!;
      const body = createGradingScaleRequestSchema.parse(request.body);
      const idemKey = idempotencyKeyFromHeader(request.headers);
      const fingerprint = requestFingerprint(request.method, request.url, body);
      const outcome = await withTenant(app.db, ctx, (tx) =>
        withIdempotency(tx, { tenantId: ctx.tenantId, key: idemKey }, fingerprint, async () => {
          const row = await createGradingScale(tx, ctx, body, request.requestId);
          return { status: 201, body: { gradingScale: row } };
        }),
      );
      return reply.code(outcome.status).send(outcome.body);
    },
  );

  app.patch(
    '/api/v1/grading-scales/:id',
    {
      config: { authorization: { kind: 'tenant', permission: 'exams.manage' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('exams.manage'), requireCsrf()],
    },
    async (request, reply) => {
      const ctx = request.ctx!;
      const { id } = request.params as { id: string };
      const body = updateGradingScaleRequestSchema.parse(request.body);
      const idemKey = idempotencyKeyFromHeader(request.headers);
      const fingerprint = requestFingerprint(request.method, request.url, body);
      const outcome = await withTenant(app.db, ctx, (tx) =>
        withIdempotency(tx, { tenantId: ctx.tenantId, key: idemKey }, fingerprint, async () => {
          const row = await updateGradingScale(tx, ctx, id, body, request.requestId);
          if (!row) throw notFoundError('Grading scale not found');
          return { status: 200, body: { gradingScale: row } };
        }),
      );
      return reply.code(outcome.status).send(outcome.body);
    },
  );

  // ---------------------------------------------------------------- exams
  app.get(
    '/api/v1/exams',
    {
      config: { authorization: { kind: 'tenant', permission: 'exams.read' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('exams.read')],
    },
    async (request) => {
      const ctx = request.ctx!;
      const query: ExamListQuery = examListQuerySchema.parse(request.query);
      const conditions = [eq(exams.tenantId, ctx.tenantId ?? ''), isNull(exams.deletedAt)];
      if (query.academicYearId) conditions.push(eq(exams.academicYearId, query.academicYearId));
      if (query.academicTermId) conditions.push(eq(exams.academicTermId, query.academicTermId));
      if (query.status) conditions.push(eq(exams.status, query.status));
      if (query.campusId) conditions.push(eq(exams.campusId, query.campusId));
      // A campus-scoped membership never sees another campus's exams.
      if (ctx.campusId) conditions.push(eq(exams.campusId, ctx.campusId));
      // A family only ever sees exams the school has released.
      const vis = await withTenant(app.db, ctx, async (tx) =>
        resultsVisibility(await tenantRoleCodes(tx, ctx)),
      );
      if (!isStaff(vis)) {
        conditions.push(eq(exams.status, 'published'));
        // A status filter would otherwise be an oracle for unpublished exams.
        if (query.status && query.status !== 'published') return { items: [], total: 0 };
      }

      const rows = await withTenant(app.db, ctx, (tx) =>
        tx
          .select()
          .from(exams)
          .where(and(...conditions))
          .orderBy(desc(exams.createdAt), desc(exams.id))
          .limit(query.limit)
          .offset(query.offset)
          .execute(),
      );
      const totalRow = await withTenant(app.db, ctx, (tx) =>
        tx.select({ total: count() }).from(exams).where(and(...conditions)).execute(),
      );
      return { items: rows.map(toExam), total: totalRow[0]?.total ?? 0 };
    },
  );

  app.post(
    '/api/v1/exams',
    {
      config: { authorization: { kind: 'tenant', permission: 'exams.manage' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('exams.manage'), requireCsrf()],
    },
    async (request, reply) => {
      const ctx = request.ctx!;
      const body = createExamRequestSchema.parse(request.body);
      const idemKey = idempotencyKeyFromHeader(request.headers);
      const fingerprint = requestFingerprint(request.method, request.url, body);
      const outcome = await withTenant(app.db, ctx, (tx) =>
        withIdempotency(tx, { tenantId: ctx.tenantId, key: idemKey }, fingerprint, async () => {
          const row = await createExam(tx, ctx, body, request.requestId);
          return { status: 201, body: { exam: row } };
        }),
      );
      return reply.code(outcome.status).send(outcome.body);
    },
  );

  app.patch(
    '/api/v1/exams/:id',
    {
      config: { authorization: { kind: 'tenant', permission: 'exams.manage' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('exams.manage'), requireCsrf()],
    },
    async (request, reply) => {
      const ctx = request.ctx!;
      const { id } = request.params as { id: string };
      const body = updateExamRequestSchema.parse(request.body);
      const idemKey = idempotencyKeyFromHeader(request.headers);
      const fingerprint = requestFingerprint(request.method, request.url, body);
      const outcome = await withTenant(app.db, ctx, (tx) =>
        withIdempotency(tx, { tenantId: ctx.tenantId, key: idemKey }, fingerprint, async () => {
          const row = await updateExam(tx, ctx, id, body, request.requestId);
          if (!row) throw notFoundError('Exam not found');
          return { status: 200, body: { exam: row } };
        }),
      );
      return reply.code(outcome.status).send(outcome.body);
    },
  );

  app.post(
    '/api/v1/exams/:id/status',
    {
      config: { authorization: { kind: 'tenant', permission: 'exams.manage' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('exams.manage'), requireCsrf()],
    },
    async (request, reply) => {
      const ctx = request.ctx!;
      const { id } = request.params as { id: string };
      const body = examStatusTransitionRequestSchema.parse(request.body);
      const idemKey = idempotencyKeyFromHeader(request.headers);
      const fingerprint = requestFingerprint(request.method, request.url, body);
      const outcome = await withTenant(app.db, ctx, (tx) =>
        withIdempotency(tx, { tenantId: ctx.tenantId, key: idemKey }, fingerprint, async () => {
          const row = await transitionExamStatus(tx, ctx, id, body, request.requestId);
          return { status: 200, body: { exam: row } };
        }),
      );
      return reply.code(outcome.status).send(outcome.body);
    },
  );

  app.post(
    '/api/v1/exams/:id/publish',
    {
      config: { authorization: { kind: 'tenant', permission: 'exams.publish' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('exams.publish'), requireCsrf()],
    },
    async (request, reply) => {
      const ctx = request.ctx!;
      const { id } = request.params as { id: string };
      const body = (request.body ?? {}) as Record<string, unknown>;
      const idemKey = idempotencyKeyFromHeader(request.headers);
      const fingerprint = requestFingerprint(request.method, request.url, body);
      const outcome = await withTenant(app.db, ctx, (tx) =>
        withIdempotency(tx, { tenantId: ctx.tenantId, key: idemKey }, fingerprint, async () => {
          const result = await publishExam(tx, ctx, id, request.requestId);
          return {
            status: 200,
            body: { exam: result.exam, publishedReportCards: result.publishedReportCards },
          };
        }),
      );
      return reply.code(outcome.status).send(outcome.body);
    },
  );

  // ---------------------------------------------------------------- exam subjects
  app.get(
    '/api/v1/exams/:id/subjects',
    {
      config: { authorization: { kind: 'tenant', permission: 'exams.read' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('exams.read')],
    },
    async (request) => {
      const ctx = request.ctx!;
      const { id } = request.params as { id: string };
      return withTenant(app.db, ctx, async (tx) => {
        // Subject configuration is released with the exam, not before it.
        const vis = resultsVisibility(await tenantRoleCodes(tx, ctx));
        assertPublishedExamForNonStaff(await loadExam(tx, ctx, id), vis);
        const rows = await tx
          .select()
          .from(examSubjects)
          .where(
            and(eq(examSubjects.tenantId, ctx.tenantId ?? ''), eq(examSubjects.examId, id), isNull(examSubjects.deletedAt)),
          )
          .orderBy(asc(examSubjects.createdAt), asc(examSubjects.id))
          .execute();
        return { items: rows.map(toExamSubject), total: rows.length };
      });
    },
  );

  app.post(
    '/api/v1/exams/:id/subjects',
    {
      config: { authorization: { kind: 'tenant', permission: 'exams.manage' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('exams.manage'), requireCsrf()],
    },
    async (request, reply) => {
      const ctx = request.ctx!;
      const { id } = request.params as { id: string };
      const parsed = createExamSubjectRequestSchema.parse(request.body);
      if (parsed.examId !== id) {
        throw new HttpError('Exam id in the body must match the path', {
          status: 400,
          code: 'exam_id_mismatch',
        });
      }
      const idemKey = idempotencyKeyFromHeader(request.headers);
      const fingerprint = requestFingerprint(request.method, request.url, parsed);
      const outcome = await withTenant(app.db, ctx, (tx) =>
        withIdempotency(tx, { tenantId: ctx.tenantId, key: idemKey }, fingerprint, async () => {
          const row = await createExamSubject(tx, ctx, parsed, request.requestId);
          return { status: 201, body: { examSubject: row } };
        }),
      );
      return reply.code(outcome.status).send(outcome.body);
    },
  );

  app.patch(
    '/api/v1/exam-subjects/:id',
    {
      config: { authorization: { kind: 'tenant', permission: 'exams.manage' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('exams.manage'), requireCsrf()],
    },
    async (request, reply) => {
      const ctx = request.ctx!;
      const { id } = request.params as { id: string };
      const body = updateExamSubjectRequestSchema.parse(request.body);
      const idemKey = idempotencyKeyFromHeader(request.headers);
      const fingerprint = requestFingerprint(request.method, request.url, body);
      const outcome = await withTenant(app.db, ctx, (tx) =>
        withIdempotency(tx, { tenantId: ctx.tenantId, key: idemKey }, fingerprint, async () => {
          const row = await updateExamSubject(tx, ctx, id, body, request.requestId);
          if (!row) throw notFoundError('Exam subject not found');
          return { status: 200, body: { examSubject: row } };
        }),
      );
      return reply.code(outcome.status).send(outcome.body);
    },
  );

  // ---------------------------------------------------------------- gradebook
  app.get(
    '/api/v1/exam-subjects/:id/gradebook',
    {
      config: { authorization: { kind: 'tenant', permission: 'exams.read' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('exams.read')],
    },
    async (request) => {
      const ctx = request.ctx!;
      const { id } = request.params as { id: string };
      return withTenant(app.db, ctx, async (tx) => {
        await assertResultsStaff(tx, ctx, id);
        return loadGradebook(tx, ctx, id);
      });
    },
  );

  // ---------------------------------------------------------------- schedules
  app.get(
    '/api/v1/exams/:id/schedules',
    {
      config: { authorization: { kind: 'tenant', permission: 'exams.read' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('exams.read')],
    },
    async (request) => {
      const ctx = request.ctx!;
      const { id } = request.params as { id: string };
      return withTenant(app.db, ctx, async (tx) => {
        // The sitting timetable is released with the exam, like the subject list.
        const vis = resultsVisibility(await tenantRoleCodes(tx, ctx));
        assertPublishedExamForNonStaff(await loadExam(tx, ctx, id), vis);
        const rows = await tx
          .select({ schedule: examSchedules })
          .from(examSchedules)
          .innerJoin(
            examSubjects,
            and(
              eq(examSubjects.tenantId, examSchedules.tenantId),
              eq(examSubjects.id, examSchedules.examSubjectId),
            ),
          )
          .where(
            and(
              eq(examSubjects.tenantId, ctx.tenantId ?? ''),
              eq(examSubjects.examId, id),
              isNull(examSubjects.deletedAt),
              isNull(examSchedules.deletedAt),
            ),
          )
          .orderBy(asc(examSchedules.startsAt))
          .execute();
        const items = rows.map((r) => toExamSchedule(r.schedule));
        return { items, total: items.length };
      });
    },
  );

  app.post(
    '/api/v1/exam-schedules',
    {
      config: { authorization: { kind: 'tenant', permission: 'exams.manage' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('exams.manage'), requireCsrf()],
    },
    async (request, reply) => {
      const ctx = request.ctx!;
      const body = createExamScheduleRequestSchema.parse(request.body);
      const idemKey = idempotencyKeyFromHeader(request.headers);
      const fingerprint = requestFingerprint(request.method, request.url, body);
      const outcome = await withTenant(app.db, ctx, (tx) =>
        withIdempotency(tx, { tenantId: ctx.tenantId, key: idemKey }, fingerprint, async () => {
          const row = await createExamSchedule(tx, ctx, body, request.requestId);
          return { status: 201, body: { examSchedule: row } };
        }),
      );
      return reply.code(outcome.status).send(outcome.body);
    },
  );

  app.patch(
    '/api/v1/exam-schedules/:id',
    {
      config: { authorization: { kind: 'tenant', permission: 'exams.manage' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('exams.manage'), requireCsrf()],
    },
    async (request, reply) => {
      const ctx = request.ctx!;
      const { id } = request.params as { id: string };
      const body = updateExamScheduleRequestSchema.parse(request.body);
      const idemKey = idempotencyKeyFromHeader(request.headers);
      const fingerprint = requestFingerprint(request.method, request.url, body);
      const outcome = await withTenant(app.db, ctx, (tx) =>
        withIdempotency(tx, { tenantId: ctx.tenantId, key: idemKey }, fingerprint, async () => {
          const row = await updateExamSchedule(tx, ctx, id, body, request.requestId);
          if (!row) throw notFoundError('Exam schedule not found');
          return { status: 200, body: { examSchedule: row } };
        }),
      );
      return reply.code(outcome.status).send(outcome.body);
    },
  );

  // ---------------------------------------------------------------- marks
  app.post(
    '/api/v1/marks',
    {
      config: { authorization: { kind: 'tenant', permission: 'exams.mark' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('exams.mark'), requireCsrf()],
    },
    async (request, reply) => {
      const ctx = request.ctx!;
      const body = enterMarksRequestSchema.parse(request.body);
      const idemKey = idempotencyKeyFromHeader(request.headers);
      const fingerprint = requestFingerprint(request.method, request.url, body);
      const outcome = await withTenant(app.db, ctx, (tx) =>
        withIdempotency(tx, { tenantId: ctx.tenantId, key: idemKey }, fingerprint, async () => {
          const result = await enterMarks(tx, ctx, body, request.requestId);
          return { status: 200, body: result };
        }),
      );
      return reply.code(outcome.status).send(outcome.body);
    },
  );

  // ---------------------------------------------------------------- corrections
  app.get(
    '/api/v1/mark-corrections',
    {
      // A correction carries the before/after mark and a free-text reason, so it
      // is gated on `exams.correct` — the same permission that appends one —
      // and never on `exams.read`, which parents and students hold.
      config: { authorization: { kind: 'tenant', permission: 'exams.correct' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('exams.correct')],
    },
    async (request) => {
      const ctx = request.ctx!;
      const { limit, offset } = parsePagination(request.query);
      return withTenant(app.db, ctx, async (tx) => {
        // A teacher may only audit the corrections on their own students, so the
        // ledger is filtered through the same relationship ladder as results.
        const codes = await tenantRoleCodes(tx, ctx);
        const vis = resultsVisibility(codes);
        const allowed = await readableResultStudentIds(tx, ctx, vis);
        if (allowed !== null && allowed.length === 0) return { items: [], total: 0 };

        const conditions = [eq(markCorrections.tenantId, ctx.tenantId ?? '')];
        if (allowed !== null) {
          const scoped = await tx
            .select({ id: markCorrections.id })
            .from(markCorrections)
            .innerJoin(
              marks,
              and(
                eq(marks.tenantId, markCorrections.tenantId),
                eq(marks.id, markCorrections.markId),
              ),
            )
            .innerJoin(
              enrollments,
              and(
                eq(enrollments.tenantId, marks.tenantId),
                eq(enrollments.id, marks.enrollmentId),
              ),
            )
            .where(
              and(
                eq(markCorrections.tenantId, ctx.tenantId ?? ''),
                inArray(enrollments.studentId, allowed as string[]),
              ),
            );
          if (scoped.length === 0) return { items: [], total: 0 };
          conditions.push(inArray(markCorrections.id, scoped.map((s) => s.id)));
        }

        const rows = await tx
          .select()
          .from(markCorrections)
          .where(and(...conditions))
          .orderBy(desc(markCorrections.createdAt), desc(markCorrections.id))
          .limit(limit)
          .offset(offset)
          .execute();
        const totalRow = await tx
          .select({ total: count() })
          .from(markCorrections)
          .where(and(...conditions))
          .execute();
        return { items: rows.map(toMarkCorrection), total: totalRow[0]?.total ?? 0 };
      });
    },
  );

  app.post(
    '/api/v1/marks/:id/corrections',
    {
      config: { authorization: { kind: 'tenant', permission: 'exams.correct' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('exams.correct'), requireCsrf()],
    },
    async (request, reply) => {
      const ctx = request.ctx!;
      const { id } = request.params as { id: string };
      const body = correctMarkRequestSchema.parse(request.body);
      const idemKey = idempotencyKeyFromHeader(request.headers);
      const fingerprint = requestFingerprint(request.method, request.url, body);
      const outcome = await withTenant(app.db, ctx, (tx) =>
        withIdempotency(tx, { tenantId: ctx.tenantId, key: idemKey }, fingerprint, async () => {
          const result = await correctMark(tx, ctx, id, body, request.requestId);
          return { status: 201, body: { mark: result.mark, correction: result.correction } };
        }),
      );
      return reply.code(outcome.status).send(outcome.body);
    },
  );

  // ---------------------------------------------------------------- report cards
  app.get(
    '/api/v1/report-cards',
    {
      config: { authorization: { kind: 'tenant', permission: 'exams.read' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('exams.read')],
    },
    async (request) => {
      const ctx = request.ctx!;
      const query = reportCardListQuerySchema.parse(request.query);
      const codes = await withTenant(app.db, ctx, (tx) => tenantRoleCodes(tx, ctx));
      const vis = resultsVisibility(codes);
      const allowed = await withTenant(app.db, ctx, (tx) => readableResultStudentIds(tx, ctx, vis));
      if (allowed !== null && allowed.length === 0) return { items: [], total: 0 };

      const conditions = [eq(reportCards.tenantId, ctx.tenantId ?? ''), isNull(reportCards.deletedAt)];
      if (allowed !== null) conditions.push(inArray(reportCards.studentId, allowed as string[]));
      // Non-staff only ever sees published results.
      if (!isStaff(vis)) conditions.push(eq(reportCards.status, 'published'));
      if (query.status && isStaff(vis)) conditions.push(eq(reportCards.status, query.status));
      if (query.examId) conditions.push(eq(reportCards.examId, query.examId));
      if (query.studentId) conditions.push(eq(reportCards.studentId, query.studentId));

      const rows = await withTenant(app.db, ctx, (tx) =>
        tx
          .select()
          .from(reportCards)
          .where(and(...conditions))
          .orderBy(desc(reportCards.createdAt), desc(reportCards.id))
          .limit(query.limit)
          .offset(query.offset)
          .execute(),
      );
      const totalRow = await withTenant(app.db, ctx, (tx) =>
        tx.select({ total: count() }).from(reportCards).where(and(...conditions)).execute(),
      );
      return { items: rows.map(toReportCard), total: totalRow[0]?.total ?? 0 };
    },
  );

  app.get(
    '/api/v1/report-cards/:id',
    {
      config: { authorization: { kind: 'tenant', permission: 'exams.read' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('exams.read')],
    },
    async (request) => {
      const ctx = request.ctx!;
      const { id } = request.params as { id: string };
      return withTenant(app.db, ctx, async (tx) => {
        const codes = await tenantRoleCodes(tx, ctx);
        const vis = resultsVisibility(codes);
        const allowed = await readableResultStudentIds(tx, ctx, vis);

        const row = await tx
          .select({
            reportCard: reportCards,
            exam: exams,
            termName: academicTerms.name,
            academicYearName: academicYears.name,
            studentFirstName: students.firstName,
            studentLastName: students.lastName,
            className: acdClasses.name,
          })
          .from(reportCards)
          .innerJoin(exams, and(eq(exams.tenantId, reportCards.tenantId), eq(exams.id, reportCards.examId)))
          .innerJoin(academicTerms, and(eq(academicTerms.tenantId, exams.tenantId), eq(academicTerms.id, exams.academicTermId)))
          .innerJoin(academicYears, and(eq(academicYears.tenantId, reportCards.tenantId), eq(academicYears.id, reportCards.academicYearId)))
          .innerJoin(students, and(eq(students.tenantId, reportCards.tenantId), eq(students.id, reportCards.studentId)))
          .innerJoin(
            enrollments,
            and(eq(enrollments.tenantId, reportCards.tenantId), eq(enrollments.id, reportCards.enrollmentId)),
          )
          .innerJoin(acdClasses, and(eq(acdClasses.tenantId, enrollments.tenantId), eq(acdClasses.id, enrollments.classId)))
          .where(
            and(
              eq(reportCards.tenantId, ctx.tenantId ?? ''),
              eq(reportCards.id, id),
              isNull(reportCards.deletedAt),
            ),
          )
          .limit(1)
          .execute()
          .then((r) => r[0]);
        if (!row) throw notFoundError('Report card not found');

        // Relationship + publication scoping, identical to the list route, so a
        // detail fetch can never widen what the list would have shown.
        if (allowed !== null && !allowed.includes(row.reportCard.studentId)) {
          throw new HttpError('You may only view results for students linked to you', {
            status: 403,
            code: 'results_scope_denied',
          });
        }
        if (!isStaff(vis) && row.reportCard.status !== 'published') {
          throw notFoundError('Report card not found');
        }

        const detail = await toReportCardDetail(tx, ctx, row as TranscriptSource);
        let fileUrl: string | null = null;
        if (detail.fileId) {
          const file = await tx
            .select({ id: files.id, storageKey: files.storageKey })
            .from(files)
            .where(and(eq(files.tenantId, ctx.tenantId ?? ''), eq(files.id, detail.fileId), isNull(files.deletedAt)))
            .limit(1)
            .execute()
            .then((r) => r[0]);
          if (file) {
            fileUrl = await app.storage.getDownloadUrl(ctx.tenantId ?? '', file.storageKey);
          }
        }
        return { reportCard: detail, fileUrl };
      });
    },
  );

  // ---------------------------------------------------------------- transcript
  app.get(
    '/api/v1/students/:studentId/transcript',
    {
      config: { authorization: { kind: 'tenant', permission: 'exams.read' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('exams.read')],
    },
    async (request) => {
      const ctx = request.ctx!;
      const { studentId } = request.params as { studentId: string };
      return withTenant(app.db, ctx, async (tx) => {
        const codes = await tenantRoleCodes(tx, ctx);
        const vis = resultsVisibility(codes);
        const allowed = await readableResultStudentIds(tx, ctx, vis);
        if (allowed !== null && !allowed.includes(studentId)) {
          throw new HttpError('You may only view results for students linked to you', {
            status: 403,
            code: 'results_scope_denied',
          });
        }
        return loadTranscript(tx, ctx, studentId);
      });
    },
  );

  // ---------------------------------------------------------------- portal
  app.get(
    '/api/v1/me/results',
    {
      config: { authorization: { kind: 'tenant', permission: 'exams.read' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('exams.read')],
    },
    async (request) => {
      const ctx = request.ctx!;
      const query = resultsPortalQuerySchema.parse(request.query ?? {});
      return withTenant(app.db, ctx, (tx) => resolveResultsPortal(tx, ctx, query));
    },
  );
}
