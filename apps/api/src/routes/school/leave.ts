import type { FastifyInstance } from 'fastify';
import { and, count, desc, eq, inArray, isNull, lte, gte } from 'drizzle-orm';
import {
  leaveTypes,
  leaveRequests,
  students,
  enrollments,
  withTenant,
  type Tx,
} from '@sms/db';
import { HttpError } from '@sms/core';
import { writeAudit } from '@sms/audit';
import { enqueueOutbox } from '@sms/events';
import { requestFingerprint, withIdempotency } from '@sms/idempotency';
import {
  createLeaveRequestSchema,
  createLeaveTypeRequestSchema,
  decideLeaveRequestSchema,
  leaveRequestListQuerySchema,
  leaveTypeListQuerySchema,
  updateLeaveTypeRequestSchema,
  type CreateLeaveRequest,
  type CreateLeaveTypeRequest,
  type DecideLeaveRequest,
  type LeaveRequest,
  type LeaveType,
  type UpdateLeaveTypeRequest,
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
import { attendanceVisibility, readableStudentIds } from './attendance.js';
import { tenantRoleCodes } from './homework.js';

type Ctx = { userId: string; tenantId: string | null; campusId: string | null };
type LeaveTypeRow = typeof leaveTypes.$inferSelect;
type LeaveRequestRow = typeof leaveRequests.$inferSelect;

export function toLeaveType(row: LeaveTypeRow): LeaveType {
  return {
    id: row.id,
    tenantId: row.tenantId,
    code: row.code,
    name: row.name,
    status: row.status as LeaveType['status'],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toLeaveRequest(row: LeaveRequestRow): LeaveRequest {
  return {
    id: row.id,
    tenantId: row.tenantId,
    studentId: row.studentId,
    leaveTypeId: row.leaveTypeId,
    startDate: row.startDate,
    endDate: row.endDate,
    reason: row.reason,
    status: row.status as LeaveRequest['status'],
    requestedBy: row.requestedBy,
    approverUserId: row.approverUserId,
    decisionAt: row.decisionAt ? row.decisionAt.toISOString() : null,
    decisionNote: row.decisionNote,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function leaveScopeDenied(): HttpError {
  return new HttpError('You may only file leave for students you are linked to', {
    status: 403,
    code: 'leave_scope_denied',
  });
}

/**
 * Relationship check for FILING a leave request. A parent may file for a student
 * they are a LIVE guardian of; a student may file only for their own linked
 * student row; school staff (owner/principal) may file for any student in the
 * school. This is the same relationship join the read scoping uses, so a portal
 * can never file for a student whose records it cannot see.
 */
export async function assertCanRequestLeaveFor(
  tx: Tx,
  ctx: Ctx,
  codes: readonly string[],
  studentId: string,
): Promise<void> {
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

  if (codes.includes('school_owner') || codes.includes('principal')) return;

  if (codes.includes('parent')) {
    const own = await readableStudentIds(tx, ctx, 'parent');
    if (own && own.includes(studentId)) return;
  }
  if (codes.includes('student')) {
    const own = await readableStudentIds(tx, ctx, 'student');
    if (own && own.includes(studentId)) return;
  }
  throw leaveScopeDenied();
}

// ------------------------------------------------------------------ domain services

export async function createLeaveType(
  tx: Tx,
  ctx: Ctx,
  input: CreateLeaveTypeRequest,
  requestId: string,
): Promise<LeaveType> {
  try {
    const rows = await tx
      .insert(leaveTypes)
      .values({
        tenantId: ctx.tenantId ?? '',
        code: input.code,
        name: input.name,
      })
      .returning();
    const row = rows[0]!;
    await writeAudit(tx, {
      scope: 'tenant',
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action: 'leave.type.created',
      resourceType: 'leave_type',
      resourceId: row.id,
      newValue: { code: row.code, name: row.name },
      requestId,
    });
    return toLeaveType(row);
  } catch (err) {
    throw mapDomainError(err);
  }
}

export async function updateLeaveType(
  tx: Tx,
  ctx: Ctx,
  id: string,
  input: UpdateLeaveTypeRequest,
  requestId: string,
): Promise<LeaveType | null> {
  try {
    const before = await tx
      .select()
      .from(leaveTypes)
      .where(and(eq(leaveTypes.tenantId, ctx.tenantId ?? ''), eq(leaveTypes.id, id), isNull(leaveTypes.deletedAt)))
      .limit(1)
      .execute()
      .then((r) => r[0]);
    if (!before) return null;
    const set: Partial<LeaveTypeRow> = {};
    if (input.name !== undefined) set.name = input.name;
    if (input.status !== undefined) set.status = input.status;
    const rows = await tx
      .update(leaveTypes)
      .set(set)
      .where(and(eq(leaveTypes.tenantId, ctx.tenantId ?? ''), eq(leaveTypes.id, id), isNull(leaveTypes.deletedAt)))
      .returning();
    const row = rows[0];
    if (!row) return null;
    await writeAudit(tx, {
      scope: 'tenant',
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action: 'leave.type.updated',
      resourceType: 'leave_type',
      resourceId: row.id,
      oldValue: { name: before.name, status: before.status },
      newValue: { name: row.name, status: row.status },
      requestId,
    });
    return toLeaveType(row);
  } catch (err) {
    throw mapDomainError(err);
  }
}

export async function createLeaveRequest(
  tx: Tx,
  ctx: Ctx,
  codes: readonly string[],
  input: CreateLeaveRequest,
  requestId: string,
): Promise<LeaveRequest> {
  try {
    await assertCanRequestLeaveFor(tx, ctx, codes, input.studentId);
    const type = await tx
      .select({ id: leaveTypes.id })
      .from(leaveTypes)
      .where(
        and(
          eq(leaveTypes.tenantId, ctx.tenantId ?? ''),
          eq(leaveTypes.id, input.leaveTypeId),
          eq(leaveTypes.status, 'active'),
          isNull(leaveTypes.deletedAt),
        ),
      )
      .limit(1)
      .execute()
      .then((r) => r[0]);
    if (!type) throw notFoundError('Leave type not found');

    const rows = await tx
      .insert(leaveRequests)
      .values({
        tenantId: ctx.tenantId ?? '',
        studentId: input.studentId,
        leaveTypeId: type.id,
        startDate: input.startDate,
        endDate: input.endDate,
        reason: input.reason ?? null,
        // status/requestedBy/approver are server-derived: a request is always
        // filed as `pending` BY the caller and can only be decided later.
        status: 'pending',
        requestedBy: ctx.userId,
      })
      .returning();
    const row = rows[0]!;
    await writeAudit(tx, {
      scope: 'tenant',
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action: 'leave.requested',
      resourceType: 'leave_request',
      resourceId: row.id,
      newValue: {
        studentId: row.studentId,
        leaveTypeId: row.leaveTypeId,
        startDate: row.startDate,
        endDate: row.endDate,
        status: row.status,
      },
      requestId,
    });
    await enqueueOutbox(tx, {
      tenantId: ctx.tenantId,
      eventType: 'leave.requested',
      aggregateType: 'leave_request',
      aggregateId: row.id,
      payload: { tenantId: ctx.tenantId, leaveRequestId: row.id, studentId: row.studentId },
      correlationId: requestId,
    });
    return toLeaveRequest(row);
  } catch (err) {
    throw mapDomainError(err);
  }
}

/**
 * Approve or reject a pending leave request. The state machine is enforced by the
 * DB trigger (a decided request is frozen), and the decision columns are derived
 * from the caller — the client cannot name an approver or a decision timestamp.
 */
export async function decideLeaveRequest(
  tx: Tx,
  ctx: Ctx,
  codes: readonly string[],
  id: string,
  decision: 'approved' | 'rejected',
  input: DecideLeaveRequest,
  requestId: string,
): Promise<LeaveRequest> {
  try {
    if (!codes.includes('school_owner') && !codes.includes('principal')) {
      throw new HttpError('You may not decide leave requests', {
        status: 403,
        code: 'leave_decision_denied',
      });
    }
    const before = await tx
      .select()
      .from(leaveRequests)
      .where(
        and(eq(leaveRequests.tenantId, ctx.tenantId ?? ''), eq(leaveRequests.id, id), isNull(leaveRequests.deletedAt)),
      )
      .limit(1)
      .execute()
      .then((r) => r[0]);
    if (!before) throw notFoundError('Leave request not found');
    if (before.status !== 'pending') {
      throw new HttpError('Leave request has already been decided', {
        status: 409,
        code: 'leave_already_decided',
      });
    }

    const rows = await tx
      .update(leaveRequests)
      .set({
        status: decision,
        approverUserId: ctx.userId,
        decisionAt: new Date(),
        decisionNote: input.note ?? null,
      })
      .where(
        and(
          eq(leaveRequests.tenantId, ctx.tenantId ?? ''),
          eq(leaveRequests.id, id),
          eq(leaveRequests.status, 'pending'),
        ),
      )
      .returning();
    const row = rows[0];
    // A concurrent second decision finds no pending row: the compare-and-set
    // above makes the transition single-shot rather than last-write-wins.
    if (!row) {
      throw new HttpError('Leave request has already been decided', {
        status: 409,
        code: 'leave_already_decided',
      });
    }

    await writeAudit(tx, {
      scope: 'tenant',
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action: decision === 'approved' ? 'leave.approved' : 'leave.rejected',
      resourceType: 'leave_request',
      resourceId: row.id,
      oldValue: { status: before.status, approverUserId: before.approverUserId },
      newValue: { status: row.status, approverUserId: row.approverUserId, decisionAt: row.decisionAt?.toISOString() ?? null },
      requestId,
    });
    await enqueueOutbox(tx, {
      tenantId: ctx.tenantId,
      eventType: decision === 'approved' ? 'leave.approved' : 'leave.rejected',
      aggregateType: 'leave_request',
      aggregateId: row.id,
      payload: { tenantId: ctx.tenantId, leaveRequestId: row.id, studentId: row.studentId },
      correlationId: requestId,
    });
    return toLeaveRequest(row);
  } catch (err) {
    throw mapDomainError(err);
  }
}

// ------------------------------------------------------------------ routes

export default async function leaveRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------- leave types
  app.get(
    '/api/v1/leave-types',
    {
      config: { authorization: { kind: 'tenant', permission: 'attendance.read' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('attendance.read')],
    },
    async (request) => {
      const ctx = request.ctx!;
      const query = leaveTypeListQuerySchema.parse(request.query);
      const conditions = [eq(leaveTypes.tenantId, ctx.tenantId ?? ''), isNull(leaveTypes.deletedAt)];
      if (query.status) conditions.push(eq(leaveTypes.status, query.status));
      const rows = await withTenant(app.db, ctx, (tx) =>
        tx
          .select()
          .from(leaveTypes)
          .where(and(...conditions))
          .orderBy(leaveTypes.code)
          .limit(query.limit)
          .offset(query.offset)
          .execute(),
      );
      const totalRow = await withTenant(app.db, ctx, (tx) =>
        tx.select({ total: count() }).from(leaveTypes).where(and(...conditions)).execute(),
      );
      return { items: rows.map(toLeaveType), total: totalRow[0]?.total ?? 0 };
    },
  );

  app.post(
    '/api/v1/leave-types',
    {
      config: { authorization: { kind: 'tenant', permission: 'attendance.mark' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('attendance.mark'), requireCsrf()],
    },
    async (request, reply) => {
      const ctx = request.ctx!;
      const body = createLeaveTypeRequestSchema.parse(request.body);
      const idemKey = idempotencyKeyFromHeader(request.headers);
      const fingerprint = requestFingerprint(request.method, request.url, body);
      const outcome = await withTenant(app.db, ctx, (tx) =>
        withIdempotency(tx, { tenantId: ctx.tenantId, key: idemKey }, fingerprint, async () => {
          const row = await createLeaveType(tx, ctx, body, request.requestId);
          return { status: 201, body: { leaveType: row } };
        }),
      );
      return reply.code(outcome.status).send(outcome.body);
    },
  );

  app.patch(
    '/api/v1/leave-types/:id',
    {
      config: { authorization: { kind: 'tenant', permission: 'attendance.mark' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('attendance.mark'), requireCsrf()],
    },
    async (request, reply) => {
      const ctx = request.ctx!;
      const { id } = request.params as { id: string };
      const body = updateLeaveTypeRequestSchema.parse(request.body);
      const idemKey = idempotencyKeyFromHeader(request.headers);
      const fingerprint = requestFingerprint(request.method, request.url, body);
      const outcome = await withTenant(app.db, ctx, (tx) =>
        withIdempotency(tx, { tenantId: ctx.tenantId, key: idemKey }, fingerprint, async () => {
          const row = await updateLeaveType(tx, ctx, id, body, request.requestId);
          if (!row) throw notFoundError('Leave type not found');
          return { status: 200, body: { leaveType: row } };
        }),
      );
      return reply.code(outcome.status).send(outcome.body);
    },
  );

  // ----------------------------------------------------------- leave requests
  /**
   * Read visibility is the SAME relationship ladder as attendance: staff see
   * every request, a teacher sees their own students, a parent sees the requests
   * of the students they are a guardian of, a student sees their own. This is
   * the roadmap's "parent sees only own children" guarantee expressed in SQL
   * rather than in the UI.
   */
  app.get(
    '/api/v1/leave-requests',
    {
      config: { authorization: { kind: 'tenant', permission: 'attendance.read' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('attendance.read')],
    },
    async (request) => {
      const ctx = request.ctx!;
      const query = leaveRequestListQuerySchema.parse(request.query);
      const codes = await withTenant(app.db, ctx, (tx) => tenantRoleCodes(tx, ctx));
      const allowed = await withTenant(app.db, ctx, (tx) =>
        readableStudentIds(tx, ctx, attendanceVisibility(codes)),
      );
      if (allowed !== null && allowed.length === 0) return { items: [], total: 0 };

      const conditions = [
        eq(leaveRequests.tenantId, ctx.tenantId ?? ''),
        isNull(leaveRequests.deletedAt),
      ];
      if (allowed !== null) conditions.push(inArray(leaveRequests.studentId, allowed as string[]));
      if (query.studentId) conditions.push(eq(leaveRequests.studentId, query.studentId));
      if (query.status) conditions.push(eq(leaveRequests.status, query.status));

      const rows = await withTenant(app.db, ctx, (tx) =>
        tx
          .select()
          .from(leaveRequests)
          .where(and(...conditions))
          .orderBy(desc(leaveRequests.startDate), leaveRequests.id)
          .limit(query.limit)
          .offset(query.offset)
          .execute(),
      );
      const totalRow = await withTenant(app.db, ctx, (tx) =>
        tx.select({ total: count() }).from(leaveRequests).where(and(...conditions)).execute(),
      );
      return { items: rows.map(toLeaveRequest), total: totalRow[0]?.total ?? 0 };
    },
  );

  app.post(
    '/api/v1/leave-requests',
    {
      config: { authorization: { kind: 'tenant', permission: 'attendance.request_leave' } },
      preHandler: [
        requireSession(),
        requireTenantContext(),
        requirePermission('attendance.request_leave'),
        requireCsrf(),
      ],
    },
    async (request, reply) => {
      const ctx = request.ctx!;
      const body = createLeaveRequestSchema.parse(request.body);
      const idemKey = idempotencyKeyFromHeader(request.headers);
      const fingerprint = requestFingerprint(request.method, request.url, body);
      const outcome = await withTenant(app.db, ctx, (tx) =>
        withIdempotency(tx, { tenantId: ctx.tenantId, key: idemKey }, fingerprint, async () => {
          const codes = await tenantRoleCodes(tx, ctx);
          const row = await createLeaveRequest(tx, ctx, codes, body, request.requestId);
          return { status: 201, body: { leaveRequest: row } };
        }),
      );
      return reply.code(outcome.status).send(outcome.body);
    },
  );

  app.post(
    '/api/v1/leave-requests/:id/approve',
    {
      config: { authorization: { kind: 'tenant', permission: 'attendance.approve_leave' } },
      preHandler: [
        requireSession(),
        requireTenantContext(),
        requirePermission('attendance.approve_leave'),
        requireCsrf(),
      ],
    },
    async (request, reply) => {
      const ctx = request.ctx!;
      const { id } = request.params as { id: string };
      const body = decideLeaveRequestSchema.parse(request.body ?? {});
      const idemKey = idempotencyKeyFromHeader(request.headers);
      const fingerprint = requestFingerprint(request.method, request.url, body);
      const outcome = await withTenant(app.db, ctx, (tx) =>
        withIdempotency(tx, { tenantId: ctx.tenantId, key: idemKey }, fingerprint, async () => {
          const codes = await tenantRoleCodes(tx, ctx);
          const row = await decideLeaveRequest(tx, ctx, codes, id, 'approved', body, request.requestId);
          return { status: 200, body: { leaveRequest: row } };
        }),
      );
      return reply.code(outcome.status).send(outcome.body);
    },
  );

  app.post(
    '/api/v1/leave-requests/:id/reject',
    {
      config: { authorization: { kind: 'tenant', permission: 'attendance.approve_leave' } },
      preHandler: [
        requireSession(),
        requireTenantContext(),
        requirePermission('attendance.approve_leave'),
        requireCsrf(),
      ],
    },
    async (request, reply) => {
      const ctx = request.ctx!;
      const { id } = request.params as { id: string };
      const body = decideLeaveRequestSchema.parse(request.body ?? {});
      const idemKey = idempotencyKeyFromHeader(request.headers);
      const fingerprint = requestFingerprint(request.method, request.url, body);
      const outcome = await withTenant(app.db, ctx, (tx) =>
        withIdempotency(tx, { tenantId: ctx.tenantId, key: idemKey }, fingerprint, async () => {
          const codes = await tenantRoleCodes(tx, ctx);
          const row = await decideLeaveRequest(tx, ctx, codes, id, 'rejected', body, request.requestId);
          return { status: 200, body: { leaveRequest: row } };
        }),
      );
      return reply.code(outcome.status).send(outcome.body);
    },
  );
}
