import type { FastifyInstance } from 'fastify';
import { and, count, desc, eq, isNull } from 'drizzle-orm';
import { calendarEvents, calendars, withTenant, type Tx } from '@sms/db';
import { writeAudit } from '@sms/audit';
import { enqueueOutbox } from '@sms/events';
import { requestFingerprint, withIdempotency } from '@sms/idempotency';
import {
  createCalendarEventRequestSchema,
  updateCalendarEventRequestSchema,
  idParamSchema,
  UuidSchema,
  type CalendarEvent,
} from '@sms/contracts';
import {
  requireSession,
  requireTenantContext,
  requirePermission,
  requireCsrf,
} from '../../plugins/auth.js';
import { mapDomainError, parsePagination, idempotencyKeyFromHeader, notFoundError } from './util.js';
import { z } from 'zod';

type EventRow = typeof calendarEvents.$inferSelect;

export function toCalendarEvent(row: EventRow): CalendarEvent {
  return {
    id: row.id,
    tenantId: row.tenantId,
    calendarId: row.calendarId,
    title: row.title,
    description: row.description,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    allDay: row.allDay,
    location: row.location,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export interface CalendarEventWriteInput {
  title?: string;
  description?: string;
  startsAt?: string;
  endsAt?: string;
  allDay?: boolean;
  location?: string;
}

export async function insertCalendarEvent(
  tx: Tx,
  ctx: { userId: string; tenantId: string | null },
  calendarId: string,
  input: CalendarEventWriteInput,
  requestId: string,
): Promise<EventRow> {
  try {
    const rows = await tx
      .insert(calendarEvents)
      .values({
        tenantId: ctx.tenantId ?? '',
        calendarId,
        title: input.title ?? '',
        description: input.description ?? null,
        startsAt: new Date(input.startsAt ?? Date.now()),
        endsAt: new Date(input.endsAt ?? Date.now()),
        allDay: input.allDay ?? false,
        location: input.location ?? null,
      })
      .returning();
    const row = rows[0]!;
    await writeAudit(tx, {
      scope: 'tenant',
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action: 'calendar.event.created',
      resourceType: 'calendar_event',
      resourceId: row.id,
      newValue: toCalendarEvent(row),
      requestId,
    });
    await enqueueOutbox(tx, {
      tenantId: ctx.tenantId,
      eventType: 'calendar.event.created',
      aggregateType: 'calendar_event',
      aggregateId: row.id,
      payload: { tenantId: ctx.tenantId, calendarId, calendarEventId: row.id, title: row.title },
      correlationId: requestId,
    });
    return row;
  } catch (err) {
    throw mapDomainError(err);
  }
}

export async function updateCalendarEvent(
  tx: Tx,
  ctx: { userId: string; tenantId: string | null },
  id: string,
  input: CalendarEventWriteInput,
  requestId: string,
): Promise<EventRow | null> {
  try {
    const beforeRows = await tx
      .select()
      .from(calendarEvents)
      .where(and(eq(calendarEvents.id, id), isNull(calendarEvents.deletedAt)))
      .limit(1);
    const set: Record<string, unknown> = { ...input };
    if (input.startsAt) set.startsAt = new Date(input.startsAt);
    if (input.endsAt) set.endsAt = new Date(input.endsAt);
    const rows = await tx
      .update(calendarEvents)
      .set(set)
      .where(and(eq(calendarEvents.id, id), isNull(calendarEvents.deletedAt)))
      .returning();
    const row = rows[0];
    if (!row) return null;
    await writeAudit(tx, {
      scope: 'tenant',
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action: 'calendar.event.updated',
      resourceType: 'calendar_event',
      resourceId: row.id,
      oldValue: beforeRows[0] ? toCalendarEvent(beforeRows[0]) : undefined,
      newValue: toCalendarEvent(row),
      requestId,
    });
    await enqueueOutbox(tx, {
      tenantId: ctx.tenantId,
      eventType: 'calendar.event.updated',
      aggregateType: 'calendar_event',
      aggregateId: row.id,
      payload: { tenantId: ctx.tenantId, calendarEventId: row.id, title: row.title },
      correlationId: requestId,
    });
    return row;
  } catch (err) {
    throw mapDomainError(err);
  }
}

export async function deleteCalendarEvent(
  tx: Tx,
  ctx: { userId: string; tenantId: string | null },
  id: string,
  requestId: string,
): Promise<boolean> {
  try {
    const beforeRows = await tx
      .select()
      .from(calendarEvents)
      .where(and(eq(calendarEvents.id, id), isNull(calendarEvents.deletedAt)))
      .limit(1);
    const rows = await tx
      .update(calendarEvents)
      .set({ deletedAt: new Date() })
      .where(and(eq(calendarEvents.id, id), isNull(calendarEvents.deletedAt)))
      .returning();
    if (rows.length === 0) return false;
    const before = beforeRows[0]!;
    await writeAudit(tx, {
      scope: 'tenant',
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action: 'calendar.event.deleted',
      resourceType: 'calendar_event',
      resourceId: id,
      oldValue: toCalendarEvent(before),
      requestId,
    });
    await enqueueOutbox(tx, {
      tenantId: ctx.tenantId,
      eventType: 'calendar.event.deleted',
      aggregateType: 'calendar_event',
      aggregateId: id,
      payload: { tenantId: ctx.tenantId, calendarEventId: id },
      correlationId: requestId,
    });
    return true;
  } catch (err) {
    throw mapDomainError(err);
  }
}

const calendarIdParamSchema = z.object({ calendarId: UuidSchema });

export default async function calendarEventsRoutes(app: FastifyInstance) {
  app.get(
    '/api/v1/calendars/:calendarId/events',
    {
      config: { authorization: { kind: 'tenant', permission: 'calendar.read' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('calendar.read')],
    },
    async (request) => {
      const { calendarId } = calendarIdParamSchema.parse(request.params);
      const ctx = request.ctx!;
      const { limit, offset } = parsePagination(request.query);
      const result = await withTenant(app.db, ctx, async (tx) => {
        const parent = await tx
          .select({ id: calendars.id })
          .from(calendars)
          .where(and(eq(calendars.id, calendarId), isNull(calendars.deletedAt)))
          .limit(1)
          .execute();
        if (!parent[0]) return null;
        const rows = await tx
          .select()
          .from(calendarEvents)
          .where(and(eq(calendarEvents.calendarId, calendarId), isNull(calendarEvents.deletedAt)))
          .orderBy(desc(calendarEvents.startsAt))
          .limit(limit)
          .offset(offset)
          .execute();
        const totalRow = await tx
          .select({ total: count() })
          .from(calendarEvents)
          .where(and(eq(calendarEvents.calendarId, calendarId), isNull(calendarEvents.deletedAt)))
          .execute();
        return { items: rows.map(toCalendarEvent), total: totalRow[0]?.total ?? 0 };
      });
      if (result === null) throw notFoundError('Calendar not found');
      return result;
    },
  );

  app.post(
    '/api/v1/calendars/:calendarId/events',
    {
      config: { authorization: { kind: 'tenant', permission: 'calendar.write' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('calendar.write'), requireCsrf()],
    },
    async (request, reply) => {
      const { calendarId } = calendarIdParamSchema.parse(request.params);
      const body = createCalendarEventRequestSchema.parse(request.body);
      const ctx = request.ctx!;
      const idemKey = idempotencyKeyFromHeader(request.headers);
      const fingerprint = requestFingerprint(request.method, request.url, body);
      const outcome = await withTenant(app.db, ctx, (tx) =>
        withIdempotency(tx, { tenantId: ctx.tenantId, key: idemKey }, fingerprint, async () => {
          const row = await insertCalendarEvent(tx, ctx, calendarId, body, request.requestId);
          return { status: 201, body: { calendarEvent: toCalendarEvent(row) } };
        }),
      );
      return reply.code(outcome.status).send(outcome.body);
    },
  );

  app.get(
    '/api/v1/calendar-events/:id',
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
          .from(calendarEvents)
          .where(and(eq(calendarEvents.id, id), isNull(calendarEvents.deletedAt)))
          .limit(1)
          .execute()
          .then((r) => r[0]),
      );
      if (!row) throw notFoundError('Calendar event not found');
      return { calendarEvent: toCalendarEvent(row) };
    },
  );

  app.patch(
    '/api/v1/calendar-events/:id',
    {
      config: { authorization: { kind: 'tenant', permission: 'calendar.write' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('calendar.write'), requireCsrf()],
    },
    async (request, reply) => {
      const { id } = idParamSchema.parse(request.params);
      const body = updateCalendarEventRequestSchema.parse(request.body);
      const ctx = request.ctx!;
      const idemKey = idempotencyKeyFromHeader(request.headers);
      const fingerprint = requestFingerprint(request.method, request.url, body);
      const outcome = await withTenant(app.db, ctx, (tx) =>
        withIdempotency(tx, { tenantId: ctx.tenantId, key: idemKey }, fingerprint, async () => {
          const row = await updateCalendarEvent(tx, ctx, id, body, request.requestId);
          if (!row) throw notFoundError('Calendar event not found');
          return { status: 200, body: { calendarEvent: toCalendarEvent(row) } };
        }),
      );
      return reply.code(outcome.status).send(outcome.body);
    },
  );

  app.delete(
    '/api/v1/calendar-events/:id',
    {
      config: { authorization: { kind: 'tenant', permission: 'calendar.write' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('calendar.write'), requireCsrf()],
    },
    async (request, reply) => {
      const { id } = idParamSchema.parse(request.params);
      const ctx = request.ctx!;
      const deleted = await withTenant(app.db, ctx, (tx) => deleteCalendarEvent(tx, ctx, id, request.requestId));
      if (!deleted) throw notFoundError('Calendar event not found');
      return reply.code(204).send();
    },
  );
}