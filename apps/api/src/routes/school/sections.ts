import type { FastifyInstance } from 'fastify';
import { and, count, desc, eq, isNull } from 'drizzle-orm';
import { acdClasses, sections, withTenant, type Tx } from '@sms/db';
import { writeAudit } from '@sms/audit';
import { enqueueOutbox } from '@sms/events';
import { requestFingerprint, withIdempotency } from '@sms/idempotency';
import {
  classSectionParamSchema,
  createSectionRequestSchema,
  idParamSchema,
  sectionListQuerySchema,
  updateSectionRequestSchema,
  type Section,
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

type SectionRow = typeof sections.$inferSelect;
type ClassRow = typeof acdClasses.$inferSelect;

export function toSection(row: SectionRow): Section {
  return {
    id: row.id,
    tenantId: row.tenantId,
    classId: row.classId,
    campusId: row.campusId,
    academicYearId: row.academicYearId,
    code: row.code,
    status: row.status as Section['status'],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Resolve the live parent class of a section route. Not-found stays 404; campus
 * scope is asserted against the class campus (AUTHORIZATION.md §4).
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
 * Insert a section. campus/academic_year are copied from the live parent class —
 * section rows can never drift onto another campus/year (composite FKs pin the
 * copy). The section lifecycle trigger (BEFORE INSERT) additionally refuses
 * sections under a soft-deleted class.
 */
export async function insertSection(
  tx: Tx,
  ctx: { userId: string; tenantId: string | null; campusId: string | null },
  classId: string,
  code: string,
  requestId: string,
): Promise<SectionRow> {
  try {
    const parent = await resolveLiveClass(tx, ctx, classId);
    const rows = await tx
      .insert(sections)
      .values({
        tenantId: ctx.tenantId ?? '',
        classId: parent.id,
        campusId: parent.campusId,
        academicYearId: parent.academicYearId,
        code,
        status: 'active',
      })
      .returning();
    const row = rows[0]!;
    await writeAudit(tx, {
      scope: 'tenant',
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action: 'section.created',
      resourceType: 'section',
      resourceId: row.id,
      newValue: toSection(row),
      requestId,
    });
    await enqueueOutbox(tx, {
      tenantId: ctx.tenantId,
      eventType: 'section.created',
      aggregateType: 'section',
      aggregateId: row.id,
      payload: {
        tenantId: ctx.tenantId,
        sectionId: row.id,
        classId: row.classId,
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

export async function updateSection(
  tx: Tx,
  ctx: { userId: string; tenantId: string | null; campusId: string | null },
  classId: string,
  sectionId: string,
  input: { code?: string },
  requestId: string,
): Promise<SectionRow | null> {
  try {
    const parent = await resolveLiveClass(tx, ctx, classId);
    const beforeRows = await tx
      .select()
      .from(sections)
      .where(
        and(
          eq(sections.tenantId, ctx.tenantId ?? ''),
          eq(sections.id, sectionId),
          eq(sections.classId, parent.id),
          isNull(sections.deletedAt),
        ),
      )
      .limit(1)
      .execute();
    const before = beforeRows[0];
    if (!before) return null;

    const rows = await tx
      .update(sections)
      .set(input)
      .where(
        and(
          eq(sections.tenantId, ctx.tenantId ?? ''),
          eq(sections.id, sectionId),
          eq(sections.classId, parent.id),
          isNull(sections.deletedAt),
        ),
      )
      .returning();
    const row = rows[0];
    if (!row) return null;
    await writeAudit(tx, {
      scope: 'tenant',
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action: 'section.updated',
      resourceType: 'section',
      resourceId: row.id,
      oldValue: toSection(before),
      newValue: toSection(row),
      requestId,
    });
    await enqueueOutbox(tx, {
      tenantId: ctx.tenantId,
      eventType: 'section.updated',
      aggregateType: 'section',
      aggregateId: row.id,
      payload: { tenantId: ctx.tenantId, sectionId: row.id, classId: row.classId, code: row.code },
      correlationId: requestId,
    });
    return row;
  } catch (err) {
    throw mapDomainError(err);
  }
}

export async function setSectionStatus(
  tx: Tx,
  ctx: { userId: string; tenantId: string | null; campusId: string | null },
  classId: string,
  sectionId: string,
  status: 'active' | 'inactive',
  requestId: string,
): Promise<SectionRow | null> {
  try {
    const parent = await resolveLiveClass(tx, ctx, classId);
    const rows = await tx
      .update(sections)
      .set({ status })
      .where(
        and(
          eq(sections.tenantId, ctx.tenantId ?? ''),
          eq(sections.id, sectionId),
          eq(sections.classId, parent.id),
          isNull(sections.deletedAt),
        ),
      )
      .returning();
    const row = rows[0];
    if (!row) return null;
    await writeAudit(tx, {
      scope: 'tenant',
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action: status === 'active' ? 'section.activated' : 'section.deactivated',
      resourceType: 'section',
      resourceId: row.id,
      newValue: { status },
      requestId,
    });
    await enqueueOutbox(tx, {
      tenantId: ctx.tenantId,
      eventType: status === 'active' ? 'section.activated' : 'section.deactivated',
      aggregateType: 'section',
      aggregateId: row.id,
      payload: { tenantId: ctx.tenantId, sectionId: row.id, classId: row.classId, status },
      correlationId: requestId,
    });
    return row;
  } catch (err) {
    throw mapDomainError(err);
  }
}

/**
 * Soft-delete a section. The DB guard (BEFORE UPDATE) rejects this while live
 * enrollments reference it (409 section_has_enrollments).
 */
export async function deleteSection(
  tx: Tx,
  ctx: { userId: string; tenantId: string | null; campusId: string | null },
  classId: string,
  sectionId: string,
  requestId: string,
): Promise<SectionRow | null> {
  try {
    const parent = await resolveLiveClass(tx, ctx, classId);
    const beforeRows = await tx
      .select()
      .from(sections)
      .where(
        and(
          eq(sections.tenantId, ctx.tenantId ?? ''),
          eq(sections.id, sectionId),
          eq(sections.classId, parent.id),
          isNull(sections.deletedAt),
        ),
      )
      .limit(1)
      .execute();
    const before = beforeRows[0];
    if (!before) return null;

    const rows = await tx
      .update(sections)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(sections.tenantId, ctx.tenantId ?? ''),
          eq(sections.id, sectionId),
          eq(sections.classId, parent.id),
          isNull(sections.deletedAt),
        ),
      )
      .returning();
    const row = rows[0];
    if (!row) return null;
    await writeAudit(tx, {
      scope: 'tenant',
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action: 'section.deleted',
      resourceType: 'section',
      resourceId: row.id,
      oldValue: toSection(before),
      newValue: { deletedAt: row.deletedAt?.toISOString() ?? null },
      requestId,
    });
    await enqueueOutbox(tx, {
      tenantId: ctx.tenantId,
      eventType: 'section.deleted',
      aggregateType: 'section',
      aggregateId: row.id,
      payload: { tenantId: ctx.tenantId, sectionId: row.id, classId: row.classId },
      correlationId: requestId,
    });
    return row;
  } catch (err) {
    throw mapDomainError(err);
  }
}

export default async function sectionRoutes(app: FastifyInstance) {
  app.get(
    '/api/v1/classes/:id/sections',
    {
      config: { authorization: { kind: 'tenant', permission: 'sections.read' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('sections.read')],
    },
    async (request) => {
      const { id } = idParamSchema.parse(request.params);
      const ctx = request.ctx!;
      const query = sectionListQuerySchema.parse(request.query);
      await withTenant(app.db, ctx, (tx) => resolveLiveClass(tx, ctx, id));
      const conditions = [
        eq(sections.tenantId, ctx.tenantId ?? ''),
        eq(sections.classId, id),
        isNull(sections.deletedAt),
      ];
      if (query.status) conditions.push(eq(sections.status, query.status));
      const rows = await withTenant(app.db, ctx, (tx) =>
        tx
          .select()
          .from(sections)
          .where(and(...conditions))
          .orderBy(desc(sections.createdAt), desc(sections.id))
          .limit(query.limit)
          .offset(query.offset)
          .execute(),
      );
      const totalRow = await withTenant(app.db, ctx, (tx) =>
        tx
          .select({ total: count() })
          .from(sections)
          .where(and(...conditions))
          .execute(),
      );
      return { items: rows.map(toSection), total: totalRow[0]?.total ?? 0 };
    },
  );

  app.post(
    '/api/v1/classes/:id/sections',
    {
      config: { authorization: { kind: 'tenant', permission: 'sections.create' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('sections.create'), requireCsrf()],
    },
    async (request, reply) => {
      const { id } = idParamSchema.parse(request.params);
      const body = createSectionRequestSchema.parse(request.body);
      const ctx = request.ctx!;
      const idemKey = idempotencyKeyFromHeader(request.headers);
      const fingerprint = requestFingerprint(request.method, request.url, body);
      const outcome = await withTenant(app.db, ctx, (tx) =>
        withIdempotency(tx, { tenantId: ctx.tenantId, key: idemKey }, fingerprint, async () => {
          const row = await insertSection(tx, ctx, id, body.code, request.requestId);
          return { status: 201, body: { section: toSection(row) } };
        }),
      );
      return reply.code(outcome.status).send(outcome.body);
    },
  );

  app.get(
    '/api/v1/classes/:id/sections/:sectionId',
    {
      config: { authorization: { kind: 'tenant', permission: 'sections.read' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('sections.read')],
    },
    async (request) => {
      const { id, sectionId } = classSectionParamSchema.parse(request.params);
      const ctx = request.ctx!;
      const row = await withTenant(app.db, ctx, async (tx) => {
        const parent = await resolveLiveClass(tx, ctx, id);
        return tx
          .select()
          .from(sections)
          .where(
            and(
              eq(sections.tenantId, ctx.tenantId ?? ''),
              eq(sections.id, sectionId),
              eq(sections.classId, parent.id),
              isNull(sections.deletedAt),
            ),
          )
          .limit(1)
          .execute()
          .then((r) => r[0]);
      });
      if (!row) throw notFoundError('Section not found');
      return { section: toSection(row) };
    },
  );

  app.patch(
    '/api/v1/classes/:id/sections/:sectionId',
    {
      config: { authorization: { kind: 'tenant', permission: 'sections.update' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('sections.update'), requireCsrf()],
    },
    async (request, reply) => {
      const { id, sectionId } = classSectionParamSchema.parse(request.params);
      const body = updateSectionRequestSchema.parse(request.body);
      const ctx = request.ctx!;
      const idemKey = idempotencyKeyFromHeader(request.headers);
      const fingerprint = requestFingerprint(request.method, request.url, body);
      const outcome = await withTenant(app.db, ctx, (tx) =>
        withIdempotency(tx, { tenantId: ctx.tenantId, key: idemKey }, fingerprint, async () => {
          const row = await updateSection(tx, ctx, id, sectionId, body, request.requestId);
          if (!row) throw notFoundError('Section not found');
          return { status: 200, body: { section: toSection(row) } };
        }),
      );
      return reply.code(outcome.status).send(outcome.body);
    },
  );

  app.post(
    '/api/v1/classes/:id/sections/:sectionId/activate',
    {
      config: { authorization: { kind: 'tenant', permission: 'sections.update' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('sections.update'), requireCsrf()],
    },
    async (request, reply) => {
      const { id, sectionId } = classSectionParamSchema.parse(request.params);
      const ctx = request.ctx!;
      const row = await withTenant(app.db, ctx, (tx) =>
        setSectionStatus(tx, ctx, id, sectionId, 'active', request.requestId),
      );
      if (!row) throw notFoundError('Section not found');
      return { section: toSection(row) };
    },
  );

  app.post(
    '/api/v1/classes/:id/sections/:sectionId/deactivate',
    {
      config: { authorization: { kind: 'tenant', permission: 'sections.update' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('sections.update'), requireCsrf()],
    },
    async (request, reply) => {
      const { id, sectionId } = classSectionParamSchema.parse(request.params);
      const ctx = request.ctx!;
      const row = await withTenant(app.db, ctx, (tx) =>
        setSectionStatus(tx, ctx, id, sectionId, 'inactive', request.requestId),
      );
      if (!row) throw notFoundError('Section not found');
      return { section: toSection(row) };
    },
  );

  app.delete(
    '/api/v1/classes/:id/sections/:sectionId',
    {
      config: { authorization: { kind: 'tenant', permission: 'sections.delete' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('sections.delete'), requireCsrf()],
    },
    async (request, reply) => {
      const { id, sectionId } = classSectionParamSchema.parse(request.params);
      const ctx = request.ctx!;
      const idemKey = idempotencyKeyFromHeader(request.headers);
      const fingerprint = requestFingerprint(request.method, request.url, {});
      const outcome = await withTenant(app.db, ctx, (tx) =>
        withIdempotency(tx, { tenantId: ctx.tenantId, key: idemKey }, fingerprint, async () => {
          const row = await deleteSection(tx, ctx, id, sectionId, request.requestId);
          if (!row) throw notFoundError('Section not found');
          return { status: 200, body: { section: toSection(row) } };
        }),
      );
      return reply.code(outcome.status).send(outcome.body);
    },
  );
}