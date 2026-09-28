import type { FastifyInstance } from 'fastify';
import { and, count, desc, eq, isNull } from 'drizzle-orm';
import { periods, withTenant, type Tx } from '@sms/db';
import { writeAudit } from '@sms/audit';
import { enqueueOutbox } from '@sms/events';
import { requestFingerprint, withIdempotency } from '@sms/idempotency';
import {
  createPeriodRequestSchema,
  idParamSchema,
  periodListQuerySchema,
  updatePeriodRequestSchema,
  type Period,
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

type PeriodRow = typeof periods.$inferSelect;

export function toPeriod(row: PeriodRow): Period {
  return {
    id: row.id,
    tenantId: row.tenantId,
    campusId: row.campusId,
    name: row.name,
    periodNo: row.periodNo,
    startTime: row.startTime,
    endTime: row.endTime,
    status: row.status as Period['status'],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export interface PeriodWriteInput {
  name?: string;
  periodNo?: number;
  startTime?: string;
  endTime?: string;
  campusId?: string | null;
}

/**
 * Insert a period (Phase 4.3). campusId null/omitted = the tenant-wide bell set;
 * otherwise the period belongs to a campus (composite FK pins the tenant). The DB
 * enforces period_no uniqueness per (tenant, campus) and refuses overlapping time
 * ranges via the gist exclusion constraint (23P01 -> 409 `period_time_overlap`).
 */
export async function insertPeriod(
  tx: Tx,
  ctx: { userId: string; tenantId: string | null; campusId: string | null },
  input: { name: string; periodNo: number; startTime: string; endTime: string; campusId?: string | null },
  requestId: string,
): Promise<PeriodRow> {
  try {
    const campusId = input.campusId ?? null;
    if (campusId) {
      assertCampusScope(ctx, campusId);
    } else {
      // Tenant-wide bell sets are school-wide resources: campus-scoped memberships
      // may not create them (assertCampusScope denies non-matching campuses).
      assertCampusScope(ctx, null);
    }
    const rows = await tx
      .insert(periods)
      .values({
        tenantId: ctx.tenantId ?? '',
        name: input.name,
        periodNo: input.periodNo,
        startTime: input.startTime,
        endTime: input.endTime,
        campusId,
        status: 'active',
      })
      .returning();
    const row = rows[0]!;
    await writeAudit(tx, {
      scope: 'tenant',
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action: 'period.created',
      resourceType: 'period',
      resourceId: row.id,
      newValue: toPeriod(row),
      requestId,
    });
    await enqueueOutbox(tx, {
      tenantId: ctx.tenantId,
      eventType: 'period.created',
      aggregateType: 'period',
      aggregateId: row.id,
      payload: {
        tenantId: ctx.tenantId,
        periodId: row.id,
        campusId: row.campusId,
        periodNo: row.periodNo,
        status: row.status,
      },
      correlationId: requestId,
    });
    return row;
  } catch (err) {
    throw mapDomainError(err);
  }
}

export async function updatePeriod(
  tx: Tx,
  ctx: { userId: string; tenantId: string | null; campusId: string | null },
  id: string,
  input: PeriodWriteInput,
  requestId: string,
): Promise<PeriodRow | null> {
  try {
    const beforeRows = await tx
      .select()
      .from(periods)
      .where(and(eq(periods.tenantId, ctx.tenantId ?? ''), eq(periods.id, id), isNull(periods.deletedAt)))
      .limit(1)
      .execute();
    const before = beforeRows[0];
    if (!before) return null;
    assertCampusScope(ctx, before.campusId);

    const set: Partial<PeriodRow> = {};
    if (input.name !== undefined) set.name = input.name;
    if (input.periodNo !== undefined) set.periodNo = input.periodNo;
    if (input.startTime !== undefined) set.startTime = input.startTime;
    if (input.endTime !== undefined) set.endTime = input.endTime;
    if (input.campusId !== undefined) {
      set.campusId = input.campusId;
      assertCampusScope(ctx, input.campusId ?? null);
    }
    const rows = await tx
      .update(periods)
      .set(set)
      .where(and(eq(periods.tenantId, ctx.tenantId ?? ''), eq(periods.id, id), isNull(periods.deletedAt)))
      .returning();
    const row = rows[0];
    if (!row) return null;
    await writeAudit(tx, {
      scope: 'tenant',
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action: 'period.updated',
      resourceType: 'period',
      resourceId: row.id,
      oldValue: toPeriod(before),
      newValue: toPeriod(row),
      requestId,
    });
    await enqueueOutbox(tx, {
      tenantId: ctx.tenantId,
      eventType: 'period.updated',
      aggregateType: 'period',
      aggregateId: row.id,
      payload: {
        tenantId: ctx.tenantId,
        periodId: row.id,
        periodNo: row.periodNo,
        startTime: row.startTime,
        endTime: row.endTime,
        status: row.status,
      },
      correlationId: requestId,
    });
    return row;
  } catch (err) {
    throw mapDomainError(err);
  }
}

export async function setPeriodStatus(
  tx: Tx,
  ctx: { userId: string; tenantId: string | null; campusId: string | null },
  id: string,
  status: 'active' | 'inactive',
  requestId: string,
): Promise<PeriodRow | null> {
  try {
    const beforeRows = await tx
      .select()
      .from(periods)
      .where(and(eq(periods.tenantId, ctx.tenantId ?? ''), eq(periods.id, id), isNull(periods.deletedAt)))
      .limit(1)
      .execute();
    const before = beforeRows[0];
    if (!before) return null;
    assertCampusScope(ctx, before.campusId);

    const rows = await tx
      .update(periods)
      .set({ status })
      .where(and(eq(periods.tenantId, ctx.tenantId ?? ''), eq(periods.id, id), isNull(periods.deletedAt)))
      .returning();
    const row = rows[0];
    if (!row) return null;
    await writeAudit(tx, {
      scope: 'tenant',
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action: 'period.updated',
      resourceType: 'period',
      resourceId: row.id,
      newValue: { status },
      requestId,
    });
    await enqueueOutbox(tx, {
      tenantId: ctx.tenantId,
      eventType: 'period.updated',
      aggregateType: 'period',
      aggregateId: row.id,
      payload: { tenantId: ctx.tenantId, periodId: row.id, status },
      correlationId: requestId,
    });
    return row;
  } catch (err) {
    throw mapDomainError(err);
  }
}

/**
 * Soft-delete a period. The DB guard refuses while LIVE timetable entries
 * reference the period (409 `period_has_entries`).
 */
export async function deletePeriod(
  tx: Tx,
  ctx: { userId: string; tenantId: string | null; campusId: string | null },
  id: string,
  requestId: string,
): Promise<PeriodRow | null> {
  try {
    const beforeRows = await tx
      .select()
      .from(periods)
      .where(and(eq(periods.tenantId, ctx.tenantId ?? ''), eq(periods.id, id), isNull(periods.deletedAt)))
      .limit(1)
      .execute();
    const before = beforeRows[0];
    if (!before) return null;
    assertCampusScope(ctx, before.campusId);

    const rows = await tx
      .update(periods)
      .set({ deletedAt: new Date() })
      .where(and(eq(periods.tenantId, ctx.tenantId ?? ''), eq(periods.id, id), isNull(periods.deletedAt)))
      .returning();
    const row = rows[0];
    if (!row) return null;
    await writeAudit(tx, {
      scope: 'tenant',
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action: 'period.deleted',
      resourceType: 'period',
      resourceId: row.id,
      oldValue: toPeriod(before),
      newValue: { deletedAt: row.deletedAt?.toISOString() ?? null },
      requestId,
    });
    await enqueueOutbox(tx, {
      tenantId: ctx.tenantId,
      eventType: 'period.deleted',
      aggregateType: 'period',
      aggregateId: row.id,
      payload: { tenantId: ctx.tenantId, periodId: row.id },
      correlationId: requestId,
    });
    return row;
  } catch (err) {
    throw mapDomainError(err);
  }
}

export default async function periodRoutes(app: FastifyInstance) {
  app.get(
    '/api/v1/periods',
    {
      config: { authorization: { kind: 'tenant', permission: 'timetable.read' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('timetable.read')],
    },
    async (request) => {
      const ctx = request.ctx!;
      const query = periodListQuerySchema.parse(request.query);
      const conditions = [eq(periods.tenantId, ctx.tenantId ?? ''), isNull(periods.deletedAt)];
      if (query.campusId) conditions.push(eq(periods.campusId, query.campusId));
      if (query.status) conditions.push(eq(periods.status, query.status));
      const rows = await withTenant(app.db, ctx, (tx) =>
        tx
          .select()
          .from(periods)
          .where(and(...conditions))
          .orderBy(periods.periodNo, desc(periods.id))
          .limit(query.limit)
          .offset(query.offset)
          .execute(),
      );
      const totalRow = await withTenant(app.db, ctx, (tx) =>
        tx
          .select({ total: count() })
          .from(periods)
          .where(and(...conditions))
          .execute(),
      );
      return { items: rows.map(toPeriod), total: totalRow[0]?.total ?? 0 };
    },
  );

  app.post(
    '/api/v1/periods',
    {
      config: { authorization: { kind: 'tenant', permission: 'timetable.manage' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('timetable.manage'), requireCsrf()],
    },
    async (request, reply) => {
      const body = createPeriodRequestSchema.parse(request.body);
      const ctx = request.ctx!;
      const idemKey = idempotencyKeyFromHeader(request.headers);
      const fingerprint = requestFingerprint(request.method, request.url, body);
      const outcome = await withTenant(app.db, ctx, (tx) =>
        withIdempotency(tx, { tenantId: ctx.tenantId, key: idemKey }, fingerprint, async () => {
          const row = await insertPeriod(tx, ctx, body, request.requestId);
          return { status: 201, body: { period: toPeriod(row) } };
        }),
      );
      return reply.code(outcome.status).send(outcome.body);
    },
  );

  app.get(
    '/api/v1/periods/:id',
    {
      config: { authorization: { kind: 'tenant', permission: 'timetable.read' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('timetable.read')],
    },
    async (request) => {
      const { id } = idParamSchema.parse(request.params);
      const ctx = request.ctx!;
      const row = await withTenant(app.db, ctx, (tx) =>
        tx
          .select()
          .from(periods)
          .where(and(eq(periods.tenantId, ctx.tenantId ?? ''), eq(periods.id, id), isNull(periods.deletedAt)))
          .limit(1)
          .execute()
          .then((r) => r[0]),
      );
      if (!row) throw notFoundError('Period not found');
      if (ctx.campusId && row.campusId !== ctx.campusId) throw notFoundError('Period not found');
      return { period: toPeriod(row) };
    },
  );

  app.patch(
    '/api/v1/periods/:id',
    {
      config: { authorization: { kind: 'tenant', permission: 'timetable.manage' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('timetable.manage'), requireCsrf()],
    },
    async (request, reply) => {
      const { id } = idParamSchema.parse(request.params);
      const body = updatePeriodRequestSchema.parse(request.body);
      const ctx = request.ctx!;
      const idemKey = idempotencyKeyFromHeader(request.headers);
      const fingerprint = requestFingerprint(request.method, request.url, body);
      const outcome = await withTenant(app.db, ctx, (tx) =>
        withIdempotency(tx, { tenantId: ctx.tenantId, key: idemKey }, fingerprint, async () => {
          const row = await updatePeriod(tx, ctx, id, body, request.requestId);
          if (!row) throw notFoundError('Period not found');
          return { status: 200, body: { period: toPeriod(row) } };
        }),
      );
      return reply.code(outcome.status).send(outcome.body);
    },
  );

  app.post(
    '/api/v1/periods/:id/activate',
    {
      config: { authorization: { kind: 'tenant', permission: 'timetable.manage' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('timetable.manage'), requireCsrf()],
    },
    async (request, reply) => {
      const { id } = idParamSchema.parse(request.params);
      const ctx = request.ctx!;
      const row = await withTenant(app.db, ctx, (tx) =>
        setPeriodStatus(tx, ctx, id, 'active', request.requestId),
      );
      if (!row) throw notFoundError('Period not found');
      return { period: toPeriod(row) };
    },
  );

  app.post(
    '/api/v1/periods/:id/deactivate',
    {
      config: { authorization: { kind: 'tenant', permission: 'timetable.manage' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('timetable.manage'), requireCsrf()],
    },
    async (request, reply) => {
      const { id } = idParamSchema.parse(request.params);
      const ctx = request.ctx!;
      const row = await withTenant(app.db, ctx, (tx) =>
        setPeriodStatus(tx, ctx, id, 'inactive', request.requestId),
      );
      if (!row) throw notFoundError('Period not found');
      return { period: toPeriod(row) };
    },
  );

  app.delete(
    '/api/v1/periods/:id',
    {
      config: { authorization: { kind: 'tenant', permission: 'timetable.manage' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('timetable.manage'), requireCsrf()],
    },
    async (request, reply) => {
      const { id } = idParamSchema.parse(request.params);
      const ctx = request.ctx!;
      const idemKey = idempotencyKeyFromHeader(request.headers);
      const fingerprint = requestFingerprint(request.method, request.url, {});
      const outcome = await withTenant(app.db, ctx, (tx) =>
        withIdempotency(tx, { tenantId: ctx.tenantId, key: idemKey }, fingerprint, async () => {
          const row = await deletePeriod(tx, ctx, id, request.requestId);
          if (!row) throw notFoundError('Period not found');
          return { status: 200, body: { period: toPeriod(row) } };
        }),
      );
      return reply.code(outcome.status).send(outcome.body);
    },
  );
}