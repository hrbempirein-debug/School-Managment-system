import type { FastifyInstance } from 'fastify';
import { and, count, desc, eq, isNull } from 'drizzle-orm';
import {
  acdClasses,
  classSubjects,
  subjects,
  teacherAssignments,
  withTenant,
  type Tx,
} from '@sms/db';
import { writeAudit } from '@sms/audit';
import { enqueueOutbox } from '@sms/events';
import { requestFingerprint, withIdempotency } from '@sms/idempotency';
import {
  assignTeacherRequestSchema,
  teacherAssignmentListQuerySchema,
  teacherParamSchema,
  classSubjectParamSchema,
  type TeacherAssignment,
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

type TeacherAssignmentRow = typeof teacherAssignments.$inferSelect;
type ClassRow = typeof acdClasses.$inferSelect;

export function toTeacherAssignment(row: TeacherAssignmentRow): TeacherAssignment {
  return {
    id: row.id,
    tenantId: row.tenantId,
    classId: row.classId,
    subjectId: row.subjectId,
    teacherUserId: row.teacherUserId,
    campusId: row.campusId,
    academicYearId: row.academicYearId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Resolve the live parent class of a teacher-assignment route. Not-found stays
 * 404; campus scope is asserted against the class campus (AUTHORIZATION.md §4).
 */
async function resolveLiveClass(
  tx: Tx,
  ctx: { tenantId: string | null; campusId: string | null },
  classId: string,
): Promise<ClassRow> {
  const row = await tx
    .select()
    .from(acdClasses)
    .where(and(eq(acdClasses.tenantId, ctx.tenantId ?? ''), eq(acdClasses.id, classId), isNull(acdClasses.deletedAt)))
    .limit(1)
    .execute()
    .then((r) => r[0]);
  if (!row) throw notFoundError('Class not found');
  assertCampusScope(ctx, row.campusId);
  return row;
}

/**
 * Assign a teacher to a (class, subject) pair. campus/academic_year are copied
 * from the parent class (composite FKs pin the copy). The SECURITY INVOKER
 * trigger re-verifies at write time that the class-subject link exists and that
 * the teacher is an ACTIVE membership carrying the tenant-scoped `teacher` role
 * — eligibility violations surface as the documented 409 `teacher_not_active`.
 * One live assignment per pair (teacher_assignments_class_subject_live_uq)
 * surfaces as 409 `teacher_already_assigned`.
 */
export async function assignTeacher(
  tx: Tx,
  ctx: { userId: string; tenantId: string | null; campusId: string | null },
  classId: string,
  subjectId: string,
  teacherUserId: string,
  requestId: string,
): Promise<TeacherAssignmentRow> {
  try {
    const parent = await resolveLiveClass(tx, ctx, classId);
    const subject = await tx
      .select({ id: subjects.id })
      .from(subjects)
      .where(and(eq(subjects.tenantId, ctx.tenantId ?? ''), eq(subjects.id, subjectId), isNull(subjects.deletedAt)))
      .limit(1)
      .execute()
      .then((r) => r[0]);
    if (!subject) throw notFoundError('Subject not found');
    const link = await tx
      .select({ id: classSubjects.id })
      .from(classSubjects)
      .where(
        and(
          eq(classSubjects.tenantId, ctx.tenantId ?? ''),
          eq(classSubjects.classId, parent.id),
          eq(classSubjects.subjectId, subject.id),
          isNull(classSubjects.deletedAt),
        ),
      )
      .limit(1)
      .execute()
      .then((r) => r[0]);
    if (!link) throw notFoundError('Subject is not attached to this class');

    const rows = await tx
      .insert(teacherAssignments)
      .values({
        tenantId: ctx.tenantId ?? '',
        classId: parent.id,
        subjectId: subject.id,
        teacherUserId,
        campusId: parent.campusId,
        academicYearId: parent.academicYearId,
      })
      .returning();
    const row = rows[0]!;
    await writeAudit(tx, {
      scope: 'tenant',
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action: 'teacher.assigned',
      resourceType: 'teacher_assignment',
      resourceId: row.id,
      newValue: toTeacherAssignment(row),
      requestId,
    });
    await enqueueOutbox(tx, {
      tenantId: ctx.tenantId,
      eventType: 'teacher.assigned',
      aggregateType: 'teacher_assignment',
      aggregateId: row.id,
      payload: {
        tenantId: ctx.tenantId,
        teacherAssignmentId: row.id,
        classId: row.classId,
        subjectId: row.subjectId,
        teacherUserId: row.teacherUserId,
        campusId: row.campusId,
        academicYearId: row.academicYearId,
      },
      correlationId: requestId,
    });
    return row;
  } catch (err) {
    throw mapDomainError(err);
  }
}

/**
 * Unassign the teacher from a (class, subject) pair (soft-delete; history
 * retained, reassignment is strictly unassign-then-assign). The trigger skips
 * eligibility re-validation on soft-deletes, so unassigning always succeeds
 * even if the teacher's membership was later suspended.
 */
export async function unassignTeacher(
  tx: Tx,
  ctx: { userId: string; tenantId: string | null; campusId: string | null },
  classId: string,
  subjectId: string,
  teacherUserId: string,
  requestId: string,
): Promise<TeacherAssignmentRow | null> {
  try {
    const parent = await resolveLiveClass(tx, ctx, classId);
    const beforeRows = await tx
      .select()
      .from(teacherAssignments)
      .where(
        and(
          eq(teacherAssignments.tenantId, ctx.tenantId ?? ''),
          eq(teacherAssignments.classId, parent.id),
          eq(teacherAssignments.subjectId, subjectId),
          eq(teacherAssignments.teacherUserId, teacherUserId),
          isNull(teacherAssignments.deletedAt),
        ),
      )
      .limit(1)
      .execute();
    const before = beforeRows[0];
    if (!before) return null;

    const rows = await tx
      .update(teacherAssignments)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(teacherAssignments.tenantId, ctx.tenantId ?? ''),
          eq(teacherAssignments.id, before.id),
          isNull(teacherAssignments.deletedAt),
        ),
      )
      .returning();
    const row = rows[0];
    if (!row) return null;
    await writeAudit(tx, {
      scope: 'tenant',
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action: 'teacher.unassigned',
      resourceType: 'teacher_assignment',
      resourceId: row.id,
      oldValue: toTeacherAssignment(before),
      newValue: { deletedAt: row.deletedAt?.toISOString() ?? null },
      requestId,
    });
    await enqueueOutbox(tx, {
      tenantId: ctx.tenantId,
      eventType: 'teacher.unassigned',
      aggregateType: 'teacher_assignment',
      aggregateId: row.id,
      payload: {
        tenantId: ctx.tenantId,
        teacherAssignmentId: row.id,
        classId: row.classId,
        subjectId: row.subjectId,
        teacherUserId: row.teacherUserId,
      },
      correlationId: requestId,
    });
    return row;
  } catch (err) {
    throw mapDomainError(err);
  }
}

export default async function teacherAssignmentRoutes(app: FastifyInstance) {
  app.get(
    '/api/v1/classes/:id/subjects/:subjectId/teachers',
    {
      config: { authorization: { kind: 'tenant', permission: 'teacher.assignments.read' } },
      preHandler: [
        requireSession(),
        requireTenantContext(),
        requirePermission('teacher.assignments.read'),
      ],
    },
    async (request) => {
      const { id, subjectId } = classSubjectParamSchema.parse(request.params);
      const ctx = request.ctx!;
      await withTenant(app.db, ctx, (tx) => resolveLiveClass(tx, ctx, id));
      const query = teacherAssignmentListQuerySchema.parse(request.query);
      const conditions = [
        eq(teacherAssignments.tenantId, ctx.tenantId ?? ''),
        eq(teacherAssignments.classId, id),
        eq(teacherAssignments.subjectId, subjectId),
        isNull(teacherAssignments.deletedAt),
      ];
      const rows = await withTenant(app.db, ctx, (tx) =>
        tx
          .select()
          .from(teacherAssignments)
          .where(and(...conditions))
          .orderBy(desc(teacherAssignments.createdAt), desc(teacherAssignments.id))
          .limit(query.limit)
          .offset(query.offset)
          .execute(),
      );
      const totalRow = await withTenant(app.db, ctx, (tx) =>
        tx
          .select({ total: count() })
          .from(teacherAssignments)
          .where(and(...conditions))
          .execute(),
      );
      return { items: rows.map(toTeacherAssignment), total: totalRow[0]?.total ?? 0 };
    },
  );

  app.post(
    '/api/v1/classes/:id/subjects/:subjectId/teachers',
    {
      config: { authorization: { kind: 'tenant', permission: 'teacher.assignments.manage' } },
      preHandler: [
        requireSession(),
        requireTenantContext(),
        requirePermission('teacher.assignments.manage'),
        requireCsrf(),
      ],
    },
    async (request, reply) => {
      const { id, subjectId } = classSubjectParamSchema.parse(request.params);
      const body = assignTeacherRequestSchema.parse(request.body);
      const ctx = request.ctx!;
      const idemKey = idempotencyKeyFromHeader(request.headers);
      const fingerprint = requestFingerprint(request.method, request.url, body);
      const outcome = await withTenant(app.db, ctx, (tx) =>
        withIdempotency(tx, { tenantId: ctx.tenantId, key: idemKey }, fingerprint, async () => {
          const row = await assignTeacher(tx, ctx, id, subjectId, body.teacherUserId, request.requestId);
          return { status: 201, body: { teacherAssignment: toTeacherAssignment(row) } };
        }),
      );
      return reply.code(outcome.status).send(outcome.body);
    },
  );

  app.delete(
    '/api/v1/classes/:id/subjects/:subjectId/teachers/:teacherId',
    {
      config: { authorization: { kind: 'tenant', permission: 'teacher.assignments.manage' } },
      preHandler: [
        requireSession(),
        requireTenantContext(),
        requirePermission('teacher.assignments.manage'),
        requireCsrf(),
      ],
    },
    async (request, reply) => {
      const { id, subjectId, teacherId } = teacherParamSchema.parse(request.params);
      const ctx = request.ctx!;
      const idemKey = idempotencyKeyFromHeader(request.headers);
      const fingerprint = requestFingerprint(request.method, request.url, {});
      const outcome = await withTenant(app.db, ctx, (tx) =>
        withIdempotency(tx, { tenantId: ctx.tenantId, key: idemKey }, fingerprint, async () => {
          const row = await unassignTeacher(tx, ctx, id, subjectId, teacherId, request.requestId);
          if (!row) throw notFoundError('Teacher assignment not found');
          return { status: 200, body: { teacherAssignment: toTeacherAssignment(row) } };
        }),
      );
      return reply.code(outcome.status).send(outcome.body);
    },
  );
}