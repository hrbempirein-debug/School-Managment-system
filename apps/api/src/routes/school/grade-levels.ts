import type { FastifyInstance } from 'fastify';
import { and, count, desc, eq, isNull } from 'drizzle-orm';
import { gradeLevels, withTenant, type Tx } from '@sms/db';
import { writeAudit } from '@sms/audit';
import { enqueueOutbox } from '@sms/events';
import { requestFingerprint, withIdempotency } from '@sms/idempotency';
import {
  createGradeLevelRequestSchema,
  gradeLevelListQuerySchema,
  idParamSchema,
  updateGradeLevelRequestSchema,
  type GradeLevel,
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
} from './util.js';

type GradeLevelRow = typeof gradeLevels.$inferSelect;

export function toGradeLevel(row: GradeLevelRow): GradeLevel {
  return {
    id: row.id,
    tenantId: row.tenantId,
    code: row.code,
    name: row.name,
    status: row.status as GradeLevel['status'],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export interface GradeLevelWriteInput {
  code?: string;
  name?: string;
}

/**
 * Insert a grade level (tenant-wide catalog; school-wide — no campus scope
 * applies, matching academic years). Code uniqueness is tenant-wide among live
 * rows (grade_levels_tenant_code_uq).
 */
export async function insertGradeLevel(
  tx: Tx,
  ctx: { userId: string; tenantId: string | null; campusId: string | null },
  input: { code: string; name: string },
  requestId: string,
): Promise<GradeLevelRow> {
  try {
    const rows = await tx
      .insert(gradeLevels)
      .values({
        tenantId: ctx.tenantId ?? '',
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
      action: 'grade.level.created',
      resourceType: 'grade_level',
      resourceId: row.id,
      newValue: toGradeLevel(row),
      requestId,
    });
    await enqueueOutbox(tx, {
      tenantId: ctx.tenantId,
      eventType: 'grade.level.created',
      aggregateType: 'grade_level',
      aggregateId: row.id,
      payload: { tenantId: ctx.tenantId, gradeLevelId: row.id, code: row.code, name: row.name },
      correlationId: requestId,
    });
    return row;
  } catch (err) {
    throw mapDomainError(err);
  }
}

export async function updateGradeLevel(
  tx: Tx,
  ctx: { userId: string; tenantId: string | null; campusId: string | null },
  id: string,
  input: GradeLevelWriteInput,
  requestId: string,
): Promise<GradeLevelRow | null> {
  try {
    const beforeRows = await tx
      .select()
      .from(gradeLevels)
      .where(and(eq(gradeLevels.tenantId, ctx.tenantId ?? ''), eq(gradeLevels.id, id), isNull(gradeLevels.deletedAt)))
      .limit(1)
      .execute();
    const before = beforeRows[0];
    if (!before) return null;

    const rows = await tx
      .update(gradeLevels)
      .set(input)
      .where(and(eq(gradeLevels.tenantId, ctx.tenantId ?? ''), eq(gradeLevels.id, id), isNull(gradeLevels.deletedAt)))
      .returning();
    const row = rows[0];
    if (!row) return null;
    await writeAudit(tx, {
      scope: 'tenant',
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action: 'grade.level.updated',
      resourceType: 'grade_level',
      resourceId: row.id,
      oldValue: toGradeLevel(before),
      newValue: toGradeLevel(row),
      requestId,
    });
    await enqueueOutbox(tx, {
      tenantId: ctx.tenantId,
      eventType: 'grade.level.updated',
      aggregateType: 'grade_level',
      aggregateId: row.id,
      payload: { tenantId: ctx.tenantId, gradeLevelId: row.id, code: row.code, name: row.name },
      correlationId: requestId,
    });
    return row;
  } catch (err) {
    throw mapDomainError(err);
  }
}

export async function setGradeLevelStatus(
  tx: Tx,
  ctx: { userId: string; tenantId: string | null; campusId: string | null },
  id: string,
  status: 'active' | 'inactive',
  requestId: string,
): Promise<GradeLevelRow | null> {
  try {
    const beforeRows = await tx
      .select()
      .from(gradeLevels)
      .where(and(eq(gradeLevels.tenantId, ctx.tenantId ?? ''), eq(gradeLevels.id, id), isNull(gradeLevels.deletedAt)))
      .limit(1)
      .execute();
    const before = beforeRows[0];
    if (!before) return null;

    const rows = await tx
      .update(gradeLevels)
      .set({ status })
      .where(and(eq(gradeLevels.tenantId, ctx.tenantId ?? ''), eq(gradeLevels.id, id), isNull(gradeLevels.deletedAt)))
      .returning();
    const row = rows[0];
    if (!row) return null;
    await writeAudit(tx, {
      scope: 'tenant',
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action: status === 'active' ? 'grade.level.activated' : 'grade.level.deactivated',
      resourceType: 'grade_level',
      resourceId: row.id,
      newValue: { status },
      requestId,
    });
    await enqueueOutbox(tx, {
      tenantId: ctx.tenantId,
      eventType: status === 'active' ? 'grade.level.activated' : 'grade.level.deactivated',
      aggregateType: 'grade_level',
      aggregateId: row.id,
      payload: { tenantId: ctx.tenantId, gradeLevelId: row.id, status },
      correlationId: requestId,
    });
    return row;
  } catch (err) {
    throw mapDomainError(err);
  }
}

/**
 * Soft-delete a grade level. The DB guard (trg_grade_levels_delete_guard)
 * rejects this while any LIVE class references the grade — surfaces as the
 * documented 409 `grade_level_has_classes`.
 */
export async function deleteGradeLevel(
  tx: Tx,
  ctx: { userId: string; tenantId: string | null; campusId: string | null },
  id: string,
  requestId: string,
): Promise<GradeLevelRow | null> {
  try {
    const beforeRows = await tx
      .select()
      .from(gradeLevels)
      .where(and(eq(gradeLevels.tenantId, ctx.tenantId ?? ''), eq(gradeLevels.id, id), isNull(gradeLevels.deletedAt)))
      .limit(1)
      .execute();
    const before = beforeRows[0];
    if (!before) return null;

    const rows = await tx
      .update(gradeLevels)
      .set({ deletedAt: new Date() })
      .where(and(eq(gradeLevels.tenantId, ctx.tenantId ?? ''), eq(gradeLevels.id, id), isNull(gradeLevels.deletedAt)))
      .returning();
    const row = rows[0];
    if (!row) return null;
    await writeAudit(tx, {
      scope: 'tenant',
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action: 'grade.level.deleted',
      resourceType: 'grade_level',
      resourceId: row.id,
      oldValue: toGradeLevel(before),
      newValue: { deletedAt: row.deletedAt?.toISOString() ?? null },
      requestId,
    });
    await enqueueOutbox(tx, {
      tenantId: ctx.tenantId,
      eventType: 'grade.level.deleted',
      aggregateType: 'grade_level',
      aggregateId: row.id,
      payload: { tenantId: ctx.tenantId, gradeLevelId: row.id },
      correlationId: requestId,
    });
    return row;
  } catch (err) {
    throw mapDomainError(err);
  }
}

export default async function gradeLevelRoutes(app: FastifyInstance) {
  app.get(
    '/api/v1/grade-levels',
    {
      config: { authorization: { kind: 'tenant', permission: 'grade.levels.read' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('grade.levels.read')],
    },
    async (request) => {
      const ctx = request.ctx!;
      const query = gradeLevelListQuerySchema.parse(request.query);
      const conditions = [eq(gradeLevels.tenantId, ctx.tenantId ?? ''), isNull(gradeLevels.deletedAt)];
      if (query.status) conditions.push(eq(gradeLevels.status, query.status));
      const rows = await withTenant(app.db, ctx, (tx) =>
        tx
          .select()
          .from(gradeLevels)
          .where(and(...conditions))
          .orderBy(desc(gradeLevels.createdAt), desc(gradeLevels.id))
          .limit(query.limit)
          .offset(query.offset)
          .execute(),
      );
      const totalRow = await withTenant(app.db, ctx, (tx) =>
        tx
          .select({ total: count() })
          .from(gradeLevels)
          .where(and(...conditions))
          .execute(),
      );
      return { items: rows.map(toGradeLevel), total: totalRow[0]?.total ?? 0 };
    },
  );

  app.post(
    '/api/v1/grade-levels',
    {
      config: { authorization: { kind: 'tenant', permission: 'grade.levels.create' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('grade.levels.create'), requireCsrf()],
    },
    async (request, reply) => {
      const body = createGradeLevelRequestSchema.parse(request.body);
      const ctx = request.ctx!;
      const idemKey = idempotencyKeyFromHeader(request.headers);
      const fingerprint = requestFingerprint(request.method, request.url, body);
      const outcome = await withTenant(app.db, ctx, (tx) =>
        withIdempotency(tx, { tenantId: ctx.tenantId, key: idemKey }, fingerprint, async () => {
          const row = await insertGradeLevel(tx, ctx, body, request.requestId);
          return { status: 201, body: { gradeLevel: toGradeLevel(row) } };
        }),
      );
      return reply.code(outcome.status).send(outcome.body);
    },
  );

  app.get(
    '/api/v1/grade-levels/:id',
    {
      config: { authorization: { kind: 'tenant', permission: 'grade.levels.read' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('grade.levels.read')],
    },
    async (request) => {
      const { id } = idParamSchema.parse(request.params);
      const ctx = request.ctx!;
      const row = await withTenant(app.db, ctx, (tx) =>
        tx
          .select()
          .from(gradeLevels)
          .where(and(eq(gradeLevels.tenantId, ctx.tenantId ?? ''), eq(gradeLevels.id, id), isNull(gradeLevels.deletedAt)))
          .limit(1)
          .execute()
          .then((r) => r[0]),
      );
      if (!row) throw notFoundError('Grade level not found');
      return { gradeLevel: toGradeLevel(row) };
    },
  );

  app.patch(
    '/api/v1/grade-levels/:id',
    {
      config: { authorization: { kind: 'tenant', permission: 'grade.levels.update' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('grade.levels.update'), requireCsrf()],
    },
    async (request, reply) => {
      const { id } = idParamSchema.parse(request.params);
      const body = updateGradeLevelRequestSchema.parse(request.body);
      const ctx = request.ctx!;
      const idemKey = idempotencyKeyFromHeader(request.headers);
      const fingerprint = requestFingerprint(request.method, request.url, body);
      const outcome = await withTenant(app.db, ctx, (tx) =>
        withIdempotency(tx, { tenantId: ctx.tenantId, key: idemKey }, fingerprint, async () => {
          const row = await updateGradeLevel(tx, ctx, id, body, request.requestId);
          if (!row) throw notFoundError('Grade level not found');
          return { status: 200, body: { gradeLevel: toGradeLevel(row) } };
        }),
      );
      return reply.code(outcome.status).send(outcome.body);
    },
  );

  app.post(
    '/api/v1/grade-levels/:id/activate',
    {
      config: { authorization: { kind: 'tenant', permission: 'grade.levels.update' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('grade.levels.update'), requireCsrf()],
    },
    async (request, reply) => {
      const { id } = idParamSchema.parse(request.params);
      const ctx = request.ctx!;
      const row = await withTenant(app.db, ctx, (tx) =>
        setGradeLevelStatus(tx, ctx, id, 'active', request.requestId),
      );
      if (!row) throw notFoundError('Grade level not found');
      return { gradeLevel: toGradeLevel(row) };
    },
  );

  app.post(
    '/api/v1/grade-levels/:id/deactivate',
    {
      config: { authorization: { kind: 'tenant', permission: 'grade.levels.update' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('grade.levels.update'), requireCsrf()],
    },
    async (request, reply) => {
      const { id } = idParamSchema.parse(request.params);
      const ctx = request.ctx!;
      const row = await withTenant(app.db, ctx, (tx) =>
        setGradeLevelStatus(tx, ctx, id, 'inactive', request.requestId),
      );
      if (!row) throw notFoundError('Grade level not found');
      return { gradeLevel: toGradeLevel(row) };
    },
  );

  app.delete(
    '/api/v1/grade-levels/:id',
    {
      config: { authorization: { kind: 'tenant', permission: 'grade.levels.delete' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('grade.levels.delete'), requireCsrf()],
    },
    async (request, reply) => {
      const { id } = idParamSchema.parse(request.params);
      const ctx = request.ctx!;
      const idemKey = idempotencyKeyFromHeader(request.headers);
      const fingerprint = requestFingerprint(request.method, request.url, {});
      const outcome = await withTenant(app.db, ctx, (tx) =>
        withIdempotency(tx, { tenantId: ctx.tenantId, key: idemKey }, fingerprint, async () => {
          const row = await deleteGradeLevel(tx, ctx, id, request.requestId);
          if (!row) throw notFoundError('Grade level not found');
          return { status: 200, body: { gradeLevel: toGradeLevel(row) } };
        }),
      );
      return reply.code(outcome.status).send(outcome.body);
    },
  );
}