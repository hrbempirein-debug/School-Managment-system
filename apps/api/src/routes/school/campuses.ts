import type { FastifyInstance } from 'fastify';
import { and, count, desc, eq, isNull } from 'drizzle-orm';
import { campuses, withTenant, type Tx } from '@sms/db';
import { writeAudit } from '@sms/audit';
import { enqueueOutbox } from '@sms/events';
import { requestFingerprint, withIdempotency } from '@sms/idempotency';
import {
  createCampusRequestSchema,
  updateCampusRequestSchema,
  idParamSchema,
  type Campus,
} from '@sms/contracts';
import {
  requireSession,
  requireTenantContext,
  requirePermission,
  requireCsrf,
} from '../../plugins/auth.js';
import { mapDomainError, parsePagination, idempotencyKeyFromHeader, notFoundError } from './util.js';

type CampusRow = typeof campuses.$inferSelect;

export function toCampus(row: CampusRow): Campus {
  return {
    id: row.id,
    tenantId: row.tenantId,
    code: row.code,
    name: row.name,
    address: row.address,
    city: row.city,
    country: row.country,
    status: row.status as Campus['status'],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export interface CampusWriteInput {
  code?: string;
  name?: string;
  address?: string;
  city?: string;
  country?: string;
  status?: 'active' | 'inactive';
}

export async function insertCampus(
  tx: Tx,
  ctx: { userId: string; tenantId: string | null },
  input: CampusWriteInput,
  requestId: string,
): Promise<CampusRow> {
  try {
    const rows = await tx
      .insert(campuses)
      .values({
        tenantId: ctx.tenantId ?? '',
        code: input.code ?? '',
        name: input.name ?? '',
        address: input.address,
        city: input.city,
        country: input.country,
        status: input.status ?? 'active',
      })
      .returning();
    const row = rows[0]!;
    await writeAudit(tx, {
      scope: 'tenant',
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action: 'campus.created',
      resourceType: 'campus',
      resourceId: row.id,
      newValue: toCampus(row),
      requestId,
    });
    await enqueueOutbox(tx, {
      tenantId: ctx.tenantId,
      eventType: 'campus.created',
      aggregateType: 'campus',
      aggregateId: row.id,
      payload: { tenantId: ctx.tenantId, campusId: row.id, code: row.code },
      correlationId: requestId,
    });
    return row;
  } catch (err) {
    throw mapDomainError(err);
  }
}

export async function updateCampus(
  tx: Tx,
  ctx: { userId: string; tenantId: string | null },
  id: string,
  input: CampusWriteInput,
  requestId: string,
): Promise<CampusRow | null> {
  try {
    const beforeRows = await tx
      .select()
      .from(campuses)
      .where(and(eq(campuses.id, id), isNull(campuses.deletedAt)))
      .limit(1);
    const rows = await tx
      .update(campuses)
      .set(input)
      .where(and(eq(campuses.id, id), isNull(campuses.deletedAt)))
      .returning();
    const row = rows[0];
    if (!row) return null;
    await writeAudit(tx, {
      scope: 'tenant',
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action: 'campus.updated',
      resourceType: 'campus',
      resourceId: row.id,
      oldValue: beforeRows[0] ? toCampus(beforeRows[0]) : undefined,
      newValue: toCampus(row),
      requestId,
    });
    await enqueueOutbox(tx, {
      tenantId: ctx.tenantId,
      eventType: 'campus.updated',
      aggregateType: 'campus',
      aggregateId: row.id,
      payload: { tenantId: ctx.tenantId, campusId: row.id, code: row.code, status: row.status },
      correlationId: requestId,
    });
    return row;
  } catch (err) {
    throw mapDomainError(err);
  }
}

export async function setCampusStatus(
  tx: Tx,
  ctx: { userId: string; tenantId: string | null },
  id: string,
  status: 'active' | 'inactive',
  requestId: string,
): Promise<CampusRow | null> {
  try {
    const rows = await tx
      .update(campuses)
      .set({ status })
      .where(and(eq(campuses.id, id), isNull(campuses.deletedAt)))
      .returning();
    const row = rows[0];
    if (!row) return null;
    await writeAudit(tx, {
      scope: 'tenant',
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action: status === 'active' ? 'campus.activated' : 'campus.deactivated',
      resourceType: 'campus',
      resourceId: row.id,
      newValue: { status },
      requestId,
    });
    await enqueueOutbox(tx, {
      tenantId: ctx.tenantId,
      eventType: status === 'active' ? 'campus.activated' : 'campus.deactivated',
      aggregateType: 'campus',
      aggregateId: row.id,
      payload: { tenantId: ctx.tenantId, campusId: row.id, status },
      correlationId: requestId,
    });
    return row;
  } catch (err) {
    throw mapDomainError(err);
  }
}

export default async function campusesRoutes(app: FastifyInstance) {
  app.get(
    '/api/v1/campuses',
    {
      config: { authorization: { kind: 'tenant', permission: 'campus.read' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('campus.read')],
    },
    async (request) => {
      const ctx = request.ctx!;
      const { limit, offset } = parsePagination(request.query);
      const rows = await withTenant(app.db, ctx, (tx) =>
        tx
          .select()
          .from(campuses)
          .where(and(eq(campuses.tenantId, ctx.tenantId ?? ''), isNull(campuses.deletedAt)))
          .orderBy(desc(campuses.createdAt))
          .limit(limit)
          .offset(offset)
          .execute(),
      );
      const totalRow = await withTenant(app.db, ctx, (tx) =>
        tx
          .select({ total: count() })
          .from(campuses)
          .where(and(eq(campuses.tenantId, ctx.tenantId ?? ''), isNull(campuses.deletedAt)))
          .execute(),
      );
      return { items: rows.map(toCampus), total: totalRow[0]?.total ?? 0 };
    },
  );

  app.post(
    '/api/v1/campuses',
    {
      config: { authorization: { kind: 'tenant', permission: 'campus.create' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('campus.create'), requireCsrf()],
    },
    async (request, reply) => {
      const body = createCampusRequestSchema.parse(request.body);
      const ctx = request.ctx!;
      const idemKey = idempotencyKeyFromHeader(request.headers);
      const fingerprint = requestFingerprint(request.method, request.url, body);
      const outcome = await withTenant(app.db, ctx, (tx) =>
        withIdempotency(tx, { tenantId: ctx.tenantId, key: idemKey }, fingerprint, async () => {
          const row = await insertCampus(tx, ctx, { ...body, status: 'active' }, request.requestId);
          return { status: 201, body: { campus: toCampus(row) } };
        }),
      );
      return reply.code(outcome.status).send(outcome.body);
    },
  );

  app.get(
    '/api/v1/campuses/:id',
    {
      config: { authorization: { kind: 'tenant', permission: 'campus.read' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('campus.read')],
    },
    async (request, reply) => {
      const { id } = idParamSchema.parse(request.params);
      const ctx = request.ctx!;
      const row = await withTenant(app.db, ctx, (tx) =>
        tx
          .select()
          .from(campuses)
          .where(and(eq(campuses.id, id), isNull(campuses.deletedAt)))
          .limit(1)
          .execute()
          .then((r) => r[0]),
      );
      if (!row) throw notFoundError('Campus not found');
      return { campus: toCampus(row) };
    },
  );

  app.patch(
    '/api/v1/campuses/:id',
    {
      config: { authorization: { kind: 'tenant', permission: 'campus.update' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('campus.update'), requireCsrf()],
    },
    async (request, reply) => {
      const { id } = idParamSchema.parse(request.params);
      const body = updateCampusRequestSchema.parse(request.body);
      const ctx = request.ctx!;
      const idemKey = idempotencyKeyFromHeader(request.headers);
      const fingerprint = requestFingerprint(request.method, request.url, body);
      const outcome = await withTenant(app.db, ctx, (tx) =>
        withIdempotency(tx, { tenantId: ctx.tenantId, key: idemKey }, fingerprint, async () => {
          const row = await updateCampus(tx, ctx, id, body, request.requestId);
          if (!row) throw notFoundError('Campus not found');
          return { status: 200, body: { campus: toCampus(row) } };
        }),
      );
      return reply.code(outcome.status).send(outcome.body);
    },
  );

  app.post(
    '/api/v1/campuses/:id/activate',
    {
      config: { authorization: { kind: 'tenant', permission: 'campus.update' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('campus.update'), requireCsrf()],
    },
    async (request, reply) => {
      const { id } = idParamSchema.parse(request.params);
      const ctx = request.ctx!;
      const row = await withTenant(app.db, ctx, (tx) => setCampusStatus(tx, ctx, id, 'active', request.requestId));
      if (!row) throw notFoundError('Campus not found');
      return { campus: toCampus(row) };
    },
  );

  app.post(
    '/api/v1/campuses/:id/deactivate',
    {
      config: { authorization: { kind: 'tenant', permission: 'campus.update' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('campus.update'), requireCsrf()],
    },
    async (request, reply) => {
      const { id } = idParamSchema.parse(request.params);
      const ctx = request.ctx!;
      const row = await withTenant(app.db, ctx, (tx) => setCampusStatus(tx, ctx, id, 'inactive', request.requestId));
      if (!row) throw notFoundError('Campus not found');
      return { campus: toCampus(row) };
    },
  );
}