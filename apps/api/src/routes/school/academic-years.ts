import type { FastifyInstance } from 'fastify';
import { and, count, desc, eq, isNull } from 'drizzle-orm';
import { academicYears, withTenant, type Tx } from '@sms/db';
import { writeAudit } from '@sms/audit';
import { enqueueOutbox } from '@sms/events';
import { requestFingerprint, withIdempotency } from '@sms/idempotency';
import {
  createAcademicYearRequestSchema,
  updateAcademicYearRequestSchema,
  idParamSchema,
  type AcademicYear,
} from '@sms/contracts';
import {
  requireSession,
  requireTenantContext,
  requirePermission,
  requireCsrf,
} from '../../plugins/auth.js';
import { mapDomainError, parsePagination, idempotencyKeyFromHeader, notFoundError } from './util.js';

type YearRow = typeof academicYears.$inferSelect;
type YearStatus = 'draft' | 'active' | 'closed';

export function toAcademicYear(row: YearRow): AcademicYear {
  return {
    id: row.id,
    tenantId: row.tenantId,
    code: row.code,
    name: row.name,
    startsOn: row.startsOn,
    endsOn: row.endsOn,
    status: row.status as AcademicYear['status'],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export interface AcademicYearWriteInput {
  code?: string;
  name?: string;
  startsOn?: string;
  endsOn?: string;
}

export async function insertAcademicYear(
  tx: Tx,
  ctx: { userId: string; tenantId: string | null },
  input: Required<AcademicYearWriteInput>,
  requestId: string,
): Promise<YearRow> {
  try {
    const rows = await tx
      .insert(academicYears)
      .values({
        tenantId: ctx.tenantId ?? '',
        code: input.code,
        name: input.name,
        startsOn: input.startsOn,
        endsOn: input.endsOn,
        status: 'draft',
      })
      .returning();
    const row = rows[0]!;
    await writeAudit(tx, {
      scope: 'tenant',
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action: 'academic.year.created',
      resourceType: 'academic_year',
      resourceId: row.id,
      newValue: toAcademicYear(row),
      requestId,
    });
    await enqueueOutbox(tx, {
      tenantId: ctx.tenantId,
      eventType: 'academic.year.created',
      aggregateType: 'academic_year',
      aggregateId: row.id,
      payload: { tenantId: ctx.tenantId, academicYearId: row.id, code: row.code },
      correlationId: requestId,
    });
    return row;
  } catch (err) {
    throw mapDomainError(err);
  }
}

export async function updateAcademicYear(
  tx: Tx,
  ctx: { userId: string; tenantId: string | null },
  id: string,
  input: AcademicYearWriteInput,
  requestId: string,
): Promise<YearRow | null> {
  try {
    const beforeRows = await tx
      .select()
      .from(academicYears)
      .where(and(eq(academicYears.id, id), isNull(academicYears.deletedAt)))
      .limit(1);
    const rows = await tx
      .update(academicYears)
      .set(input)
      .where(and(eq(academicYears.id, id), isNull(academicYears.deletedAt)))
      .returning();
    const row = rows[0];
    if (!row) return null;
    await writeAudit(tx, {
      scope: 'tenant',
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action: 'academic.year.updated',
      resourceType: 'academic_year',
      resourceId: row.id,
      oldValue: beforeRows[0] ? toAcademicYear(beforeRows[0]) : undefined,
      newValue: toAcademicYear(row),
      requestId,
    });
    await enqueueOutbox(tx, {
      tenantId: ctx.tenantId,
      eventType: 'academic.year.updated',
      aggregateType: 'academic_year',
      aggregateId: row.id,
      payload: { tenantId: ctx.tenantId, academicYearId: row.id, code: row.code },
      correlationId: requestId,
    });
    return row;
  } catch (err) {
    throw mapDomainError(err);
  }
}

export async function setAcademicYearStatus(
  tx: Tx,
  ctx: { userId: string; tenantId: string | null },
  id: string,
  status: YearStatus,
  requestId: string,
): Promise<YearRow | null> {
  try {
    const rows = await tx
      .update(academicYears)
      .set({ status })
      .where(and(eq(academicYears.id, id), isNull(academicYears.deletedAt)))
      .returning();
    const row = rows[0];
    if (!row) return null;
    await writeAudit(tx, {
      scope: 'tenant',
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action: status === 'active' ? 'academic.year.opened' : 'academic.year.closed',
      resourceType: 'academic_year',
      resourceId: row.id,
      newValue: { status },
      requestId,
    });
    await enqueueOutbox(tx, {
      tenantId: ctx.tenantId,
      eventType: status === 'active' ? 'academic.year.opened' : 'academic.year.closed',
      aggregateType: 'academic_year',
      aggregateId: row.id,
      payload: { tenantId: ctx.tenantId, academicYearId: row.id, status },
      correlationId: requestId,
    });
    return row;
  } catch (err) {
    throw mapDomainError(err);
  }
}

export default async function academicYearsRoutes(app: FastifyInstance) {
  app.get(
    '/api/v1/academic-years',
    {
      config: { authorization: { kind: 'tenant', permission: 'academic.years.read' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('academic.years.read')],
    },
    async (request) => {
      const ctx = request.ctx!;
      const { limit, offset } = parsePagination(request.query);
      const rows = await withTenant(app.db, ctx, (tx) =>
        tx
          .select()
          .from(academicYears)
          .where(and(eq(academicYears.tenantId, ctx.tenantId ?? ''), isNull(academicYears.deletedAt)))
          .orderBy(desc(academicYears.createdAt))
          .limit(limit)
          .offset(offset)
          .execute(),
      );
      const totalRow = await withTenant(app.db, ctx, (tx) =>
        tx
          .select({ total: count() })
          .from(academicYears)
          .where(and(eq(academicYears.tenantId, ctx.tenantId ?? ''), isNull(academicYears.deletedAt)))
          .execute(),
      );
      return { items: rows.map(toAcademicYear), total: totalRow[0]?.total ?? 0 };
    },
  );

  app.post(
    '/api/v1/academic-years',
    {
      config: { authorization: { kind: 'tenant', permission: 'academic.years.write' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('academic.years.write'), requireCsrf()],
    },
    async (request, reply) => {
      const body = createAcademicYearRequestSchema.parse(request.body);
      const ctx = request.ctx!;
      const idemKey = idempotencyKeyFromHeader(request.headers);
      const fingerprint = requestFingerprint(request.method, request.url, body);
      const outcome = await withTenant(app.db, ctx, (tx) =>
        withIdempotency(tx, { tenantId: ctx.tenantId, key: idemKey }, fingerprint, async () => {
          const row = await insertAcademicYear(tx, ctx, body, request.requestId);
          return { status: 201, body: { academicYear: toAcademicYear(row) } };
        }),
      );
      return reply.code(outcome.status).send(outcome.body);
    },
  );

  app.get(
    '/api/v1/academic-years/:id',
    {
      config: { authorization: { kind: 'tenant', permission: 'academic.years.read' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('academic.years.read')],
    },
    async (request) => {
      const { id } = idParamSchema.parse(request.params);
      const ctx = request.ctx!;
      const row = await withTenant(app.db, ctx, (tx) =>
        tx
          .select()
          .from(academicYears)
          .where(and(eq(academicYears.id, id), isNull(academicYears.deletedAt)))
          .limit(1)
          .execute()
          .then((r) => r[0]),
      );
      if (!row) throw notFoundError('Academic year not found');
      return { academicYear: toAcademicYear(row) };
    },
  );

  app.patch(
    '/api/v1/academic-years/:id',
    {
      config: { authorization: { kind: 'tenant', permission: 'academic.years.write' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('academic.years.write'), requireCsrf()],
    },
    async (request, reply) => {
      const { id } = idParamSchema.parse(request.params);
      const body = updateAcademicYearRequestSchema.parse(request.body);
      const ctx = request.ctx!;
      const idemKey = idempotencyKeyFromHeader(request.headers);
      const fingerprint = requestFingerprint(request.method, request.url, body);
      const outcome = await withTenant(app.db, ctx, (tx) =>
        withIdempotency(tx, { tenantId: ctx.tenantId, key: idemKey }, fingerprint, async () => {
          const row = await updateAcademicYear(tx, ctx, id, body, request.requestId);
          if (!row) throw notFoundError('Academic year not found');
          return { status: 200, body: { academicYear: toAcademicYear(row) } };
        }),
      );
      return reply.code(outcome.status).send(outcome.body);
    },
  );

  app.post(
    '/api/v1/academic-years/:id/open',
    {
      config: { authorization: { kind: 'tenant', permission: 'academic.years.write' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('academic.years.write'), requireCsrf()],
    },
    async (request) => {
      const { id } = idParamSchema.parse(request.params);
      const ctx = request.ctx!;
      const row = await withTenant(app.db, ctx, (tx) => setAcademicYearStatus(tx, ctx, id, 'active', request.requestId));
      if (!row) throw notFoundError('Academic year not found');
      return { academicYear: toAcademicYear(row) };
    },
  );

  app.post(
    '/api/v1/academic-years/:id/close',
    {
      config: { authorization: { kind: 'tenant', permission: 'academic.years.write' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('academic.years.write'), requireCsrf()],
    },
    async (request) => {
      const { id } = idParamSchema.parse(request.params);
      const ctx = request.ctx!;
      const row = await withTenant(app.db, ctx, (tx) => setAcademicYearStatus(tx, ctx, id, 'closed', request.requestId));
      if (!row) throw notFoundError('Academic year not found');
      return { academicYear: toAcademicYear(row) };
    },
  );
}