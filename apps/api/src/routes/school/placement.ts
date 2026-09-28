import type { FastifyInstance } from 'fastify';
import { and, eq, isNull } from 'drizzle-orm';
import { enrollments, students, withTenant, type Tx } from '@sms/db';
import { writeAudit } from '@sms/audit';
import { enqueueOutbox } from '@sms/events';
import { requestFingerprint, withIdempotency } from '@sms/idempotency';
import { idParamSchema, setPlacementRequestSchema, type Placement } from '@sms/contracts';
import {
  requireSession,
  requireTenantContext,
  requirePermission,
  requireCsrf,
} from '../../plugins/auth.js';
import { mapDomainError, idempotencyKeyFromHeader, notFoundError } from './util.js';

type EnrollmentRow = typeof enrollments.$inferSelect;
type StudentRow = typeof students.$inferSelect;

interface PlacementCtx {
  userId: string;
  tenantId: string | null;
  campusId: string | null;
}

export function toPlacement(row: EnrollmentRow): Placement {
  return {
    enrollmentId: row.id,
    studentId: row.studentId,
    academicYearId: row.academicYearId,
    classId: row.classId,
    sectionId: row.sectionId,
    rollNo: row.rollNo,
  };
}

/**
 * Load the live enrollment + its student, applying the same campus scope as
 * GET /enrollments/:id (a campus-scoped member may only see/manage placements
 * of students on their own campus; anything else surfaces as not-found).
 */
async function loadEnrollmentForPlacement(
  tx: Tx,
  ctx: PlacementCtx & { campusId: string | null },
  enrollmentId: string,
): Promise<{ enrollment: EnrollmentRow; student: StudentRow }> {
  const row = await tx
    .select()
    .from(enrollments)
    .innerJoin(
      students,
      and(eq(students.tenantId, enrollments.tenantId), eq(students.id, enrollments.studentId)),
    )
    .where(
      and(eq(enrollments.tenantId, ctx.tenantId ?? ''), eq(enrollments.id, enrollmentId), isNull(enrollments.deletedAt)),
    )
    .limit(1)
    .execute()
    .then((r) => r[0]);
  if (!row) throw notFoundError('Enrollment not found');
  if (ctx.campusId && row.students.primaryCampusId !== ctx.campusId) {
    throw notFoundError('Enrollment not found');
  }
  return { enrollment: row.enrollments, student: row.students };
}

/**
 * Set (assign or move) an enrollment's placement. The DB integrity trigger
 * validates everything with canonical 409 codes: live+active class, year
 * alignment, section→class membership, section liveness, active student +
 * enrollment, and student-campus vs class-campus consistency. rollNo is
 * optional; when omitted it is cleared (deterministic set semantics) and the
 * partial unique index enrollments_roll_no_uq enforces per-section uniqueness.
 */
export async function setPlacement(
  tx: Tx,
  ctx: PlacementCtx,
  enrollmentId: string,
  input: { classId: string; sectionId: string; rollNo?: string },
  requestId: string,
): Promise<EnrollmentRow> {
  try {
    const { enrollment } = await loadEnrollmentForPlacement(tx, ctx, enrollmentId);
    const classId = input.classId;
    const sectionId = input.sectionId;
    const rollNo = input.rollNo ?? null;

    if (
      enrollment.classId === classId &&
      enrollment.sectionId === sectionId &&
      enrollment.rollNo === rollNo
    ) {
      return enrollment;
    }

    const rows = await tx
      .update(enrollments)
      .set({ classId, sectionId, rollNo })
      .where(
        and(eq(enrollments.tenantId, ctx.tenantId ?? ''), eq(enrollments.id, enrollmentId), isNull(enrollments.deletedAt)),
      )
      .returning();
    const row = rows[0];
    if (!row) throw notFoundError('Enrollment not found');

    const eventType = enrollment.classId === null ? 'placement.assigned' : 'placement.moved';
    await writeAudit(tx, {
      scope: 'tenant',
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action: eventType,
      resourceType: 'enrollment',
      resourceId: enrollmentId,
      oldValue: {
        classId: enrollment.classId,
        sectionId: enrollment.sectionId,
        rollNo: enrollment.rollNo,
      },
      newValue: { classId, sectionId, rollNo },
      requestId,
    });
    await enqueueOutbox(tx, {
      tenantId: ctx.tenantId,
      eventType,
      aggregateType: 'enrollment',
      aggregateId: enrollmentId,
      payload: {
        tenantId: ctx.tenantId,
        enrollmentId,
        studentId: enrollment.studentId,
        classId,
        sectionId,
        rollNo,
      },
      correlationId: requestId,
    });
    return row;
  } catch (err) {
    throw mapDomainError(err);
  }
}

/**
 * Unassign a placement: class/section/rollNo all become NULL. Idempotent — an
 * already-unplaced enrollment returns unchanged with no event (the trigger's
 * unchanged short-circuit keeps the UPDATE safe).
 */
export async function unassignPlacement(
  tx: Tx,
  ctx: PlacementCtx,
  enrollmentId: string,
  requestId: string,
): Promise<EnrollmentRow> {
  try {
    const { enrollment } = await loadEnrollmentForPlacement(tx, ctx, enrollmentId);
    if (enrollment.classId === null && enrollment.sectionId === null && enrollment.rollNo === null) {
      return enrollment;
    }

    const rows = await tx
      .update(enrollments)
      .set({ classId: null, sectionId: null, rollNo: null })
      .where(
        and(eq(enrollments.tenantId, ctx.tenantId ?? ''), eq(enrollments.id, enrollmentId), isNull(enrollments.deletedAt)),
      )
      .returning();
    const row = rows[0];
    if (!row) throw notFoundError('Enrollment not found');

    await writeAudit(tx, {
      scope: 'tenant',
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action: 'placement.unassigned',
      resourceType: 'enrollment',
      resourceId: enrollmentId,
      oldValue: {
        classId: enrollment.classId,
        sectionId: enrollment.sectionId,
        rollNo: enrollment.rollNo,
      },
      newValue: { classId: null, sectionId: null, rollNo: null },
      requestId,
    });
    await enqueueOutbox(tx, {
      tenantId: ctx.tenantId,
      eventType: 'placement.unassigned',
      aggregateType: 'enrollment',
      aggregateId: enrollmentId,
      payload: {
        tenantId: ctx.tenantId,
        enrollmentId,
        studentId: enrollment.studentId,
        classId: null,
        sectionId: null,
        rollNo: null,
      },
      correlationId: requestId,
    });
    return row;
  } catch (err) {
    throw mapDomainError(err);
  }
}

export default async function placementRoutes(app: FastifyInstance) {
  app.get(
    '/api/v1/enrollments/:id/placement',
    {
      config: { authorization: { kind: 'tenant', permission: 'placement.read' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('placement.read')],
    },
    async (request) => {
      const { id } = idParamSchema.parse(request.params);
      const ctx = request.ctx!;
      const { enrollment } = await withTenant(app.db, ctx, (tx) =>
        loadEnrollmentForPlacement(tx, ctx, id),
      );
      return { placement: toPlacement(enrollment) };
    },
  );

  app.post(
    '/api/v1/enrollments/:id/placement',
    {
      config: { authorization: { kind: 'tenant', permission: 'placement.manage' } },
      preHandler: [
        requireSession(),
        requireTenantContext(),
        requirePermission('placement.manage'),
        requireCsrf(),
      ],
    },
    async (request, reply) => {
      const { id } = idParamSchema.parse(request.params);
      const body = setPlacementRequestSchema.parse(request.body);
      const ctx = request.ctx!;
      const idemKey = idempotencyKeyFromHeader(request.headers);
      const fingerprint = requestFingerprint(request.method, request.url, body);
      const outcome = await withTenant(app.db, ctx, (tx) =>
        withIdempotency(tx, { tenantId: ctx.tenantId, key: idemKey }, fingerprint, async () => {
          const row = await setPlacement(tx, ctx, id, body, request.requestId);
          return { status: 200, body: { placement: toPlacement(row) } };
        }),
      );
      return reply.code(outcome.status).send(outcome.body);
    },
  );

  app.delete(
    '/api/v1/enrollments/:id/placement',
    {
      config: { authorization: { kind: 'tenant', permission: 'placement.manage' } },
      preHandler: [
        requireSession(),
        requireTenantContext(),
        requirePermission('placement.manage'),
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
          const row = await unassignPlacement(tx, ctx, id, request.requestId);
          return { status: 200, body: { placement: toPlacement(row) } };
        }),
      );
      return reply.code(outcome.status).send(outcome.body);
    },
  );
}