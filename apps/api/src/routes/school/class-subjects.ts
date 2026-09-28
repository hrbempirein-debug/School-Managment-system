import type { FastifyInstance } from 'fastify';
import { and, count, desc, eq, isNull } from 'drizzle-orm';
import { acdClasses, classSubjects, subjects, withTenant, type Tx } from '@sms/db';
import { writeAudit } from '@sms/audit';
import { enqueueOutbox } from '@sms/events';
import { requestFingerprint, withIdempotency } from '@sms/idempotency';
import {
  classSubjectListQuerySchema,
  classSubjectParamSchema,
  idParamSchema,
  type ClassSubject,
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

type ClassSubjectRow = typeof classSubjects.$inferSelect;
type ClassRow = typeof acdClasses.$inferSelect;

export function toClassSubject(row: ClassSubjectRow): ClassSubject {
  return {
    id: row.id,
    tenantId: row.tenantId,
    classId: row.classId,
    subjectId: row.subjectId,
    campusId: row.campusId,
    academicYearId: row.academicYearId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Resolve the live parent class of a class-subject route. Not-found stays 404;
 * campus scope is asserted against the class campus (AUTHORIZATION.md §4).
 */
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

/**
 * Attach a subject to a class. campus/academic_year are copied from the parent
 * class (composite FKs pin the copy). The lifecycle trigger additionally
 * refuses links under a soft-deleted class or to a soft-deleted subject; the
 * (class, subject) live uniqueness surfaces as 409 via class_subjects_* mapping.
 */
export async function assignClassSubject(
  tx: Tx,
  ctx: { userId: string; tenantId: string | null; campusId: string | null },
  classId: string,
  subjectId: string,
  requestId: string,
): Promise<ClassSubjectRow> {
  try {
    const parent = await resolveLiveClass(tx, ctx, classId);
    const subject = await tx
      .select({ id: subjects.id })
      .from(subjects)
      .where(and(eq(subjects.tenantId, ctx.tenantId ?? ''), eq(subjects.id, subjectId), isNull(subjects.deletedAt)))
      .limit(1)
      .execute()
      .then((r) => r[0]);
    if (!subject) throw notFoundError('Subject not found');

    const rows = await tx
      .insert(classSubjects)
      .values({
        tenantId: ctx.tenantId ?? '',
        classId: parent.id,
        subjectId: subject.id,
        campusId: parent.campusId,
        academicYearId: parent.academicYearId,
      })
      .returning();
    const row = rows[0]!;
    await writeAudit(tx, {
      scope: 'tenant',
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action: 'class.subject.assigned',
      resourceType: 'class_subject',
      resourceId: row.id,
      newValue: toClassSubject(row),
      requestId,
    });
    await enqueueOutbox(tx, {
      tenantId: ctx.tenantId,
      eventType: 'class.subject.assigned',
      aggregateType: 'class_subject',
      aggregateId: row.id,
      payload: {
        tenantId: ctx.tenantId,
        classSubjectId: row.id,
        classId: row.classId,
        subjectId: row.subjectId,
        campusId: row.campusId,
        academicYearId: row.academicYearId,
      },
      correlationId: requestId,
    });
    return row;
  } catch (err) {
    throw mapDomainError(err);
  }
}

/**
 * Detach a subject from a class (soft-delete; history retained, and a re-attach
 * yields a fresh row). The lifecycle trigger refuses this while a LIVE teacher
 * assignment references the pair — surfaces as 409 `class_subject_has_teachers`.
 */
export async function unassignClassSubject(
  tx: Tx,
  ctx: { userId: string; tenantId: string | null; campusId: string | null },
  classId: string,
  subjectId: string,
  requestId: string,
): Promise<ClassSubjectRow | null> {
  try {
    const parent = await resolveLiveClass(tx, ctx, classId);
    const beforeRows = await tx
      .select()
      .from(classSubjects)
      .where(
        and(
          eq(classSubjects.tenantId, ctx.tenantId ?? ''),
          eq(classSubjects.classId, parent.id),
          eq(classSubjects.subjectId, subjectId),
          isNull(classSubjects.deletedAt),
        ),
      )
      .limit(1)
      .execute();
    const before = beforeRows[0];
    if (!before) return null;

    const rows = await tx
      .update(classSubjects)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(classSubjects.tenantId, ctx.tenantId ?? ''),
          eq(classSubjects.id, before.id),
          isNull(classSubjects.deletedAt),
        ),
      )
      .returning();
    const row = rows[0];
    if (!row) return null;
    await writeAudit(tx, {
      scope: 'tenant',
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action: 'class.subject.unassigned',
      resourceType: 'class_subject',
      resourceId: row.id,
      oldValue: toClassSubject(before),
      newValue: { deletedAt: row.deletedAt?.toISOString() ?? null },
      requestId,
    });
    await enqueueOutbox(tx, {
      tenantId: ctx.tenantId,
      eventType: 'class.subject.unassigned',
      aggregateType: 'class_subject',
      aggregateId: row.id,
      payload: {
        tenantId: ctx.tenantId,
        classSubjectId: row.id,
        classId: row.classId,
        subjectId: row.subjectId,
      },
      correlationId: requestId,
    });
    return row;
  } catch (err) {
    throw mapDomainError(err);
  }
}

export default async function classSubjectRoutes(app: FastifyInstance) {
  app.get(
    '/api/v1/classes/:id/subjects',
    {
      config: { authorization: { kind: 'tenant', permission: 'class.subjects.read' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('class.subjects.read')],
    },
    async (request) => {
      const { id } = idParamSchema.parse(request.params);
      const ctx = request.ctx!;
      await withTenant(app.db, ctx, (tx) => resolveLiveClass(tx, ctx, id));
      const query = classSubjectListQuerySchema.parse(request.query);
      const conditions = [
        eq(classSubjects.tenantId, ctx.tenantId ?? ''),
        eq(classSubjects.classId, id),
        isNull(classSubjects.deletedAt),
      ];
      const rows = await withTenant(app.db, ctx, (tx) =>
        tx
          .select()
          .from(classSubjects)
          .where(and(...conditions))
          .orderBy(desc(classSubjects.createdAt), desc(classSubjects.id))
          .limit(query.limit)
          .offset(query.offset)
          .execute(),
      );
      const totalRow = await withTenant(app.db, ctx, (tx) =>
        tx
          .select({ total: count() })
          .from(classSubjects)
          .where(and(...conditions))
          .execute(),
      );
      return { items: rows.map(toClassSubject), total: totalRow[0]?.total ?? 0 };
    },
  );

  app.post(
    '/api/v1/classes/:id/subjects/:subjectId',
    {
      config: { authorization: { kind: 'tenant', permission: 'class.subjects.manage' } },
      preHandler: [
        requireSession(),
        requireTenantContext(),
        requirePermission('class.subjects.manage'),
        requireCsrf(),
      ],
    },
    async (request, reply) => {
      const { id, subjectId } = classSubjectParamSchema.parse(request.params);
      const ctx = request.ctx!;
      const idemKey = idempotencyKeyFromHeader(request.headers);
      const fingerprint = requestFingerprint(request.method, request.url, {});
      const outcome = await withTenant(app.db, ctx, (tx) =>
        withIdempotency(tx, { tenantId: ctx.tenantId, key: idemKey }, fingerprint, async () => {
          const row = await assignClassSubject(tx, ctx, id, subjectId, request.requestId);
          return { status: 201, body: { classSubject: toClassSubject(row) } };
        }),
      );
      return reply.code(outcome.status).send(outcome.body);
    },
  );

  app.delete(
    '/api/v1/classes/:id/subjects/:subjectId',
    {
      config: { authorization: { kind: 'tenant', permission: 'class.subjects.manage' } },
      preHandler: [
        requireSession(),
        requireTenantContext(),
        requirePermission('class.subjects.manage'),
        requireCsrf(),
      ],
    },
    async (request, reply) => {
      const { id, subjectId } = classSubjectParamSchema.parse(request.params);
      const ctx = request.ctx!;
      const idemKey = idempotencyKeyFromHeader(request.headers);
      const fingerprint = requestFingerprint(request.method, request.url, {});
      const outcome = await withTenant(app.db, ctx, (tx) =>
        withIdempotency(tx, { tenantId: ctx.tenantId, key: idemKey }, fingerprint, async () => {
          const row = await unassignClassSubject(tx, ctx, id, subjectId, request.requestId);
          if (!row) throw notFoundError('Subject is not attached to this class');
          return { status: 200, body: { classSubject: toClassSubject(row) } };
        }),
      );
      return reply.code(outcome.status).send(outcome.body);
    },
  );
}