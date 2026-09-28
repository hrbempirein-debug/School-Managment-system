import type { FastifyInstance } from 'fastify';
import { and, count, desc, eq, isNull } from 'drizzle-orm';
import { academicYears, acdClasses, campuses, gradeLevels, withTenant, type Tx } from '@sms/db';
import { writeAudit } from '@sms/audit';
import { enqueueOutbox } from '@sms/events';
import { requestFingerprint, withIdempotency } from '@sms/idempotency';
import {
  classListQuerySchema,
  createClassRequestSchema,
  idParamSchema,
  updateClassRequestSchema,
  type AcdClass,
} from '@sms/contracts';
import {
  requireSession,
  requireTenantContext,
  requirePermission,
  requireCsrf,
} from '../../plugins/auth.js';
import {
  mapDomainError,
  parsePagination,
  idempotencyKeyFromHeader,
  notFoundError,
  assertCampusScope,
} from './util.js';

type ClassRow = typeof acdClasses.$inferSelect;

export function toClass(row: ClassRow): AcdClass {
  return {
    id: row.id,
    tenantId: row.tenantId,
    campusId: row.campusId,
    academicYearId: row.academicYearId,
    gradeLevelId: row.gradeLevelId ?? null,
    code: row.code,
    name: row.name,
    status: row.status as AcdClass['status'],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export interface ClassWriteInput {
  code?: string;
  name?: string;
}

/**
 * Insert a class. campusId/academicYearId/gradeLevelId are create-only (see
 * contract notes); parents are pre-checked so a bad campus/year/grade is a
 * deterministic 404 rather than a bare 23503. Campus-scoped members may only
 * create classes on their own campus (AUTHORIZATION.md §4).
 */
export async function insertClass(
  tx: Tx,
  ctx: { userId: string; tenantId: string | null; campusId: string | null },
  input: {
    campusId: string;
    academicYearId: string;
    gradeLevelId?: string;
    code: string;
    name: string;
  },
  requestId: string,
): Promise<ClassRow> {
  try {
    assertCampusScope(ctx, input.campusId);
    const campus = await tx
      .select({ id: campuses.id })
      .from(campuses)
      .where(and(eq(campuses.tenantId, ctx.tenantId ?? ''), eq(campuses.id, input.campusId), isNull(campuses.deletedAt)))
      .limit(1)
      .execute()
      .then((r) => r[0]);
    if (!campus) throw notFoundError('Campus not found');
    const year = await tx
      .select({ id: academicYears.id })
      .from(academicYears)
      .where(and(eq(academicYears.tenantId, ctx.tenantId ?? ''), eq(academicYears.id, input.academicYearId), isNull(academicYears.deletedAt)))
      .limit(1)
      .execute()
      .then((r) => r[0]);
    if (!year) throw notFoundError('Academic year not found');
    if (input.gradeLevelId) {
      const grade = await tx
        .select({ id: gradeLevels.id })
        .from(gradeLevels)
        .where(
          and(
            eq(gradeLevels.tenantId, ctx.tenantId ?? ''),
            eq(gradeLevels.id, input.gradeLevelId),
            isNull(gradeLevels.deletedAt),
          ),
        )
        .limit(1)
        .execute()
        .then((r) => r[0]);
      if (!grade) throw notFoundError('Grade level not found');
    }

    const rows = await tx
      .insert(acdClasses)
      .values({
        tenantId: ctx.tenantId ?? '',
        campusId: input.campusId,
        academicYearId: input.academicYearId,
        gradeLevelId: input.gradeLevelId ?? null,
        code: input.code,
        name: input.name,
        status: 'active',
      })
      .returning();
    const row = rows[0]!;
    await writeAudit(tx, {
      scope: 'tenant',
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action: 'class.created',
      resourceType: 'class',
      resourceId: row.id,
      newValue: toClass(row),
      requestId,
    });
    await enqueueOutbox(tx, {
      tenantId: ctx.tenantId,
      eventType: 'class.created',
      aggregateType: 'class',
      aggregateId: row.id,
      payload: {
        tenantId: ctx.tenantId,
        classId: row.id,
        campusId: row.campusId,
        academicYearId: row.academicYearId,
        code: row.code,
      },
      correlationId: requestId,
    });
    return row;
  } catch (err) {
    throw mapDomainError(err);
  }
}

export async function updateClass(
  tx: Tx,
  ctx: { userId: string; tenantId: string | null; campusId: string | null },
  id: string,
  input: ClassWriteInput,
  requestId: string,
): Promise<ClassRow | null> {
  try {
    const beforeRows = await tx
      .select()
      .from(acdClasses)
      .where(and(eq(acdClasses.tenantId, ctx.tenantId ?? ''), eq(acdClasses.id, id), isNull(acdClasses.deletedAt)))
      .limit(1)
      .execute();
    const before = beforeRows[0];
    if (!before) return null;
    assertCampusScope(ctx, before.campusId);

    const rows = await tx
      .update(acdClasses)
      .set(input)
      .where(and(eq(acdClasses.tenantId, ctx.tenantId ?? ''), eq(acdClasses.id, id), isNull(acdClasses.deletedAt)))
      .returning();
    const row = rows[0];
    if (!row) return null;
    await writeAudit(tx, {
      scope: 'tenant',
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action: 'class.updated',
      resourceType: 'class',
      resourceId: row.id,
      oldValue: toClass(before),
      newValue: toClass(row),
      requestId,
    });
    await enqueueOutbox(tx, {
      tenantId: ctx.tenantId,
      eventType: 'class.updated',
      aggregateType: 'class',
      aggregateId: row.id,
      payload: { tenantId: ctx.tenantId, classId: row.id, code: row.code, name: row.name },
      correlationId: requestId,
    });
    return row;
  } catch (err) {
    throw mapDomainError(err);
  }
}

export async function setClassStatus(
  tx: Tx,
  ctx: { userId: string; tenantId: string | null; campusId: string | null },
  id: string,
  status: 'active' | 'inactive',
  requestId: string,
): Promise<ClassRow | null> {
  try {
    const beforeRows = await tx
      .select()
      .from(acdClasses)
      .where(and(eq(acdClasses.tenantId, ctx.tenantId ?? ''), eq(acdClasses.id, id), isNull(acdClasses.deletedAt)))
      .limit(1)
      .execute();
    const before = beforeRows[0];
    if (!before) return null;
    assertCampusScope(ctx, before.campusId);

    const rows = await tx
      .update(acdClasses)
      .set({ status })
      .where(and(eq(acdClasses.tenantId, ctx.tenantId ?? ''), eq(acdClasses.id, id), isNull(acdClasses.deletedAt)))
      .returning();
    const row = rows[0];
    if (!row) return null;
    await writeAudit(tx, {
      scope: 'tenant',
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action: status === 'active' ? 'class.activated' : 'class.deactivated',
      resourceType: 'class',
      resourceId: row.id,
      newValue: { status },
      requestId,
    });
    await enqueueOutbox(tx, {
      tenantId: ctx.tenantId,
      eventType: status === 'active' ? 'class.activated' : 'class.deactivated',
      aggregateType: 'class',
      aggregateId: row.id,
      payload: { tenantId: ctx.tenantId, classId: row.id, status },
      correlationId: requestId,
    });
    return row;
  } catch (err) {
    throw mapDomainError(err);
  }
}

/**
 * Soft-delete a class. The DB guard (trg_acd_classes_delete_guard, BEFORE
 * UPDATE) rejects this while live sections or live enrollments reference it —
 * those surface as the documented 409 codes via mapDomainError.
 */
export async function deleteClass(
  tx: Tx,
  ctx: { userId: string; tenantId: string | null; campusId: string | null },
  id: string,
  requestId: string,
): Promise<ClassRow | null> {
  try {
    const beforeRows = await tx
      .select()
      .from(acdClasses)
      .where(and(eq(acdClasses.tenantId, ctx.tenantId ?? ''), eq(acdClasses.id, id), isNull(acdClasses.deletedAt)))
      .limit(1)
      .execute();
    const before = beforeRows[0];
    if (!before) return null;
    assertCampusScope(ctx, before.campusId);

    const rows = await tx
      .update(acdClasses)
      .set({ deletedAt: new Date() })
      .where(and(eq(acdClasses.tenantId, ctx.tenantId ?? ''), eq(acdClasses.id, id), isNull(acdClasses.deletedAt)))
      .returning();
    const row = rows[0];
    if (!row) return null;
    await writeAudit(tx, {
      scope: 'tenant',
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action: 'class.deleted',
      resourceType: 'class',
      resourceId: row.id,
      oldValue: toClass(before),
      newValue: { deletedAt: row.deletedAt?.toISOString() ?? null },
      requestId,
    });
    await enqueueOutbox(tx, {
      tenantId: ctx.tenantId,
      eventType: 'class.deleted',
      aggregateType: 'class',
      aggregateId: row.id,
      payload: { tenantId: ctx.tenantId, classId: row.id },
      correlationId: requestId,
    });
    return row;
  } catch (err) {
    throw mapDomainError(err);
  }
}

export default async function classRoutes(app: FastifyInstance) {
  app.get(
    '/api/v1/classes',
    {
      config: { authorization: { kind: 'tenant', permission: 'classes.read' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('classes.read')],
    },
    async (request) => {
      const ctx = request.ctx!;
      const query = classListQuerySchema.parse(request.query);
      const conditions = [eq(acdClasses.tenantId, ctx.tenantId ?? ''), isNull(acdClasses.deletedAt)];
      if (query.campusId) conditions.push(eq(acdClasses.campusId, query.campusId));
      if (query.academicYearId) conditions.push(eq(acdClasses.academicYearId, query.academicYearId));
      if (query.status) conditions.push(eq(acdClasses.status, query.status));
      const rows = await withTenant(app.db, ctx, (tx) =>
        tx
          .select()
          .from(acdClasses)
          .where(and(...conditions))
          .orderBy(desc(acdClasses.createdAt), desc(acdClasses.id))
          .limit(query.limit)
          .offset(query.offset)
          .execute(),
      );
      const totalRow = await withTenant(app.db, ctx, (tx) =>
        tx
          .select({ total: count() })
          .from(acdClasses)
          .where(and(...conditions))
          .execute(),
      );
      return { items: rows.map(toClass), total: totalRow[0]?.total ?? 0 };
    },
  );

  app.post(
    '/api/v1/classes',
    {
      config: { authorization: { kind: 'tenant', permission: 'classes.create' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('classes.create'), requireCsrf()],
    },
    async (request, reply) => {
      const body = createClassRequestSchema.parse(request.body);
      const ctx = request.ctx!;
      const idemKey = idempotencyKeyFromHeader(request.headers);
      const fingerprint = requestFingerprint(request.method, request.url, body);
      const outcome = await withTenant(app.db, ctx, (tx) =>
        withIdempotency(tx, { tenantId: ctx.tenantId, key: idemKey }, fingerprint, async () => {
          const row = await insertClass(tx, ctx, body, request.requestId);
          return { status: 201, body: { class: toClass(row) } };
        }),
      );
      return reply.code(outcome.status).send(outcome.body);
    },
  );

  app.get(
    '/api/v1/classes/:id',
    {
      config: { authorization: { kind: 'tenant', permission: 'classes.read' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('classes.read')],
    },
    async (request) => {
      const { id } = idParamSchema.parse(request.params);
      const ctx = request.ctx!;
      const row = await withTenant(app.db, ctx, (tx) =>
        tx
          .select()
          .from(acdClasses)
          .where(and(eq(acdClasses.tenantId, ctx.tenantId ?? ''), eq(acdClasses.id, id), isNull(acdClasses.deletedAt)))
          .limit(1)
          .execute()
          .then((r) => r[0]),
      );
      if (!row) throw notFoundError('Class not found');
      return { class: toClass(row) };
    },
  );

  app.patch(
    '/api/v1/classes/:id',
    {
      config: { authorization: { kind: 'tenant', permission: 'classes.update' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('classes.update'), requireCsrf()],
    },
    async (request, reply) => {
      const { id } = idParamSchema.parse(request.params);
      const body = updateClassRequestSchema.parse(request.body);
      const ctx = request.ctx!;
      const idemKey = idempotencyKeyFromHeader(request.headers);
      const fingerprint = requestFingerprint(request.method, request.url, body);
      const outcome = await withTenant(app.db, ctx, (tx) =>
        withIdempotency(tx, { tenantId: ctx.tenantId, key: idemKey }, fingerprint, async () => {
          const row = await updateClass(tx, ctx, id, body, request.requestId);
          if (!row) throw notFoundError('Class not found');
          return { status: 200, body: { class: toClass(row) } };
        }),
      );
      return reply.code(outcome.status).send(outcome.body);
    },
  );

  app.post(
    '/api/v1/classes/:id/activate',
    {
      config: { authorization: { kind: 'tenant', permission: 'classes.update' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('classes.update'), requireCsrf()],
    },
    async (request, reply) => {
      const { id } = idParamSchema.parse(request.params);
      const ctx = request.ctx!;
      const row = await withTenant(app.db, ctx, (tx) => setClassStatus(tx, ctx, id, 'active', request.requestId));
      if (!row) throw notFoundError('Class not found');
      return { class: toClass(row) };
    },
  );

  app.post(
    '/api/v1/classes/:id/deactivate',
    {
      config: { authorization: { kind: 'tenant', permission: 'classes.update' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('classes.update'), requireCsrf()],
    },
    async (request, reply) => {
      const { id } = idParamSchema.parse(request.params);
      const ctx = request.ctx!;
      const row = await withTenant(app.db, ctx, (tx) => setClassStatus(tx, ctx, id, 'inactive', request.requestId));
      if (!row) throw notFoundError('Class not found');
      return { class: toClass(row) };
    },
  );

  app.delete(
    '/api/v1/classes/:id',
    {
      config: { authorization: { kind: 'tenant', permission: 'classes.delete' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('classes.delete'), requireCsrf()],
    },
    async (request, reply) => {
      const { id } = idParamSchema.parse(request.params);
      const ctx = request.ctx!;
      const idemKey = idempotencyKeyFromHeader(request.headers);
      const fingerprint = requestFingerprint(request.method, request.url, {});
      const outcome = await withTenant(app.db, ctx, (tx) =>
        withIdempotency(tx, { tenantId: ctx.tenantId, key: idemKey }, fingerprint, async () => {
          const row = await deleteClass(tx, ctx, id, request.requestId);
          if (!row) throw notFoundError('Class not found');
          return { status: 200, body: { class: toClass(row) } };
        }),
      );
      return reply.code(outcome.status).send(outcome.body);
    },
  );
}