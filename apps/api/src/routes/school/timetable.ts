import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, count, desc, eq, isNull, sql } from 'drizzle-orm';
import {
  acdClasses,
  sections,
  subjects,
  classSubjects,
  teacherAssignments,
  timetableEntries,
  withTenant,
  type Tx,
} from '@sms/db';
import { writeAudit } from '@sms/audit';
import { enqueueOutbox } from '@sms/events';
import { requestFingerprint, withIdempotency } from '@sms/idempotency';
import {
  UuidSchema,
  createTimetableEntryRequestSchema,
  publishTimetableRequestSchema,
  updateTimetableEntryRequestSchema,
  timetableEntryListQuerySchema,
  timetableEntryParamSchema,
  type TimetableEntry,
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

type TimetableEntryRow = typeof timetableEntries.$inferSelect;
type ClassRow = typeof acdClasses.$inferSelect;
type SectionRow = typeof sections.$inferSelect;

const timetableSectionParamSchema = z
  .object({ id: UuidSchema, sectionId: UuidSchema })
  .strict();

export function toTimetableEntry(row: TimetableEntryRow): TimetableEntry {
  return {
    id: row.id,
    tenantId: row.tenantId,
    classId: row.classId,
    sectionId: row.sectionId,
    subjectId: row.subjectId,
    teacherUserId: row.teacherUserId,
    periodId: row.periodId,
    campusId: row.campusId,
    academicYearId: row.academicYearId,
    weekday: row.weekday,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function resolveLiveClass(
  tx: Tx,
  ctx: { tenantId: string | null; campusId: string | null },
  classId: string,
): Promise<ClassRow> {
  const row = await tx
    .select()
    .from(acdClasses)
    .where(and(eq(acdClasses.tenantId, ctx.tenantId ?? ''), eq(acdClasses.id, classId), isNull(acdClasses.deletedAt)))
    .limit(1)
    .execute()
    .then((r) => r[0]);
  if (!row) throw notFoundError('Class not found');
  assertCampusScope(ctx, row.campusId);
  return row;
}

async function resolveLiveSection(
  tx: Tx,
  ctx: { tenantId: string | null; campusId: string | null },
  classId: string,
  sectionId: string,
): Promise<SectionRow> {
  const row = await tx
    .select()
    .from(sections)
    .where(
      and(
        eq(sections.tenantId, ctx.tenantId ?? ''),
        eq(sections.classId, classId),
        eq(sections.id, sectionId),
        isNull(sections.deletedAt),
      ),
    )
    .limit(1)
    .execute()
    .then((r) => r[0]);
  if (!row) throw notFoundError('Section not found');
  assertCampusScope(ctx, row.campusId);
  return row;
}

/**
 * Create a grid cell. The teacher is NOT client-writable: it is copied from the
 * LIVE teacher_assignment of the (class, subject) — a lesson always runs under
 * the assigned lead teacher. The SECURITY INVOKER trigger re-verifies the link
 * and assignment and rejects teacher double-bookings (55000 ->
 * `teacher_double_booked`) and slot collisions (23505 -> `timetable_slot_conflict`).
 */
export async function createTimetableEntry(
  tx: Tx,
  ctx: { userId: string; tenantId: string | null; campusId: string | null },
  classId: string,
  sectionId: string,
  input: { subjectId: string; weekday: number; periodId: string },
  requestId: string,
): Promise<TimetableEntryRow> {
  try {
    const parent = await resolveLiveClass(tx, ctx, classId);
    const section = await resolveLiveSection(tx, ctx, classId, sectionId);
    const subject = await tx
      .select({ id: subjects.id })
      .from(subjects)
      .where(and(eq(subjects.tenantId, ctx.tenantId ?? ''), eq(subjects.id, input.subjectId), isNull(subjects.deletedAt)))
      .limit(1)
      .execute()
      .then((r) => r[0]);
    if (!subject) throw notFoundError('Subject not found');
    const link = await tx
      .select({ id: classSubjects.id })
      .from(classSubjects)
      .where(
        and(
          eq(classSubjects.tenantId, ctx.tenantId ?? ''),
          eq(classSubjects.classId, parent.id),
          eq(classSubjects.subjectId, subject.id),
          isNull(classSubjects.deletedAt),
        ),
      )
      .limit(1)
      .execute()
      .then((r) => r[0]);
    if (!link) throw notFoundError('Subject is not attached to this class');
    const assignment = await tx
      .select({ id: teacherAssignments.id, teacherUserId: teacherAssignments.teacherUserId })
      .from(teacherAssignments)
      .where(
        and(
          eq(teacherAssignments.tenantId, ctx.tenantId ?? ''),
          eq(teacherAssignments.classId, parent.id),
          eq(teacherAssignments.subjectId, subject.id),
          isNull(teacherAssignments.deletedAt),
        ),
      )
      .limit(1)
      .execute()
      .then((r) => r[0]);
    if (!assignment) throw notFoundError('No teacher is assigned to this subject in this class');

    const rows = await tx
      .insert(timetableEntries)
      .values({
        tenantId: ctx.tenantId ?? '',
        classId: parent.id,
        sectionId: section.id,
        subjectId: subject.id,
        teacherUserId: assignment.teacherUserId,
        periodId: input.periodId,
        campusId: parent.campusId,
        academicYearId: parent.academicYearId,
        weekday: input.weekday,
      })
      .returning();
    const row = rows[0]!;
    await writeAudit(tx, {
      scope: 'tenant',
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action: 'timetable.entry.created',
      resourceType: 'timetable_entry',
      resourceId: row.id,
      newValue: toTimetableEntry(row),
      requestId,
    });
    await enqueueOutbox(tx, {
      tenantId: ctx.tenantId,
      eventType: 'timetable.entry.created',
      aggregateType: 'timetable_entry',
      aggregateId: row.id,
      payload: {
        tenantId: ctx.tenantId,
        entryId: row.id,
        classId: row.classId,
        sectionId: row.sectionId,
        subjectId: row.subjectId,
        weekday: row.weekday,
        periodId: row.periodId,
      },
      correlationId: requestId,
    });
    return row;
  } catch (err) {
    throw mapDomainError(err);
  }
}

/**
 * Move a grid cell (weekday/period only — a slot's subject is immutable). The
 * trigger re-runs the spread checks against the NEW slot.
 */
export async function updateTimetableEntry(
  tx: Tx,
  ctx: { userId: string; tenantId: string | null; campusId: string | null },
  classId: string,
  sectionId: string,
  entryId: string,
  input: { weekday?: number; periodId?: string },
  requestId: string,
): Promise<TimetableEntryRow | null> {
  try {
    await resolveLiveClass(tx, ctx, classId);
    await resolveLiveSection(tx, ctx, classId, sectionId);
    const beforeRows = await tx
      .select()
      .from(timetableEntries)
      .where(
        and(
          eq(timetableEntries.tenantId, ctx.tenantId ?? ''),
          eq(timetableEntries.id, entryId),
          eq(timetableEntries.classId, classId),
          eq(timetableEntries.sectionId, sectionId),
          isNull(timetableEntries.deletedAt),
        ),
      )
      .limit(1)
      .execute();
    const before = beforeRows[0];
    if (!before) return null;
    assertCampusScope(ctx, before.campusId);

    const set: Partial<TimetableEntryRow> = {};
    if (input.weekday !== undefined) set.weekday = input.weekday;
    if (input.periodId !== undefined) set.periodId = input.periodId;
    const rows = await tx
      .update(timetableEntries)
      .set(set)
      .where(
        and(
          eq(timetableEntries.tenantId, ctx.tenantId ?? ''),
          eq(timetableEntries.id, entryId),
          isNull(timetableEntries.deletedAt),
        ),
      )
      .returning();
    const row = rows[0];
    if (!row) return null;
    await writeAudit(tx, {
      scope: 'tenant',
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action: 'timetable.entry.updated',
      resourceType: 'timetable_entry',
      resourceId: row.id,
      oldValue: toTimetableEntry(before),
      newValue: toTimetableEntry(row),
      requestId,
    });
    await enqueueOutbox(tx, {
      tenantId: ctx.tenantId,
      eventType: 'timetable.entry.updated',
      aggregateType: 'timetable_entry',
      aggregateId: row.id,
      payload: {
        tenantId: ctx.tenantId,
        entryId: row.id,
        weekday: row.weekday,
        periodId: row.periodId,
      },
      correlationId: requestId,
    });
    return row;
  } catch (err) {
    throw mapDomainError(err);
  }
}

/** Remove a lesson from the grid (soft delete; history retained). */
export async function deleteTimetableEntry(
  tx: Tx,
  ctx: { userId: string; tenantId: string | null; campusId: string | null },
  classId: string,
  sectionId: string,
  entryId: string,
  requestId: string,
): Promise<TimetableEntryRow | null> {
  try {
    await resolveLiveClass(tx, ctx, classId);
    await resolveLiveSection(tx, ctx, classId, sectionId);
    const beforeRows = await tx
      .select()
      .from(timetableEntries)
      .where(
        and(
          eq(timetableEntries.tenantId, ctx.tenantId ?? ''),
          eq(timetableEntries.id, entryId),
          eq(timetableEntries.classId, classId),
          eq(timetableEntries.sectionId, sectionId),
          isNull(timetableEntries.deletedAt),
        ),
      )
      .limit(1)
      .execute();
    const before = beforeRows[0];
    if (!before) return null;
    assertCampusScope(ctx, before.campusId);

    const rows = await tx
      .update(timetableEntries)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(timetableEntries.tenantId, ctx.tenantId ?? ''),
          eq(timetableEntries.id, entryId),
          isNull(timetableEntries.deletedAt),
        ),
      )
      .returning();
    const row = rows[0];
    if (!row) return null;
    await writeAudit(tx, {
      scope: 'tenant',
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action: 'timetable.entry.deleted',
      resourceType: 'timetable_entry',
      resourceId: row.id,
      oldValue: toTimetableEntry(before),
      newValue: { deletedAt: row.deletedAt?.toISOString() ?? null },
      requestId,
    });
    await enqueueOutbox(tx, {
      tenantId: ctx.tenantId,
      eventType: 'timetable.entry.deleted',
      aggregateType: 'timetable_entry',
      aggregateId: row.id,
      payload: {
        tenantId: ctx.tenantId,
        entryId: row.id,
        classId: row.classId,
        sectionId: row.sectionId,
        subjectId: row.subjectId,
        weekday: row.weekday,
      },
      correlationId: requestId,
    });
    return row;
  } catch (err) {
    throw mapDomainError(err);
  }
}

/**
 * Publish validation (POST /api/v1/timetable/publish). Re-scans every LIVE entry
 * in the tenant for teacher double-bookings across the whole week. Zero conflicts
 * → `published:true` plus audit + `timetable.published` event; conflicts → 200
 * with `published:false` and the offending (weekday, teacher, entryCount) groups
 * so the client can rectify and re-publish.
 */
export async function publishTimetable(
  tx: Tx,
  ctx: { userId: string; tenantId: string | null; campusId: string | null },
  requestId: string,
): Promise<{ published: boolean; conflicts: Array<{ weekday: number; teacherUserId: string; entryCount: number }> }> {
  const result = await tx.execute<{
    weekday: number;
    teacher_user_id: string;
    entry_count: string;
  }>(sql`
    SELECT e1.weekday, e1.teacher_user_id, count(DISTINCT e2.id)::text AS entry_count
    FROM timetable_entries e1
    JOIN periods p1 ON p1.tenant_id = e1.tenant_id AND p1.id = e1.period_id
    JOIN timetable_entries e2 ON e2.tenant_id = e1.tenant_id
        AND e2.weekday = e1.weekday
        AND e2.teacher_user_id = e1.teacher_user_id
        AND e2.id <> e1.id
        AND e2.deleted_at IS NULL
    JOIN periods p2 ON p2.tenant_id = e2.tenant_id AND p2.id = e2.period_id
    WHERE e1.tenant_id = ${ctx.tenantId ?? ''}
      AND e1.deleted_at IS NULL
      AND tstzrange(('2000-01-01'::date + p1.start_time) AT TIME ZONE 'UTC',
                    ('2000-01-01'::date + p1.end_time) AT TIME ZONE 'UTC', '[)')
          && tstzrange(('2000-01-01'::date + p2.start_time) AT TIME ZONE 'UTC',
                       ('2000-01-01'::date + p2.end_time) AT TIME ZONE 'UTC', '[)')
    GROUP BY e1.weekday, e1.teacher_user_id
    ORDER BY e1.weekday, e1.teacher_user_id
  `);
  const conflicts = result.rows.map((r) => ({
    weekday: Number(r.weekday),
    teacherUserId: r.teacher_user_id,
    entryCount: Number(r.entry_count),
  }));

  if (conflicts.length > 0) {
    return { published: false, conflicts };
  }
  await writeAudit(tx, {
    scope: 'tenant',
    tenantId: ctx.tenantId,
    actorUserId: ctx.userId,
    action: 'timetable.published',
    resourceType: 'timetable',
    resourceId: ctx.tenantId ?? '',
    newValue: { published: true, conflicts: [] },
    requestId,
  });
  await enqueueOutbox(tx, {
    tenantId: ctx.tenantId,
    eventType: 'timetable.published',
    aggregateType: 'timetable',
    aggregateId: ctx.tenantId ?? '',
    payload: { tenantId: ctx.tenantId, published: true },
    correlationId: requestId,
  });
  return { published: true, conflicts: [] };
}

export default async function timetableRoutes(app: FastifyInstance) {
  app.get(
    '/api/v1/classes/:id/sections/:sectionId/timetable',
    {
      config: { authorization: { kind: 'tenant', permission: 'timetable.read' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('timetable.read')],
    },
    async (request) => {
      const { id, sectionId } = timetableSectionParamSchema.parse(request.params);
      const ctx = request.ctx!;
      await withTenant(app.db, ctx, async (tx) => {
        await resolveLiveClass(tx, ctx, id);
        await resolveLiveSection(tx, ctx, id, sectionId);
      });
      const query = timetableEntryListQuerySchema.parse(request.query);
      const conditions = [
        eq(timetableEntries.tenantId, ctx.tenantId ?? ''),
        eq(timetableEntries.classId, id),
        eq(timetableEntries.sectionId, sectionId),
        isNull(timetableEntries.deletedAt),
      ];
      if (query.subjectId) conditions.push(eq(timetableEntries.subjectId, query.subjectId));
      if (query.weekday) conditions.push(eq(timetableEntries.weekday, query.weekday));
      const rows = await withTenant(app.db, ctx, (tx) =>
        tx
          .select()
          .from(timetableEntries)
          .where(and(...conditions))
          .orderBy(timetableEntries.weekday, timetableEntries.periodId, desc(timetableEntries.id))
          .limit(query.limit)
          .offset(query.offset)
          .execute(),
      );
      const totalRow = await withTenant(app.db, ctx, (tx) =>
        tx.select({ total: count() }).from(timetableEntries).where(and(...conditions)).execute(),
      );
      return { items: rows.map(toTimetableEntry), total: totalRow[0]?.total ?? 0 };
    },
  );

  app.post(
    '/api/v1/classes/:id/sections/:sectionId/timetable',
    {
      config: { authorization: { kind: 'tenant', permission: 'timetable.manage' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('timetable.manage'), requireCsrf()],
    },
    async (request, reply) => {
      const { id, sectionId } = timetableSectionParamSchema.parse(request.params);
      const body = createTimetableEntryRequestSchema.parse(request.body);
      const ctx = request.ctx!;
      const idemKey = idempotencyKeyFromHeader(request.headers);
      const fingerprint = requestFingerprint(request.method, request.url, body);
      const outcome = await withTenant(app.db, ctx, (tx) =>
        withIdempotency(tx, { tenantId: ctx.tenantId, key: idemKey }, fingerprint, async () => {
          const row = await createTimetableEntry(tx, ctx, id, sectionId, body, request.requestId);
          return { status: 201, body: { entry: toTimetableEntry(row) } };
        }),
      );
      return reply.code(outcome.status).send(outcome.body);
    },
  );

  app.patch(
    '/api/v1/classes/:id/sections/:sectionId/timetable/:entryId',
    {
      config: { authorization: { kind: 'tenant', permission: 'timetable.manage' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('timetable.manage'), requireCsrf()],
    },
    async (request, reply) => {
      const params = timetableEntryParamSchema.parse(request.params);
      const body = updateTimetableEntryRequestSchema.parse(request.body);
      const ctx = request.ctx!;
      const idemKey = idempotencyKeyFromHeader(request.headers);
      const fingerprint = requestFingerprint(request.method, request.url, body);
      const outcome = await withTenant(app.db, ctx, (tx) =>
        withIdempotency(tx, { tenantId: ctx.tenantId, key: idemKey }, fingerprint, async () => {
          const row = await updateTimetableEntry(
            tx, ctx, params.id, params.sectionId, params.entryId, body, request.requestId,
          );
          if (!row) throw notFoundError('Timetable entry not found');
          return { status: 200, body: { entry: toTimetableEntry(row) } };
        }),
      );
      return reply.code(outcome.status).send(outcome.body);
    },
  );

  app.delete(
    '/api/v1/classes/:id/sections/:sectionId/timetable/:entryId',
    {
      config: { authorization: { kind: 'tenant', permission: 'timetable.manage' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('timetable.manage'), requireCsrf()],
    },
    async (request, reply) => {
      const params = timetableEntryParamSchema.parse(request.params);
      const ctx = request.ctx!;
      const idemKey = idempotencyKeyFromHeader(request.headers);
      const fingerprint = requestFingerprint(request.method, request.url, {});
      const outcome = await withTenant(app.db, ctx, (tx) =>
        withIdempotency(tx, { tenantId: ctx.tenantId, key: idemKey }, fingerprint, async () => {
          const row = await deleteTimetableEntry(
            tx, ctx, params.id, params.sectionId, params.entryId, request.requestId,
          );
          if (!row) throw notFoundError('Timetable entry not found');
          return { status: 200, body: { entry: toTimetableEntry(row) } };
        }),
      );
      return reply.code(outcome.status).send(outcome.body);
    },
  );

  app.post(
    '/api/v1/timetable/publish',
    {
      config: { authorization: { kind: 'tenant', permission: 'timetable.publish' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('timetable.publish'), requireCsrf()],
    },
    async (request, reply) => {
      const body = publishTimetableRequestSchema.parse(request.body);
      const ctx = request.ctx!;
      const idemKey = idempotencyKeyFromHeader(request.headers);
      const fingerprint = requestFingerprint(request.method, request.url, body);
      const outcome = await withTenant(app.db, ctx, (tx) =>
        withIdempotency(tx, { tenantId: ctx.tenantId, key: idemKey }, fingerprint, async () => {
          const result = await publishTimetable(tx, ctx, request.requestId);
          return { status: 200, body: result };
        }),
      );
      return reply.code(outcome.status).send(outcome.body);
    },
  );
}