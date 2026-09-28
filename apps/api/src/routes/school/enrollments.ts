import type { FastifyInstance } from 'fastify';
import { and, asc, count, desc, eq, isNull } from 'drizzle-orm';
import { HttpError } from '@sms/core';
import { academicYears, enrollments, students, transfers, withTenant, type Tx } from '@sms/db';
import { writeAudit } from '@sms/audit';
import { enqueueOutbox } from '@sms/events';
import { requestFingerprint, withIdempotency } from '@sms/idempotency';
import {
  enrollStudentRequestSchema,
  enrollmentListQuerySchema,
  idParamSchema,
  transferStudentRequestSchema,
  type Enrollment,
  type Transfer,
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

type EnrollmentRow = typeof enrollments.$inferSelect;
type TransferRow = typeof transfers.$inferSelect;

export function toEnrollment(row: EnrollmentRow): Enrollment {
  return {
    id: row.id,
    tenantId: row.tenantId,
    studentId: row.studentId,
    academicYearId: row.academicYearId,
    classId: row.classId,
    sectionId: row.sectionId,
    rollNo: row.rollNo,
    status: row.status as Enrollment['status'],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toTransfer(row: TransferRow): Transfer {
  return {
    id: row.id,
    tenantId: row.tenantId,
    studentId: row.studentId,
    type: row.type as Transfer['type'],
    status: row.status as Transfer['status'],
    fromSchoolName: row.fromSchoolName,
    toSchoolName: row.toSchoolName,
    reason: row.reason,
    transferredOn: row.transferredOn,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

interface LifecycleCtx {
  userId: string;
  tenantId: string | null;
  campusId: string | null;
}

/**
 * Enroll an applicant into an academic year. The enrollment row is inserted
 * FIRST so a duplicate (guarded by enrollments_student_year_uq) deterministically
 * surfaces as `student_already_enrolled`; only the winning request then flips the
 * student applicant -> active via a guarded single-row UPDATE (single-winner under
 * READ COMMITTED). Any later failure rolls the insertion back with it.
 */
export async function enrollStudent(
  tx: Tx,
  ctx: LifecycleCtx,
  studentId: string,
  academicYearId: string,
  requestId: string,
): Promise<{ enrollment: EnrollmentRow; student: typeof students.$inferSelect }> {
  try {
    const year = await tx
      .select({ id: academicYears.id })
      .from(academicYears)
      .where(
        and(
          eq(academicYears.tenantId, ctx.tenantId ?? ''),
          eq(academicYears.id, academicYearId),
          isNull(academicYears.deletedAt),
        ),
      )
      .limit(1)
      .execute()
      .then((r) => r[0]);
    if (!year) throw notFoundError('Academic year not found');

    const student = await tx
      .select()
      .from(students)
      .where(
        and(eq(students.tenantId, ctx.tenantId ?? ''), eq(students.id, studentId), isNull(students.deletedAt)),
      )
      .limit(1)
      .execute()
      .then((r) => r[0]);
    if (!student) throw notFoundError('Student not found');
    assertCampusScope(ctx, student.primaryCampusId);

    const inserted = await tx
      .insert(enrollments)
      .values({
        tenantId: ctx.tenantId ?? '',
        studentId,
        academicYearId,
        status: 'active',
      })
      .returning();
    const enrollment = inserted[0]!;

    const flipped = await tx
      .update(students)
      .set({ status: 'active' })
      .where(
        and(
          eq(students.tenantId, ctx.tenantId ?? ''),
          eq(students.id, studentId),
          eq(students.status, 'applicant'),
          isNull(students.deletedAt),
        ),
      )
      .returning();
    const active = flipped[0];
    if (!active) {
      throw new HttpError('Invalid student status transition', {
        status: 409,
        code: 'invalid_student_transition',
      });
    }

    await writeAudit(tx, {
      scope: 'tenant',
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action: 'student.enrolled',
      resourceType: 'enrollment',
      resourceId: enrollment.id,
      newValue: { studentId, academicYearId, enrollmentId: enrollment.id },
      requestId,
    });
    await enqueueOutbox(tx, {
      tenantId: ctx.tenantId,
      eventType: 'student.enrolled',
      aggregateType: 'enrollment',
      aggregateId: enrollment.id,
      payload: { tenantId: ctx.tenantId, studentId, academicYearId, enrollmentId: enrollment.id },
      correlationId: requestId,
    });
    return { enrollment, student: active };
  } catch (err) {
    throw mapDomainError(err);
  }
}

/**
 * Transfer an ACTIVE student out (type 'out', completed immediately with today's
 * date when the client does not supply one). The guarded applicant/active/live
 * transition is the single-winner check; a student not in 'active' gets 409
 * `invalid_student_transition`.
 */
export async function transferStudent(
  tx: Tx,
  ctx: LifecycleCtx,
  studentId: string,
  input: { toSchoolName?: string; reason?: string; transferredOn?: string },
  requestId: string,
): Promise<TransferRow> {
  try {
    const student = await tx
      .select()
      .from(students)
      .where(
        and(eq(students.tenantId, ctx.tenantId ?? ''), eq(students.id, studentId), isNull(students.deletedAt)),
      )
      .limit(1)
      .execute()
      .then((r) => r[0]);
    if (!student) throw notFoundError('Student not found');
    assertCampusScope(ctx, student.primaryCampusId);

    const flipped = await tx
      .update(students)
      .set({ status: 'transferred' })
      .where(
        and(
          eq(students.tenantId, ctx.tenantId ?? ''),
          eq(students.id, studentId),
          eq(students.status, 'active'),
          isNull(students.deletedAt),
        ),
      )
      .returning();
    if (flipped.length === 0) {
      throw new HttpError('Invalid student status transition', {
        status: 409,
        code: 'invalid_student_transition',
      });
    }

    const transferredOn = input.transferredOn ?? new Date().toISOString().slice(0, 10);
    const inserted = await tx
      .insert(transfers)
      .values({
        tenantId: ctx.tenantId ?? '',
        studentId,
        type: 'out',
        status: 'completed',
        toSchoolName: input.toSchoolName ?? null,
        reason: input.reason ?? null,
        transferredOn,
      })
      .returning();
    const transfer = inserted[0]!;

    await writeAudit(tx, {
      scope: 'tenant',
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action: 'student.transferred',
      resourceType: 'transfer',
      resourceId: transfer.id,
      newValue: {
        studentId,
        transferId: transfer.id,
        type: 'out',
        toSchoolName: transfer.toSchoolName,
        transferredOn,
      },
      requestId,
    });
    await enqueueOutbox(tx, {
      tenantId: ctx.tenantId,
      eventType: 'student.transferred',
      aggregateType: 'transfer',
      aggregateId: transfer.id,
      payload: {
        tenantId: ctx.tenantId,
        studentId,
        transferId: transfer.id,
        type: 'out',
        toSchoolName: transfer.toSchoolName ?? null,
      },
      correlationId: requestId,
    });
    return transfer;
  } catch (err) {
    throw mapDomainError(err);
  }
}

/** Graduate an ACTIVE student: guarded transition + audit + outbox; no enrollment mutation. */
export async function graduateStudent(
  tx: Tx,
  ctx: LifecycleCtx,
  studentId: string,
  requestId: string,
): Promise<typeof students.$inferSelect> {
  try {
    const student = await tx
      .select()
      .from(students)
      .where(
        and(eq(students.tenantId, ctx.tenantId ?? ''), eq(students.id, studentId), isNull(students.deletedAt)),
      )
      .limit(1)
      .execute()
      .then((r) => r[0]);
    if (!student) throw notFoundError('Student not found');
    assertCampusScope(ctx, student.primaryCampusId);

    const flipped = await tx
      .update(students)
      .set({ status: 'graduated' })
      .where(
        and(
          eq(students.tenantId, ctx.tenantId ?? ''),
          eq(students.id, studentId),
          eq(students.status, 'active'),
          isNull(students.deletedAt),
        ),
      )
      .returning();
    const graduated = flipped[0];
    if (!graduated) {
      throw new HttpError('Invalid student status transition', {
        status: 409,
        code: 'invalid_student_transition',
      });
    }

    await writeAudit(tx, {
      scope: 'tenant',
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action: 'student.graduated',
      resourceType: 'student',
      resourceId: graduated.id,
      newValue: { studentId: graduated.id, status: graduated.status },
      requestId,
    });
    await enqueueOutbox(tx, {
      tenantId: ctx.tenantId,
      eventType: 'student.graduated',
      aggregateType: 'student',
      aggregateId: graduated.id,
      payload: { tenantId: ctx.tenantId, studentId: graduated.id },
      correlationId: requestId,
    });
    return graduated;
  } catch (err) {
    throw mapDomainError(err);
  }
}

export default async function enrollmentRoutes(app: FastifyInstance) {
  app.get(
    '/api/v1/enrollments',
    {
      config: { authorization: { kind: 'tenant', permission: 'enrollment.read' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('enrollment.read')],
    },
    async (request) => {
      const ctx = request.ctx!;
      const query = enrollmentListQuerySchema.parse(request.query);
      const conditions = [
        eq(enrollments.tenantId, ctx.tenantId ?? ''),
        isNull(enrollments.deletedAt),
      ];
      if (query.academicYearId) conditions.push(eq(enrollments.academicYearId, query.academicYearId));
      if (query.studentId) conditions.push(eq(enrollments.studentId, query.studentId));
      if (query.status) conditions.push(eq(enrollments.status, query.status));
      // Enrollments carry no campus; campus-scoped members only see enrollments
      // of students on their own campus.
      const join = ctx.campusId ? [eq(students.primaryCampusId, ctx.campusId)] : [];
      const rows = await withTenant(app.db, ctx, (tx) =>
        tx
          .select()
          .from(enrollments)
          .innerJoin(
            students,
            and(
              eq(students.tenantId, enrollments.tenantId),
              eq(students.id, enrollments.studentId),
              ...join,
            ),
          )
          .where(and(...conditions))
          .orderBy(desc(enrollments.createdAt), asc(enrollments.id))
          .limit(query.limit)
          .offset(query.offset)
          .execute(),
      );
      const totalRow = await withTenant(app.db, ctx, (tx) =>
        tx
          .select({ total: count() })
          .from(enrollments)
          .innerJoin(
            students,
            and(
              eq(students.tenantId, enrollments.tenantId),
              eq(students.id, enrollments.studentId),
              ...join,
            ),
          )
          .where(and(...conditions))
          .execute(),
      );
      return {
        items: rows.map((r) => toEnrollment(r.enrollments)),
        total: totalRow[0]?.total ?? 0,
      };
    },
  );

  app.get(
    '/api/v1/enrollments/:id',
    {
      config: { authorization: { kind: 'tenant', permission: 'enrollment.read' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('enrollment.read')],
    },
    async (request) => {
      const { id } = idParamSchema.parse(request.params);
      const ctx = request.ctx!;
      const row = await withTenant(app.db, ctx, (tx) =>
        tx
          .select()
          .from(enrollments)
          .innerJoin(
            students,
            and(eq(students.tenantId, enrollments.tenantId), eq(students.id, enrollments.studentId)),
          )
          .where(
            and(eq(enrollments.tenantId, ctx.tenantId ?? ''), eq(enrollments.id, id), isNull(enrollments.deletedAt)),
          )
          .limit(1)
          .execute()
          .then((r) => r[0]),
      );
      if (!row) throw notFoundError('Enrollment not found');
      if (ctx.campusId && row.students.primaryCampusId !== ctx.campusId) {
        throw notFoundError('Enrollment not found');
      }
      return { enrollment: toEnrollment(row.enrollments) };
    },
  );

  app.post(
    '/api/v1/students/:id/enroll',
    {
      config: { authorization: { kind: 'tenant', permission: 'enrollment.manage' } },
      preHandler: [
        requireSession(),
        requireTenantContext(),
        requirePermission('enrollment.manage'),
        requireCsrf(),
      ],
    },
    async (request, reply) => {
      const { id } = idParamSchema.parse(request.params);
      const body = enrollStudentRequestSchema.parse(request.body);
      const ctx = request.ctx!;
      const idemKey = idempotencyKeyFromHeader(request.headers);
      const fingerprint = requestFingerprint(request.method, request.url, body);
      const outcome = await withTenant(app.db, ctx, (tx) =>
        withIdempotency(tx, { tenantId: ctx.tenantId, key: idemKey }, fingerprint, async () => {
          const { enrollment } = await enrollStudent(tx, ctx, id, body.academicYearId, request.requestId);
          return { status: 200, body: { enrollment: toEnrollment(enrollment) } };
        }),
      );
      return reply.code(outcome.status).send(outcome.body);
    },
  );

  app.post(
    '/api/v1/students/:id/transfer',
    {
      config: { authorization: { kind: 'tenant', permission: 'enrollment.manage' } },
      preHandler: [
        requireSession(),
        requireTenantContext(),
        requirePermission('enrollment.manage'),
        requireCsrf(),
      ],
    },
    async (request, reply) => {
      const { id } = idParamSchema.parse(request.params);
      const body = transferStudentRequestSchema.parse(request.body);
      const ctx = request.ctx!;
      const idemKey = idempotencyKeyFromHeader(request.headers);
      const fingerprint = requestFingerprint(request.method, request.url, body);
      const outcome = await withTenant(app.db, ctx, (tx) =>
        withIdempotency(tx, { tenantId: ctx.tenantId, key: idemKey }, fingerprint, async () => {
          const transfer = await transferStudent(tx, ctx, id, body, request.requestId);
          return { status: 200, body: { transfer: toTransfer(transfer) } };
        }),
      );
      return reply.code(outcome.status).send(outcome.body);
    },
  );

  app.post(
    '/api/v1/students/:id/graduate',
    {
      config: { authorization: { kind: 'tenant', permission: 'enrollment.manage' } },
      preHandler: [
        requireSession(),
        requireTenantContext(),
        requirePermission('enrollment.manage'),
        requireCsrf(),
      ],
    },
    async (request, reply) => {
      const { id } = idParamSchema.parse(request.params);
      const ctx = request.ctx!;
      const idemKey = idempotencyKeyFromHeader(request.headers);
      const fingerprint = requestFingerprint(request.method, request.url, {});
      const outcome = await withTenant(app.db, ctx, (tx) =>
        withIdempotency(tx, { tenantId: ctx.tenantId, key: idemKey }, fingerprint, async () => {
          const student = await graduateStudent(tx, ctx, id, request.requestId);
          return {
            status: 200,
            body: {
              student: {
                id: student.id,
                tenantId: student.tenantId,
                studentNo: student.studentNo,
                firstName: student.firstName,
                lastName: student.lastName,
                dateOfBirth: student.dateOfBirth,
                gender: student.gender,
                status: student.status,
                primaryCampusId: student.primaryCampusId,
                createdAt: student.createdAt.toISOString(),
                updatedAt: student.updatedAt.toISOString(),
              },
            },
          };
        }),
      );
      return reply.code(outcome.status).send(outcome.body);
    },
  );
}