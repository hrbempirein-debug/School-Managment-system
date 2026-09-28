import type { FastifyInstance } from 'fastify';
import { and, asc, count, desc, eq, isNull, sql } from 'drizzle-orm';
import { campuses, guardians, students, studentGuardians, withTenant, type Tx } from '@sms/db';
import { writeAudit } from '@sms/audit';
import { enqueueOutbox } from '@sms/events';
import { requestFingerprint, withIdempotency } from '@sms/idempotency';
import { createStudentGuardianRequestSchema, createStudentRequestSchema, idParamSchema, studentGuardianParamSchema, studentListQuerySchema, updateStudentRequestSchema, type Guardian, type Student, type StudentGuardianLink } from '@sms/contracts';
import {
  requireSession,
  requireTenantContext,
  requirePermission,
  requireCsrf,
} from '../../plugins/auth.js';
import { mapDomainError, parsePagination, idempotencyKeyFromHeader, notFoundError, assertCampusScope } from './util.js';

type StudentRow = typeof students.$inferSelect;
type GuardianRow = typeof guardians.$inferSelect;

const nameExpr = sql`(${students.firstName} || ' ' || ${students.lastName})`;

export function toStudent(row: StudentRow): Student {
  return {
    id: row.id,
    tenantId: row.tenantId,
    studentNo: row.studentNo,
    firstName: row.firstName,
    lastName: row.lastName,
    dateOfBirth: row.dateOfBirth,
    gender: row.gender as Student['gender'],
    status: row.status as Student['status'],
    primaryCampusId: row.primaryCampusId,
    userId: row.userId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toGuardian(row: GuardianRow): Guardian {
  return {
    id: row.id,
    tenantId: row.tenantId,
    userId: row.userId,
    firstName: row.firstName,
    lastName: row.lastName,
    email: row.email,
    phone: row.phone,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export interface StudentWriteInput {
  studentNo?: string;
  firstName?: string;
  lastName?: string;
  dateOfBirth?: string | null;
  gender?: string | null;
  /** Portal account link (migration 0013): a live membership user in this tenant,
   * or null to clear the link. Only reachable via a students.update holder. */
  userId?: string | null;
}

export interface StudentCreateInput {
  studentNo: string;
  firstName: string;
  lastName: string;
  dateOfBirth?: string | null;
  gender?: string | null;
  primaryCampusId?: string | null;
}

export async function insertStudent(
  tx: Tx,
  ctx: { userId: string; tenantId: string | null },
  input: StudentCreateInput,
  requestId: string,
): Promise<StudentRow> {
  try {
    const rows = await tx
      .insert(students)
      .values({
        tenantId: ctx.tenantId ?? '',
        studentNo: input.studentNo,
        firstName: input.firstName,
        lastName: input.lastName,
        dateOfBirth: input.dateOfBirth ?? null,
        gender: input.gender ?? null,
        status: 'applicant',
        primaryCampusId: input.primaryCampusId ?? null,
      })
      .returning();
    const row = rows[0]!;
    await writeAudit(tx, {
      scope: 'tenant',
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action: 'student.created',
      resourceType: 'student',
      resourceId: row.id,
      newValue: toStudent(row),
      requestId,
    });
    await enqueueOutbox(tx, {
      tenantId: ctx.tenantId,
      eventType: 'student.created',
      aggregateType: 'student',
      aggregateId: row.id,
      payload: { tenantId: ctx.tenantId, studentId: row.id, studentNo: row.studentNo, status: row.status },
      correlationId: requestId,
    });
    return row;
  } catch (err) {
    throw mapDomainError(err);
  }
}

export async function updateStudent(
  tx: Tx,
  ctx: { userId: string; tenantId: string | null },
  id: string,
  input: StudentWriteInput,
  requestId: string,
): Promise<StudentRow | null> {
  try {
    const beforeRows = await tx
      .select()
      .from(students)
      .where(and(eq(students.id, id), isNull(students.deletedAt)))
      .limit(1);
    const rows = await tx
      .update(students)
      .set({
        studentNo: input.studentNo,
        firstName: input.firstName,
        lastName: input.lastName,
        dateOfBirth: input.dateOfBirth,
        gender: input.gender,
        userId: input.userId,
      })
      .where(and(eq(students.id, id), isNull(students.deletedAt)))
      .returning();
    const row = rows[0];
    if (!row) return null;
    await writeAudit(tx, {
      scope: 'tenant',
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action: 'student.updated',
      resourceType: 'student',
      resourceId: row.id,
      oldValue: beforeRows[0] ? toStudent(beforeRows[0]) : undefined,
      newValue: toStudent(row),
      requestId,
    });
    return row;
  } catch (err) {
    throw mapDomainError(err);
  }
}

export async function deleteStudent(
  tx: Tx,
  ctx: { userId: string; tenantId: string | null },
  id: string,
  requestId: string,
): Promise<boolean> {
  try {
    const beforeRows = await tx
      .select()
      .from(students)
      .where(and(eq(students.id, id), isNull(students.deletedAt)))
      .limit(1);
    const rows = await tx
      .update(students)
      .set({ deletedAt: new Date() })
      .where(and(eq(students.id, id), isNull(students.deletedAt)))
      .returning();
    if (rows.length === 0) return false;
    const before = beforeRows[0]!;
    await writeAudit(tx, {
      scope: 'tenant',
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action: 'student.deleted',
      resourceType: 'student',
      resourceId: id,
      oldValue: toStudent(before),
      requestId,
    });
    return true;
  } catch (err) {
    throw mapDomainError(err);
  }
}

export interface LinkInput {
  guardianId: string;
  relation: string;
  isPrimary: boolean;
  canPickup: boolean;
}

export async function linkGuardian(
  tx: Tx,
  ctx: { userId: string; tenantId: string | null },
  studentId: string,
  input: Omit<LinkInput, 'isPrimary' | 'canPickup'> & Partial<Pick<LinkInput, 'isPrimary' | 'canPickup'>>,
  requestId: string,
): Promise<{ link: typeof studentGuardians.$inferSelect; guardian: GuardianRow }> {
  try {
    const insertion = await tx
      .insert(studentGuardians)
      .values({
        tenantId: ctx.tenantId ?? '',
        studentId,
        guardianId: input.guardianId,
        relation: input.relation,
        isPrimary: input.isPrimary ?? false,
        canPickup: input.canPickup ?? false,
      })
      .returning();
    const link = insertion[0]!;
    const guardianRows = await tx
      .select()
      .from(guardians)
      .where(and(eq(guardians.tenantId, ctx.tenantId ?? ''), eq(guardians.id, input.guardianId)))
      .limit(1)
      .execute();
    const guardian = guardianRows[0]!;
    await writeAudit(tx, {
      scope: 'tenant',
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action: 'student.guardian.linked',
      resourceType: 'student_guardian',
      resourceId: link.id,
      newValue: { studentId, guardianId: input.guardianId, relation: input.relation },
      requestId,
    });
    return { link, guardian };
  } catch (err) {
    throw mapDomainError(err);
  }
}

export async function unlinkGuardian(
  tx: Tx,
  ctx: { userId: string; tenantId: string | null },
  studentId: string,
  guardianId: string,
  requestId: string,
): Promise<boolean> {
  try {
    const beforeRows = await tx
      .select()
      .from(studentGuardians)
      .where(
        and(
          eq(studentGuardians.tenantId, ctx.tenantId ?? ''),
          eq(studentGuardians.studentId, studentId),
          eq(studentGuardians.guardianId, guardianId),
          isNull(studentGuardians.deletedAt),
        ),
      )
      .limit(1);
    const rows = await tx
      .update(studentGuardians)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(studentGuardians.tenantId, ctx.tenantId ?? ''),
          eq(studentGuardians.studentId, studentId),
          eq(studentGuardians.guardianId, guardianId),
          isNull(studentGuardians.deletedAt),
        ),
      )
      .returning();
    if (rows.length === 0) return false;
    const before = beforeRows[0]!;
    await writeAudit(tx, {
      scope: 'tenant',
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action: 'student.guardian.unlinked',
      resourceType: 'student_guardian',
      resourceId: before.id,
      oldValue: { studentId, guardianId, relation: before.relation },
      requestId,
    });
    return true;
  } catch (err) {
    throw mapDomainError(err);
  }
}

type LinkRow = typeof studentGuardians.$inferSelect;

export function toLink(link: LinkRow, guardian: GuardianRow): StudentGuardianLink {
  return {
    id: link.id,
    studentId: link.studentId,
    guardianId: link.guardianId,
    relation: link.relation as StudentGuardianLink['relation'],
    isPrimary: link.isPrimary,
    canPickup: link.canPickup,
    guardian: toGuardian(guardian),
    createdAt: link.createdAt.toISOString(),
    updatedAt: link.updatedAt.toISOString(),
  };
}

export default async function studentsRoutes(app: FastifyInstance) {
  app.get(
    '/api/v1/students',
    {
      config: { authorization: { kind: 'tenant', permission: 'students.read' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('students.read')],
    },
    async (request) => {
      const ctx = request.ctx!;
      const query = studentListQuerySchema.parse(request.query);
      const conditions = [
        eq(students.tenantId, ctx.tenantId ?? ''),
        isNull(students.deletedAt),
      ];
      if (query.q) {
        conditions.push(sql`${nameExpr} ILIKE ${`%${query.q}%`}`);
      }
      if (query.status) {
        conditions.push(eq(students.status, query.status));
      }
      // A campus-scoped member only ever sees their own campus; the optional
      // client campusId filter is honoured only for school-wide members.
      const campusFilter = ctx.campusId ?? query.campusId;
      if (campusFilter) {
        conditions.push(eq(students.primaryCampusId, campusFilter));
      }
      const rows = await withTenant(app.db, ctx, (tx) =>
        tx
          .select()
          .from(students)
          .where(and(...conditions))
          .orderBy(desc(students.createdAt), asc(students.id))
          .limit(query.limit)
          .offset(query.offset)
          .execute(),
      );
      const totalRow = await withTenant(app.db, ctx, (tx) =>
        tx
          .select({ total: count() })
          .from(students)
          .where(and(...conditions))
          .execute(),
      );
      return { items: rows.map(toStudent), total: totalRow[0]?.total ?? 0 };
    },
  );

  app.post(
    '/api/v1/students',
    {
      config: { authorization: { kind: 'tenant', permission: 'students.create' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('students.create'), requireCsrf()],
    },
    async (request, reply) => {
      const body = createStudentRequestSchema.parse(request.body);
      const ctx = request.ctx!;
      // Campus scope: a campus-scoped member may only create a student on their
      // own campus (NULL primary_campus_id is a school-wide target, never theirs);
      // school-wide members may optionally attach a campus for the student.
      assertCampusScope(ctx, body.primaryCampusId ?? null);
      if (body.primaryCampusId) {
        const campus = await withTenant(app.db, ctx, (tx) =>
          tx
            .select({ id: campuses.id })
            .from(campuses)
            .where(and(eq(campuses.tenantId, ctx.tenantId ?? ''), eq(campuses.id, body.primaryCampusId!)))
            .limit(1)
            .execute()
            .then((r) => r[0]),
        );
        if (!campus) throw notFoundError('Campus not found');
      }
      const idemKey = idempotencyKeyFromHeader(request.headers);
      const fingerprint = requestFingerprint(request.method, request.url, body);
      const outcome = await withTenant(app.db, ctx, (tx) =>
        withIdempotency(tx, { tenantId: ctx.tenantId, key: idemKey }, fingerprint, async () => {
          const row = await insertStudent(tx, ctx, body, request.requestId);
          return { status: 201, body: { student: toStudent(row) } };
        }),
      );
      return reply.code(outcome.status).send(outcome.body);
    },
  );

  app.get(
    '/api/v1/students/:id',
    {
      config: { authorization: { kind: 'tenant', permission: 'students.read' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('students.read')],
    },
    async (request) => {
      const { id } = idParamSchema.parse(request.params);
      const ctx = request.ctx!;
      const row = await withTenant(app.db, ctx, (tx) =>
        tx
          .select()
          .from(students)
          .where(and(eq(students.id, id), isNull(students.deletedAt)))
          .limit(1)
          .execute()
          .then((r) => r[0]),
      );
      if (!row) throw notFoundError('Student not found');
      // Campus-scoped reads only surface the member's own campus.
      if (ctx.campusId && row.primaryCampusId !== ctx.campusId) {
        throw notFoundError('Student not found');
      }
      return { student: toStudent(row) };
    },
  );

  app.patch(
    '/api/v1/students/:id',
    {
      config: { authorization: { kind: 'tenant', permission: 'students.update' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('students.update'), requireCsrf()],
    },
    async (request, reply) => {
      const { id } = idParamSchema.parse(request.params);
      const body = updateStudentRequestSchema.parse(request.body);
      const ctx = request.ctx!;
      const current = await withTenant(app.db, ctx, (tx) =>
        tx
          .select({ primaryCampusId: students.primaryCampusId })
          .from(students)
          .where(and(eq(students.id, id), isNull(students.deletedAt)))
          .limit(1)
          .execute()
          .then((r) => r[0]),
      );
      if (!current) throw notFoundError('Student not found');
      assertCampusScope(ctx, current.primaryCampusId);
      const idemKey = idempotencyKeyFromHeader(request.headers);
      const fingerprint = requestFingerprint(request.method, request.url, body);
      const outcome = await withTenant(app.db, ctx, (tx) =>
        withIdempotency(tx, { tenantId: ctx.tenantId, key: idemKey }, fingerprint, async () => {
          const row = await updateStudent(tx, ctx, id, body, request.requestId);
          if (!row) throw notFoundError('Student not found');
          return { status: 200, body: { student: toStudent(row) } };
        }),
      );
      return reply.code(outcome.status).send(outcome.body);
    },
  );

  app.delete(
    '/api/v1/students/:id',
    {
      config: { authorization: { kind: 'tenant', permission: 'students.delete' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('students.delete'), requireCsrf()],
    },
    async (request, reply) => {
      const { id } = idParamSchema.parse(request.params);
      const ctx = request.ctx!;
      const current = await withTenant(app.db, ctx, (tx) =>
        tx
          .select({ primaryCampusId: students.primaryCampusId })
          .from(students)
          .where(and(eq(students.id, id), isNull(students.deletedAt)))
          .limit(1)
          .execute()
          .then((r) => r[0]),
      );
      if (!current) throw notFoundError('Student not found');
      assertCampusScope(ctx, current.primaryCampusId);
      const deleted = await withTenant(app.db, ctx, (tx) => deleteStudent(tx, ctx, id, request.requestId));
      if (!deleted) throw notFoundError('Student not found');
      return reply.code(204).send();
    },
  );

  app.get(
    '/api/v1/students/:id/guardians',
    {
      config: { authorization: { kind: 'tenant', permission: 'students.read' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('students.read')],
    },
    async (request) => {
      const { id } = idParamSchema.parse(request.params);
      const ctx = request.ctx!;
      const student = await withTenant(app.db, ctx, (tx) =>
        tx
          .select({ primaryCampusId: students.primaryCampusId })
          .from(students)
          .where(and(eq(students.id, id), isNull(students.deletedAt)))
          .limit(1)
          .execute()
          .then((r) => r[0]),
      );
      if (!student) throw notFoundError('Student not found');
      if (ctx.campusId && student.primaryCampusId !== ctx.campusId) {
        throw notFoundError('Student not found');
      }
      const { limit, offset } = parsePagination(request.query);
      const rows = await withTenant(app.db, ctx, (tx) =>
        tx
          .select()
          .from(studentGuardians)
          .innerJoin(guardians, eq(guardians.id, studentGuardians.guardianId))
          .where(
            and(
              eq(studentGuardians.tenantId, ctx.tenantId ?? ''),
              eq(studentGuardians.studentId, id),
              isNull(studentGuardians.deletedAt),
              isNull(guardians.deletedAt),
            ),
          )
          .orderBy(desc(studentGuardians.createdAt))
          .limit(limit)
          .offset(offset)
          .execute(),
      );
      const totalRow = await withTenant(app.db, ctx, (tx) =>
        tx
          .select({ total: count() })
          .from(studentGuardians)
          .innerJoin(guardians, eq(guardians.id, studentGuardians.guardianId))
          .where(
            and(
              eq(studentGuardians.tenantId, ctx.tenantId ?? ''),
              eq(studentGuardians.studentId, id),
              isNull(studentGuardians.deletedAt),
              isNull(guardians.deletedAt),
            ),
          )
          .execute(),
      );
      return {
        items: rows.map((r) => toLink(r.student_guardians, r.guardians)),
        total: totalRow[0]?.total ?? 0,
      };
    },
  );

  app.post(
    '/api/v1/students/:id/guardians',
    {
      config: { authorization: { kind: 'tenant', permission: 'students.update' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('students.update'), requireCsrf()],
    },
    async (request, reply) => {
      const { id } = idParamSchema.parse(request.params);
      const body = createStudentGuardianRequestSchema.parse(request.body);
      const ctx = request.ctx!;
      const student = await withTenant(app.db, ctx, (tx) =>
        tx
          .select({ primaryCampusId: students.primaryCampusId })
          .from(students)
          .where(and(eq(students.id, id), isNull(students.deletedAt)))
          .limit(1)
          .execute()
          .then((r) => r[0]),
      );
      if (!student) throw notFoundError('Student not found');
      assertCampusScope(ctx, student.primaryCampusId);
      const guardian = await withTenant(app.db, ctx, (tx) =>
        tx
          .select()
          .from(guardians)
          .where(and(eq(guardians.tenantId, ctx.tenantId ?? ''), eq(guardians.id, body.guardianId), isNull(guardians.deletedAt)))
          .limit(1)
          .execute()
          .then((r) => r[0]),
      );
      if (!guardian) throw notFoundError('Guardian not found');
      const idemKey = idempotencyKeyFromHeader(request.headers);
      const fingerprint = requestFingerprint(request.method, request.url, body);
      const outcome = await withTenant(app.db, ctx, (tx) =>
        withIdempotency(tx, { tenantId: ctx.tenantId, key: idemKey }, fingerprint, async () => {
          const { link } = await linkGuardian(tx, ctx, id, body, request.requestId);
          return { status: 201, body: { link: toLink(link, guardian) } };
        }),
      );
      return reply.code(outcome.status).send(outcome.body);
    },
  );

  app.delete(
    '/api/v1/students/:id/guardians/:guardianId',
    {
      config: { authorization: { kind: 'tenant', permission: 'students.update' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('students.update'), requireCsrf()],
    },
    async (request, reply) => {
      const { id, guardianId } = studentGuardianParamSchema.parse(request.params);
      const ctx = request.ctx!;
      const student = await withTenant(app.db, ctx, (tx) =>
        tx
          .select({ primaryCampusId: students.primaryCampusId })
          .from(students)
          .where(and(eq(students.id, id), isNull(students.deletedAt)))
          .limit(1)
          .execute()
          .then((r) => r[0]),
      );
      if (!student) throw notFoundError('Student not found');
      assertCampusScope(ctx, student.primaryCampusId);
      const unlinked = await withTenant(app.db, ctx, (tx) =>
        unlinkGuardian(tx, ctx, id, guardianId, request.requestId),
      );
      if (!unlinked) throw notFoundError('Guardian link not found');
      return reply.code(204).send();
    },
  );
}