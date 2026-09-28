import type { FastifyInstance } from 'fastify';
import { and, count, desc, eq, isNull } from 'drizzle-orm';
import { calendars, withTenant, type Tx } from '@sms/db';
import { writeAudit } from '@sms/audit';
import { enqueueOutbox } from '@sms/events';
import { requestFingerprint, withIdempotency } from '@sms/idempotency';
import {
  createCalendarRequestSchema,
  updateCalendarRequestSchema,
  idParamSchema,
  type Calendar,
} from '@sms/contracts';
import {
  requireSession,
  requireTenantContext,
  requirePermission,
  requireCsrf,
} from '../../plugins/auth.js';
import { mapDomainError, parsePagination, idempotencyKeyFromHeader, notFoundError } from './util.js';

type CalendarRow = typeof calendars.$inferSelect;

export function toCalendar(row: CalendarRow): Calendar {
  return {
    id: row.id,
    tenantId: row.tenantId,
    code: row.code,
    name: row.name,
    type: row.type as Calendar['type'],
    status: row.status as Calendar['status'],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export interface CalendarWriteInput {
  code?: string;
  name?: string;
  type?: 'general' | 'academic';
  status?: 'active' | 'archived';
}

export async function insertCalendar(
  tx: Tx,
  ctx: { userId: string; tenantId: string | null },
  input: CalendarWriteInput,
  requestId: string,
): Promise<CalendarRow> {
  try {
    const rows = await tx
      .insert(calendars)
      .values({
        tenantId: ctx.tenantId ?? '',
        code: input.code ?? '',
        name: input.name ?? '',
        type: input.type ?? 'general',
        status: input.status ?? 'active',
      })
      .returning();
    const row = rows[0]!;
    await writeAudit(tx, {
      scope: 'tenant',
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action: 'calendar.created',
      resourceType: 'calendar',
      resourceId: row.id,
      newValue: toCalendar(row),
      requestId,
    });
    await enqueueOutbox(tx, {
      tenantId: ctx.tenantId,
      eventType: 'calendar.created',
      aggregateType: 'calendar',
      aggregateId: row.id,
      payload: { tenantId: ctx.tenantId, calendarId: row.id, code: row.code, type: row.type },
      correlationId: requestId,
    });
    return row;
  } catch (err) {
    throw mapDomainError(err);
  }
}

export async function updateCalendar(
  tx: Tx,
  ctx: { userId: string; tenantId: string | null },
  id: string,
  input: CalendarWriteInput,
  requestId: string,
): Promise<CalendarRow | null> {
  try {
    const beforeRows = await tx
      .select()
      .from(calendars)
      .where(and(eq(calendars.id, id), isNull(calendars.deletedAt)))
      .limit(1);
    const rows = await tx
      .update(calendars)
      .set(input)
      .where(and(eq(calendars.id, id), isNull(calendars.deletedAt)))
      .returning();
    const row = rows[0];
    if (!row) return null;
    await writeAudit(tx, {
      scope: 'tenant',
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action: 'calendar.updated',
      resourceType: 'calendar',
      resourceId: row.id,
      oldValue: beforeRows[0] ? toCalendar(beforeRows[0]) : undefined,
      newValue: toCalendar(row),
      requestId,
    });
    await enqueueOutbox(tx, {
      tenantId: ctx.tenantId,
      eventType: 'calendar.updated',
      aggregateType: 'calendar',
      aggregateId: row.id,
      payload: { tenantId: ctx.tenantId, calendarId: row.id, code: row.code },
      correlationId: requestId,
    });
    return row;
  } catch (err) {
    throw mapDomainError(err);
  }
}

export async function deleteCalendar(
  tx: Tx,
  ctx: { userId: string; tenantId: string | null },
  id: string,
  requestId: string,
): Promise<boolean> {
  try {
    const beforeRows = await tx
      .select()
      .from(calendars)
      .where(and(eq(calendars.id, id), isNull(calendars.deletedAt)))
      .limit(1);
    const rows = await tx
      .update(calendars)
      .set({ deletedAt: new Date() })
      .where(and(eq(calendars.id, id), isNull(calendars.deletedAt)))
      .returning();
    if (rows.length === 0) return false;
    const before = beforeRows[0]!;
    await writeAudit(tx, {
      scope: 'tenant',
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action: 'calendar.deleted',
      resourceType: 'calendar',
      resourceId: id,
      oldValue: toCalendar(before),
      requestId,
    });
    await enqueueOutbox(tx, {
      tenantId: ctx.tenantId,
      eventType: 'calendar.deleted',
      aggregateType: 'calendar',
      aggregateId: id,
      payload: { tenantId: ctx.tenantId, calendarId: id },
      correlationId: requestId,
    });
    return true;
  } catch (err) {
    throw mapDomainError(err);
  }
}

export default async function calendarsRoutes(app: FastifyInstance) {
  app.get(
    '/api/v1/calendars',
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
          .from(calendars)
          .where(and(eq(calendars.tenantId, ctx.tenantId ?? ''), isNull(calendars.deletedAt)))
          .orderBy(desc(calendars.createdAt))
          .limit(limit)
          .offset(offset)
          .execute(),
      );
      const totalRow = await withTenant(app.db, ctx, (tx) =>
        tx
          .select({ total: count() })
          .from(calendars)
          .where(and(eq(calendars.tenantId, ctx.tenantId ?? ''), isNull(calendars.deletedAt)))
          .execute(),
      );
      return { items: rows.map(toCalendar), total: totalRow[0]?.total ?? 0 };
    },
  );

  app.post(
    '/api/v1/calendars',
    {
      config: { authorization: { kind: 'tenant', permission: 'calendar.write' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('calendar.write'), requireCsrf()],
    },
    async (request, reply) => {
      const body = createCalendarRequestSchema.parse(request.body);
      const ctx = request.ctx!;
      const idemKey = idempotencyKeyFromHeader(request.headers);
      const fingerprint = requestFingerprint(request.method, request.url, body);
      const outcome = await withTenant(app.db, ctx, (tx) =>
        withIdempotency(tx, { tenantId: ctx.tenantId, key: idemKey }, fingerprint, async () => {
          const row = await insertCalendar(tx, ctx, body, request.requestId);
          return { status: 201, body: { calendar: toCalendar(row) } };
        }),
      );
      return reply.code(outcome.status).send(outcome.body);
    },
  );

  app.get(
    '/api/v1/calendars/:id',
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
          .from(calendars)
          .where(and(eq(calendars.id, id), isNull(calendars.deletedAt)))
          .limit(1)
          .execute()
          .then((r) => r[0]),
      );
      if (!row) throw notFoundError('Calendar not found');
      return { calendar: toCalendar(row) };
    },
  );

  app.patch(
    '/api/v1/calendars/:id',
    {
      config: { authorization: { kind: 'tenant', permission: 'calendar.write' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('calendar.write'), requireCsrf()],
    },
    async (request, reply) => {
      const { id } = idParamSchema.parse(request.params);
      const body = updateCalendarRequestSchema.parse(request.body);
      const ctx = request.ctx!;
      const idemKey = idempotencyKeyFromHeader(request.headers);
      const fingerprint = requestFingerprint(request.method, request.url, body);
      const outcome = await withTenant(app.db, ctx, (tx) =>
        withIdempotency(tx, { tenantId: ctx.tenantId, key: idemKey }, fingerprint, async () => {
          const row = await updateCalendar(tx, ctx, id, body, request.requestId);
          if (!row) throw notFoundError('Calendar not found');
          return { status: 200, body: { calendar: toCalendar(row) } };
        }),
      );
      return reply.code(outcome.status).send(outcome.body);
    },
  );

  app.delete(
    '/api/v1/calendars/:id',
    {
      config: { authorization: { kind: 'tenant', permission: 'calendar.write' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('calendar.write'), requireCsrf()],
    },
    async (request, reply) => {
      const { id } = idParamSchema.parse(request.params);
      const ctx = request.ctx!;
      const deleted = await withTenant(app.db, ctx, (tx) => deleteCalendar(tx, ctx, id, request.requestId));
      if (!deleted) throw notFoundError('Calendar not found');
      return reply.code(204).send();
    },
  );
}