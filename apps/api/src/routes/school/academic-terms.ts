import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, count, desc, eq, isNull } from 'drizzle-orm';
import { academicTerms, academicYears, withTenant, type Tx } from '@sms/db';
import { writeAudit } from '@sms/audit';
import { enqueueOutbox } from '@sms/events';
import { requestFingerprint, withIdempotency } from '@sms/idempotency';
import {
  createAcademicTermRequestSchema,
  updateAcademicTermRequestSchema,
  idParamSchema,
  UuidSchema,
  type AcademicTerm,
} from '@sms/contracts';
import {
  requireSession,
  requireTenantContext,
  requirePermission,
  requireCsrf,
} from '../../plugins/auth.js';
import { mapDomainError, parsePagination, idempotencyKeyFromHeader, notFoundError } from './util.js';

type TermRow = typeof academicTerms.$inferSelect;
type TermStatus = 'draft' | 'open' | 'closed';

export function toAcademicTerm(row: TermRow): AcademicTerm {
  return {
    id: row.id,
    tenantId: row.tenantId,
    academicYearId: row.academicYearId,
    code: row.code,
    name: row.name,
    sequence: row.sequence,
    startsOn: row.startsOn,
    endsOn: row.endsOn,
    status: row.status as AcademicTerm['status'],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export interface AcademicTermWriteInput {
  code?: string;
  name?: string;
  sequence?: number;
  startsOn?: string;
  endsOn?: string;
}

export async function insertAcademicTerm(
  tx: Tx,
  ctx: { userId: string; tenantId: string | null },
  academicYearId: string,
  input: Required<AcademicTermWriteInput>,
  requestId: string,
): Promise<TermRow> {
  try {
    const rows = await tx
      .insert(academicTerms)
      .values({
        tenantId: ctx.tenantId ?? '',
        academicYearId,
        code: input.code,
        name: input.name,
        sequence: input.sequence,
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
      action: 'academic.term.created',
      resourceType: 'academic_term',
      resourceId: row.id,
      newValue: toAcademicTerm(row),
      requestId,
    });
    await enqueueOutbox(tx, {
      tenantId: ctx.tenantId,
      eventType: 'academic.term.created',
      aggregateType: 'academic_term',
      aggregateId: row.id,
      payload: { tenantId: ctx.tenantId, academicYearId, academicTermId: row.id, code: row.code },
      correlationId: requestId,
    });
    return row;
  } catch (err) {
    throw mapDomainError(err);
  }
}

export async function updateAcademicTerm(
  tx: Tx,
  ctx: { userId: string; tenantId: string | null },
  id: string,
  input: AcademicTermWriteInput,
  requestId: string,
): Promise<TermRow | null> {
  try {
    const beforeRows = await tx
      .select()
      .from(academicTerms)
      .where(and(eq(academicTerms.id, id), isNull(academicTerms.deletedAt)))
      .limit(1);
    const rows = await tx
      .update(academicTerms)
      .set(input)
      .where(and(eq(academicTerms.id, id), isNull(academicTerms.deletedAt)))
      .returning();
    const row = rows[0];
    if (!row) return null;
    await writeAudit(tx, {
      scope: 'tenant',
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action: 'academic.term.updated',
      resourceType: 'academic_term',
      resourceId: row.id,
      oldValue: beforeRows[0] ? toAcademicTerm(beforeRows[0]) : undefined,
      newValue: toAcademicTerm(row),
      requestId,
    });
    await enqueueOutbox(tx, {
      tenantId: ctx.tenantId,
      eventType: 'academic.term.updated',
      aggregateType: 'academic_term',
      aggregateId: row.id,
      payload: { tenantId: ctx.tenantId, academicTermId: row.id, code: row.code },
      correlationId: requestId,
    });
    return row;
  } catch (err) {
    throw mapDomainError(err);
  }
}

export async function setAcademicTermStatus(
  tx: Tx,
  ctx: { userId: string; tenantId: string | null },
  id: string,
  status: TermStatus,
  requestId: string,
): Promise<TermRow | null> {
  try {
    const rows = await tx
      .update(academicTerms)
      .set({ status })
      .where(and(eq(academicTerms.id, id), isNull(academicTerms.deletedAt)))
      .returning();
    const row = rows[0];
    if (!row) return null;
    await writeAudit(tx, {
      scope: 'tenant',
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action: status === 'open' ? 'academic.term.opened' : 'academic.term.closed',
      resourceType: 'academic_term',
      resourceId: row.id,
      newValue: { status },
      requestId,
    });
    await enqueueOutbox(tx, {
      tenantId: ctx.tenantId,
      eventType: status === 'open' ? 'academic.term.opened' : 'academic.term.closed',
      aggregateType: 'academic_term',
      aggregateId: row.id,
      payload: { tenantId: ctx.tenantId, academicTermId: row.id, status },
      correlationId: requestId,
    });
    return row;
  } catch (err) {
    throw mapDomainError(err);
  }
}

const yearIdParamSchema = z.object({ academicYearId: UuidSchema });

export default async function academicTermsRoutes(app: FastifyInstance) {
  app.get(
    '/api/v1/academic-years/:academicYearId/terms',
    {
      config: { authorization: { kind: 'tenant', permission: 'academic.terms.read' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('academic.terms.read')],
    },
    async (request) => {
      const { academicYearId } = yearIdParamSchema.parse(request.params);
      const ctx = request.ctx!;
      const { limit, offset } = parsePagination(request.query);
      const result = await withTenant(app.db, ctx, async (tx) => {
        const parent = await tx
          .select({ id: academicYears.id })
          .from(academicYears)
          .where(and(eq(academicYears.id, academicYearId), isNull(academicYears.deletedAt)))
          .limit(1)
          .execute();
        if (!parent[0]) return null;
        const rows = await tx
          .select()
          .from(academicTerms)
          .where(and(eq(academicTerms.academicYearId, academicYearId), isNull(academicTerms.deletedAt)))
          .orderBy(desc(academicTerms.sequence))
          .limit(limit)
          .offset(offset)
          .execute();
        const totalRow = await tx
          .select({ total: count() })
          .from(academicTerms)
          .where(and(eq(academicTerms.academicYearId, academicYearId), isNull(academicTerms.deletedAt)))
          .execute();
        return { items: rows.map(toAcademicTerm), total: totalRow[0]?.total ?? 0 };
      });
      if (result === null) throw notFoundError('Academic year not found');
      return result;
    },
  );

  app.post(
    '/api/v1/academic-years/:academicYearId/terms',
    {
      config: { authorization: { kind: 'tenant', permission: 'academic.terms.write' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('academic.terms.write'), requireCsrf()],
    },
    async (request, reply) => {
      const { academicYearId } = yearIdParamSchema.parse(request.params);
      const body = createAcademicTermRequestSchema.parse(request.body);
      const ctx = request.ctx!;
      const idemKey = idempotencyKeyFromHeader(request.headers);
      const fingerprint = requestFingerprint(request.method, request.url, body);
      const outcome = await withTenant(app.db, ctx, (tx) =>
        withIdempotency(tx, { tenantId: ctx.tenantId, key: idemKey }, fingerprint, async () => {
          const row = await insertAcademicTerm(tx, ctx, academicYearId, body, request.requestId);
          return { status: 201, body: { academicTerm: toAcademicTerm(row) } };
        }),
      );
      return reply.code(outcome.status).send(outcome.body);
    },
  );

  app.get(
    '/api/v1/academic-terms/:id',
    {
      config: { authorization: { kind: 'tenant', permission: 'academic.terms.read' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('academic.terms.read')],
    },
    async (request) => {
      const { id } = idParamSchema.parse(request.params);
      const ctx = request.ctx!;
      const row = await withTenant(app.db, ctx, (tx) =>
        tx
          .select()
          .from(academicTerms)
          .where(and(eq(academicTerms.id, id), isNull(academicTerms.deletedAt)))
          .limit(1)
          .execute()
          .then((r) => r[0]),
      );
      if (!row) throw notFoundError('Academic term not found');
      return { academicTerm: toAcademicTerm(row) };
    },
  );

  app.patch(
    '/api/v1/academic-terms/:id',
    {
      config: { authorization: { kind: 'tenant', permission: 'academic.terms.write' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('academic.terms.write'), requireCsrf()],
    },
    async (request, reply) => {
      const { id } = idParamSchema.parse(request.params);
      const body = updateAcademicTermRequestSchema.parse(request.body);
      const ctx = request.ctx!;
      const idemKey = idempotencyKeyFromHeader(request.headers);
      const fingerprint = requestFingerprint(request.method, request.url, body);
      const outcome = await withTenant(app.db, ctx, (tx) =>
        withIdempotency(tx, { tenantId: ctx.tenantId, key: idemKey }, fingerprint, async () => {
          const row = await updateAcademicTerm(tx, ctx, id, body, request.requestId);
          if (!row) throw notFoundError('Academic term not found');
          return { status: 200, body: { academicTerm: toAcademicTerm(row) } };
        }),
      );
      return reply.code(outcome.status).send(outcome.body);
    },
  );

  app.post(
    '/api/v1/academic-terms/:id/open',
    {
      config: { authorization: { kind: 'tenant', permission: 'academic.terms.write' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('academic.terms.write'), requireCsrf()],
    },
    async (request) => {
      const { id } = idParamSchema.parse(request.params);
      const ctx = request.ctx!;
      const row = await withTenant(app.db, ctx, (tx) => setAcademicTermStatus(tx, ctx, id, 'open', request.requestId));
      if (!row) throw notFoundError('Academic term not found');
      return { academicTerm: toAcademicTerm(row) };
    },
  );

  app.post(
    '/api/v1/academic-terms/:id/close',
    {
      config: { authorization: { kind: 'tenant', permission: 'academic.terms.write' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('academic.terms.write'), requireCsrf()],
    },
    async (request) => {
      const { id } = idParamSchema.parse(request.params);
      const ctx = request.ctx!;
      const row = await withTenant(app.db, ctx, (tx) => setAcademicTermStatus(tx, ctx, id, 'closed', request.requestId));
      if (!row) throw notFoundError('Academic term not found');
      return { academicTerm: toAcademicTerm(row) };
    },
  );
}