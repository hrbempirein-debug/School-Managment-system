import type { FastifyInstance } from 'fastify';
import { and, count, desc, eq, isNull } from 'drizzle-orm';
import { holidays, withTenant, type Tx } from '@sms/db';
import { writeAudit } from '@sms/audit';
import { enqueueOutbox } from '@sms/events';
import { requestFingerprint, withIdempotency } from '@sms/idempotency';
import {
  createHolidayRequestSchema,
  updateHolidayRequestSchema,
  idParamSchema,
  type Holiday,
} from '@sms/contracts';
import {
  requireSession,
  requireTenantContext,
  requirePermission,
  requireCsrf,
} from '../../plugins/auth.js';
import { mapDomainError, parsePagination, idempotencyKeyFromHeader, notFoundError, assertCampusScope } from './util.js';

type HolidayRow = typeof holidays.$inferSelect;

export function toHoliday(row: HolidayRow): Holiday {
  return {
    id: row.id,
    tenantId: row.tenantId,
    campusId: row.campusId,
    name: row.name,
    startsOn: row.startsOn,
    endsOn: row.endsOn,
    status: 'active',
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export interface HolidayWriteInput {
  name?: string;
  startsOn?: string;
  endsOn?: string;
  campusId?: string;
}

export async function insertHoliday(
  tx: Tx,
  ctx: { userId: string; tenantId: string | null },
  input: Required<Omit<HolidayWriteInput, 'campusId'>> & { campusId?: string },
  requestId: string,
): Promise<HolidayRow> {
  try {
    const rows = await tx
      .insert(holidays)
      .values({
        tenantId: ctx.tenantId ?? '',
        name: input.name,
        startsOn: input.startsOn,
        endsOn: input.endsOn,
        campusId: input.campusId ?? null,
      })
      .returning();
    const row = rows[0]!;
    await writeAudit(tx, {
      scope: 'tenant',
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action: 'holiday.created',
      resourceType: 'holiday',
      resourceId: row.id,
      newValue: toHoliday(row),
      requestId,
    });
    await enqueueOutbox(tx, {
      tenantId: ctx.tenantId,
      eventType: 'holiday.created',
      aggregateType: 'holiday',
      aggregateId: row.id,
      payload: { tenantId: ctx.tenantId, holidayId: row.id, name: row.name },
      correlationId: requestId,
    });
    return row;
  } catch (err) {
    throw mapDomainError(err);
  }
}

export async function updateHoliday(
  tx: Tx,
  ctx: { userId: string; tenantId: string | null },
  id: string,
  input: HolidayWriteInput,
  requestId: string,
): Promise<HolidayRow | null> {
  try {
    const beforeRows = await tx
      .select()
      .from(holidays)
      .where(and(eq(holidays.id, id), isNull(holidays.deletedAt)))
      .limit(1);
    const rows = await tx
      .update(holidays)
      .set(input)
      .where(and(eq(holidays.id, id), isNull(holidays.deletedAt)))
      .returning();
    const row = rows[0];
    if (!row) return null;
    await writeAudit(tx, {
      scope: 'tenant',
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action: 'holiday.updated',
      resourceType: 'holiday',
      resourceId: row.id,
      oldValue: beforeRows[0] ? toHoliday(beforeRows[0]) : undefined,
      newValue: toHoliday(row),
      requestId,
    });
    await enqueueOutbox(tx, {
      tenantId: ctx.tenantId,
      eventType: 'holiday.updated',
      aggregateType: 'holiday',
      aggregateId: row.id,
      payload: { tenantId: ctx.tenantId, holidayId: row.id, name: row.name },
      correlationId: requestId,
    });
    return row;
  } catch (err) {
    throw mapDomainError(err);
  }
}

export async function deleteHoliday(
  tx: Tx,
  ctx: { userId: string; tenantId: string | null },
  id: string,
  requestId: string,
): Promise<boolean> {
  try {
    const beforeRows = await tx
      .select()
      .from(holidays)
      .where(and(eq(holidays.id, id), isNull(holidays.deletedAt)))
      .limit(1);
    const rows = await tx
      .update(holidays)
      .set({ deletedAt: new Date() })
      .where(and(eq(holidays.id, id), isNull(holidays.deletedAt)))
      .returning();
    if (rows.length === 0) return false;
    const before = beforeRows[0]!;
    await writeAudit(tx, {
      scope: 'tenant',
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action: 'holiday.deleted',
      resourceType: 'holiday',
      resourceId: id,
      oldValue: toHoliday(before),
      requestId,
    });
    await enqueueOutbox(tx, {
      tenantId: ctx.tenantId,
      eventType: 'holiday.deleted',
      aggregateType: 'holiday',
      aggregateId: id,
      payload: { tenantId: ctx.tenantId, holidayId: id },
      correlationId: requestId,
    });
    return true;
  } catch (err) {
    throw mapDomainError(err);
  }
}

export default async function holidaysRoutes(app: FastifyInstance) {
  app.get(
    '/api/v1/holidays',
    {
      config: { authorization: { kind: 'tenant', permission: 'calendar.read' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('calendar.read')],
    },
    async (request) => {
      const ctx = request.ctx!;
      const { limit, offset } = parsePagination(request.query);
      const rows = await withTenant(app.db, ctx, (tx) =>
        tx
          .select()
          .from(holidays)
          .where(and(eq(holidays.tenantId, ctx.tenantId ?? ''), isNull(holidays.deletedAt)))
          .orderBy(desc(holidays.startsOn))
          .limit(limit)
          .offset(offset)
          .execute(),
      );
      const totalRow = await withTenant(app.db, ctx, (tx) =>
        tx
          .select({ total: count() })
          .from(holidays)
          .where(and(eq(holidays.tenantId, ctx.tenantId ?? ''), isNull(holidays.deletedAt)))
          .execute(),
      );
      return { items: rows.map(toHoliday), total: totalRow[0]?.total ?? 0 };
    },
  );

  app.post(
    '/api/v1/holidays',
    {
      config: { authorization: { kind: 'tenant', permission: 'calendar.write' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('calendar.write'), requireCsrf()],
    },
    async (request, reply) => {
      const body = createHolidayRequestSchema.parse(request.body);
      const ctx = request.ctx!;
      assertCampusScope(ctx, body.campusId ?? null);
      const idemKey = idempotencyKeyFromHeader(request.headers);
      const fingerprint = requestFingerprint(request.method, request.url, body);
      const outcome = await withTenant(app.db, ctx, (tx) =>
        withIdempotency(tx, { tenantId: ctx.tenantId, key: idemKey }, fingerprint, async () => {
          const row = await insertHoliday(tx, ctx, body, request.requestId);
          return { status: 201, body: { holiday: toHoliday(row) } };
        }),
      );
      return reply.code(outcome.status).send(outcome.body);
    },
  );

  app.get(
    '/api/v1/holidays/:id',
    {
      config: { authorization: { kind: 'tenant', permission: 'calendar.read' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('calendar.read')],
    },
    async (request) => {
      const { id } = idParamSchema.parse(request.params);
      const ctx = request.ctx!;
      const row = await withTenant(app.db, ctx, (tx) =>
        tx
          .select()
          .from(holidays)
          .where(and(eq(holidays.id, id), isNull(holidays.deletedAt)))
          .limit(1)
          .execute()
          .then((r) => r[0]),
      );
      if (!row) throw notFoundError('Holiday not found');
      return { holiday: toHoliday(row) };
    },
  );

  app.patch(
    '/api/v1/holidays/:id',
    {
      config: { authorization: { kind: 'tenant', permission: 'calendar.write' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('calendar.write'), requireCsrf()],
    },
    async (request, reply) => {
      const { id } = idParamSchema.parse(request.params);
      const body = updateHolidayRequestSchema.parse(request.body);
      const ctx = request.ctx!;
      const current = await withTenant(app.db, ctx, (tx) =>
        tx
          .select({ campusId: holidays.campusId })
          .from(holidays)
          .where(and(eq(holidays.id, id), isNull(holidays.deletedAt)))
          .limit(1)
          .execute()
          .then((r) => r[0]),
      );
      if (!current) throw notFoundError('Holiday not found');
      assertCampusScope(ctx, body.campusId ?? current.campusId);
      const idemKey = idempotencyKeyFromHeader(request.headers);
      const fingerprint = requestFingerprint(request.method, request.url, body);
      const outcome = await withTenant(app.db, ctx, (tx) =>
        withIdempotency(tx, { tenantId: ctx.tenantId, key: idemKey }, fingerprint, async () => {
          const row = await updateHoliday(tx, ctx, id, body, request.requestId);
          if (!row) throw notFoundError('Holiday not found');
          return { status: 200, body: { holiday: toHoliday(row) } };
        }),
      );
      return reply.code(outcome.status).send(outcome.body);
    },
  );

  app.delete(
    '/api/v1/holidays/:id',
    {
      config: { authorization: { kind: 'tenant', permission: 'calendar.write' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('calendar.write'), requireCsrf()],
    },
    async (request, reply) => {
      const { id } = idParamSchema.parse(request.params);
      const ctx = request.ctx!;
      const current = await withTenant(app.db, ctx, (tx) =>
        tx
          .select({ campusId: holidays.campusId })
          .from(holidays)
          .where(and(eq(holidays.id, id), isNull(holidays.deletedAt)))
          .limit(1)
          .execute()
          .then((r) => r[0]),
      );
      if (!current) throw notFoundError('Holiday not found');
      assertCampusScope(ctx, current.campusId);
      const deleted = await withTenant(app.db, ctx, (tx) => deleteHoliday(tx, ctx, id, request.requestId));
      if (!deleted) throw notFoundError('Holiday not found');
      return reply.code(204).send();
    },
  );
}