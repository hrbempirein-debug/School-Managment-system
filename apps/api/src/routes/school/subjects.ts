import type { FastifyInstance } from 'fastify';
import { and, count, desc, eq, isNull } from 'drizzle-orm';
import { subjects, withTenant, type Tx } from '@sms/db';
import { writeAudit } from '@sms/audit';
import { enqueueOutbox } from '@sms/events';
import { requestFingerprint, withIdempotency } from '@sms/idempotency';
import {
  createSubjectRequestSchema,
  idParamSchema,
  subjectListQuerySchema,
  updateSubjectRequestSchema,
  type Subject,
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

type SubjectRow = typeof subjects.$inferSelect;

export function toSubject(row: SubjectRow): Subject {
  return {
    id: row.id,
    tenantId: row.tenantId,
    code: row.code,
    name: row.name,
    description: row.description ?? null,
    status: row.status as Subject['status'],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export interface SubjectWriteInput {
  code?: string;
  name?: string;
  description?: string | null;
}

/**
 * Insert a subject (tenant-wide catalog; school-wide — no campus scope applies).
 * Code uniqueness is tenant-wide among live rows (subjects_tenant_code_uq).
 */
export async function insertSubject(
  tx: Tx,
  ctx: { userId: string; tenantId: string | null; campusId: string | null },
  input: { code: string; name: string; description?: string },
  requestId: string,
): Promise<SubjectRow> {
  try {
    const rows = await tx
      .insert(subjects)
      .values({
        tenantId: ctx.tenantId ?? '',
        code: input.code,
        name: input.name,
        description: input.description ?? null,
        status: 'active',
      })
      .returning();
    const row = rows[0]!;
    await writeAudit(tx, {
      scope: 'tenant',
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action: 'subject.created',
      resourceType: 'subject',
      resourceId: row.id,
      newValue: toSubject(row),
      requestId,
    });
    await enqueueOutbox(tx, {
      tenantId: ctx.tenantId,
      eventType: 'subject.created',
      aggregateType: 'subject',
      aggregateId: row.id,
      payload: { tenantId: ctx.tenantId, subjectId: row.id, code: row.code, name: row.name },
      correlationId: requestId,
    });
    return row;
  } catch (err) {
    throw mapDomainError(err);
  }
}

export async function updateSubject(
  tx: Tx,
  ctx: { userId: string; tenantId: string | null; campusId: string | null },
  id: string,
  input: SubjectWriteInput,
  requestId: string,
): Promise<SubjectRow | null> {
  try {
    const beforeRows = await tx
      .select()
      .from(subjects)
      .where(and(eq(subjects.tenantId, ctx.tenantId ?? ''), eq(subjects.id, id), isNull(subjects.deletedAt)))
      .limit(1)
      .execute();
    const before = beforeRows[0];
    if (!before) return null;

    const rows = await tx
      .update(subjects)
      .set(input)
      .where(and(eq(subjects.tenantId, ctx.tenantId ?? ''), eq(subjects.id, id), isNull(subjects.deletedAt)))
      .returning();
    const row = rows[0];
    if (!row) return null;
    await writeAudit(tx, {
      scope: 'tenant',
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action: 'subject.updated',
      resourceType: 'subject',
      resourceId: row.id,
      oldValue: toSubject(before),
      newValue: toSubject(row),
      requestId,
    });
    await enqueueOutbox(tx, {
      tenantId: ctx.tenantId,
      eventType: 'subject.updated',
      aggregateType: 'subject',
      aggregateId: row.id,
      payload: { tenantId: ctx.tenantId, subjectId: row.id, code: row.code, name: row.name },
      correlationId: requestId,
    });
    return row;
  } catch (err) {
    throw mapDomainError(err);
  }
}

export async function setSubjectStatus(
  tx: Tx,
  ctx: { userId: string; tenantId: string | null; campusId: string | null },
  id: string,
  status: 'active' | 'inactive',
  requestId: string,
): Promise<SubjectRow | null> {
  try {
    const beforeRows = await tx
      .select()
      .from(subjects)
      .where(and(eq(subjects.tenantId, ctx.tenantId ?? ''), eq(subjects.id, id), isNull(subjects.deletedAt)))
      .limit(1)
      .execute();
    const before = beforeRows[0];
    if (!before) return null;

    const rows = await tx
      .update(subjects)
      .set({ status })
      .where(and(eq(subjects.tenantId, ctx.tenantId ?? ''), eq(subjects.id, id), isNull(subjects.deletedAt)))
      .returning();
    const row = rows[0];
    if (!row) return null;
    await writeAudit(tx, {
      scope: 'tenant',
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action: status === 'active' ? 'subject.activated' : 'subject.deactivated',
      resourceType: 'subject',
      resourceId: row.id,
      newValue: { status },
      requestId,
    });
    await enqueueOutbox(tx, {
      tenantId: ctx.tenantId,
      eventType: status === 'active' ? 'subject.activated' : 'subject.deactivated',
      aggregateType: 'subject',
      aggregateId: row.id,
      payload: { tenantId: ctx.tenantId, subjectId: row.id, status },
      correlationId: requestId,
    });
    return row;
  } catch (err) {
    throw mapDomainError(err);
  }
}

/**
 * Soft-delete a subject. The DB guard (trg_subjects_delete_guard) rejects this
 * while any LIVE class-subject link or teacher assignment references the subject
 * — surfaces as the documented 409 codes.
 */
export async function deleteSubject(
  tx: Tx,
  ctx: { userId: string; tenantId: string | null; campusId: string | null },
  id: string,
  requestId: string,
): Promise<SubjectRow | null> {
  try {
    const beforeRows = await tx
      .select()
      .from(subjects)
      .where(and(eq(subjects.tenantId, ctx.tenantId ?? ''), eq(subjects.id, id), isNull(subjects.deletedAt)))
      .limit(1)
      .execute();
    const before = beforeRows[0];
    if (!before) return null;

    const rows = await tx
      .update(subjects)
      .set({ deletedAt: new Date() })
      .where(and(eq(subjects.tenantId, ctx.tenantId ?? ''), eq(subjects.id, id), isNull(subjects.deletedAt)))
      .returning();
    const row = rows[0];
    if (!row) return null;
    await writeAudit(tx, {
      scope: 'tenant',
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action: 'subject.deleted',
      resourceType: 'subject',
      resourceId: row.id,
      oldValue: toSubject(before),
      newValue: { deletedAt: row.deletedAt?.toISOString() ?? null },
      requestId,
    });
    await enqueueOutbox(tx, {
      tenantId: ctx.tenantId,
      eventType: 'subject.deleted',
      aggregateType: 'subject',
      aggregateId: row.id,
      payload: { tenantId: ctx.tenantId, subjectId: row.id },
      correlationId: requestId,
    });
    return row;
  } catch (err) {
    throw mapDomainError(err);
  }
}

export default async function subjectRoutes(app: FastifyInstance) {
  app.get(
    '/api/v1/subjects',
    {
      config: { authorization: { kind: 'tenant', permission: 'subjects.read' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('subjects.read')],
    },
    async (request) => {
      const ctx = request.ctx!;
      const query = subjectListQuerySchema.parse(request.query);
      const conditions = [eq(subjects.tenantId, ctx.tenantId ?? ''), isNull(subjects.deletedAt)];
      if (query.status) conditions.push(eq(subjects.status, query.status));
      const rows = await withTenant(app.db, ctx, (tx) =>
        tx
          .select()
          .from(subjects)
          .where(and(...conditions))
          .orderBy(desc(subjects.createdAt), desc(subjects.id))
          .limit(query.limit)
          .offset(query.offset)
          .execute(),
      );
      const totalRow = await withTenant(app.db, ctx, (tx) =>
        tx
          .select({ total: count() })
          .from(subjects)
          .where(and(...conditions))
          .execute(),
      );
      return { items: rows.map(toSubject), total: totalRow[0]?.total ?? 0 };
    },
  );

  app.post(
    '/api/v1/subjects',
    {
      config: { authorization: { kind: 'tenant', permission: 'subjects.create' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('subjects.create'), requireCsrf()],
    },
    async (request, reply) => {
      const body = createSubjectRequestSchema.parse(request.body);
      const ctx = request.ctx!;
      const idemKey = idempotencyKeyFromHeader(request.headers);
      const fingerprint = requestFingerprint(request.method, request.url, body);
      const outcome = await withTenant(app.db, ctx, (tx) =>
        withIdempotency(tx, { tenantId: ctx.tenantId, key: idemKey }, fingerprint, async () => {
          const row = await insertSubject(tx, ctx, body, request.requestId);
          return { status: 201, body: { subject: toSubject(row) } };
        }),
      );
      return reply.code(outcome.status).send(outcome.body);
    },
  );

  app.get(
    '/api/v1/subjects/:id',
    {
      config: { authorization: { kind: 'tenant', permission: 'subjects.read' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('subjects.read')],
    },
    async (request) => {
      const { id } = idParamSchema.parse(request.params);
      const ctx = request.ctx!;
      const row = await withTenant(app.db, ctx, (tx) =>
        tx
          .select()
          .from(subjects)
          .where(and(eq(subjects.tenantId, ctx.tenantId ?? ''), eq(subjects.id, id), isNull(subjects.deletedAt)))
          .limit(1)
          .execute()
          .then((r) => r[0]),
      );
      if (!row) throw notFoundError('Subject not found');
      return { subject: toSubject(row) };
    },
  );

  app.patch(
    '/api/v1/subjects/:id',
    {
      config: { authorization: { kind: 'tenant', permission: 'subjects.update' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('subjects.update'), requireCsrf()],
    },
    async (request, reply) => {
      const { id } = idParamSchema.parse(request.params);
      const body = updateSubjectRequestSchema.parse(request.body);
      const ctx = request.ctx!;
      const idemKey = idempotencyKeyFromHeader(request.headers);
      const fingerprint = requestFingerprint(request.method, request.url, body);
      const outcome = await withTenant(app.db, ctx, (tx) =>
        withIdempotency(tx, { tenantId: ctx.tenantId, key: idemKey }, fingerprint, async () => {
          const row = await updateSubject(tx, ctx, id, body, request.requestId);
          if (!row) throw notFoundError('Subject not found');
          return { status: 200, body: { subject: toSubject(row) } };
        }),
      );
      return reply.code(outcome.status).send(outcome.body);
    },
  );

  app.post(
    '/api/v1/subjects/:id/activate',
    {
      config: { authorization: { kind: 'tenant', permission: 'subjects.update' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('subjects.update'), requireCsrf()],
    },
    async (request, reply) => {
      const { id } = idParamSchema.parse(request.params);
      const ctx = request.ctx!;
      const row = await withTenant(app.db, ctx, (tx) =>
        setSubjectStatus(tx, ctx, id, 'active', request.requestId),
      );
      if (!row) throw notFoundError('Subject not found');
      return { subject: toSubject(row) };
    },
  );

  app.post(
    '/api/v1/subjects/:id/deactivate',
    {
      config: { authorization: { kind: 'tenant', permission: 'subjects.update' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('subjects.update'), requireCsrf()],
    },
    async (request, reply) => {
      const { id } = idParamSchema.parse(request.params);
      const ctx = request.ctx!;
      const row = await withTenant(app.db, ctx, (tx) =>
        setSubjectStatus(tx, ctx, id, 'inactive', request.requestId),
      );
      if (!row) throw notFoundError('Subject not found');
      return { subject: toSubject(row) };
    },
  );

  app.delete(
    '/api/v1/subjects/:id',
    {
      config: { authorization: { kind: 'tenant', permission: 'subjects.delete' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('subjects.delete'), requireCsrf()],
    },
    async (request, reply) => {
      const { id } = idParamSchema.parse(request.params);
      const ctx = request.ctx!;
      const idemKey = idempotencyKeyFromHeader(request.headers);
      const fingerprint = requestFingerprint(request.method, request.url, {});
      const outcome = await withTenant(app.db, ctx, (tx) =>
        withIdempotency(tx, { tenantId: ctx.tenantId, key: idemKey }, fingerprint, async () => {
          const row = await deleteSubject(tx, ctx, id, request.requestId);
          if (!row) throw notFoundError('Subject not found');
          return { status: 200, body: { subject: toSubject(row) } };
        }),
      );
      return reply.code(outcome.status).send(outcome.body);
    },
  );
}