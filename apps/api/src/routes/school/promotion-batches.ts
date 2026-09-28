import type { FastifyInstance } from 'fastify';
import { and, asc, count, desc, eq, isNull } from 'drizzle-orm';
import { HttpError } from '@sms/core';
import {
  academicYears,
  promotionBatches,
  promotionItems,
  students,
  withTenant,
  type Tx,
} from '@sms/db';
import { writeAudit } from '@sms/audit';
import { enqueueOutbox } from '@sms/events';
import { requestFingerprint, withIdempotency } from '@sms/idempotency';
import {
  addPromotionItemsRequestSchema,
  createPromotionBatchRequestSchema,
  idParamSchema,
  promotionBatchListQuerySchema,
  type PromotionBatch,
  type PromotionItem,
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

type BatchRow = typeof promotionBatches.$inferSelect;
type ItemRow = typeof promotionItems.$inferSelect;

export function toPromotionBatch(row: BatchRow): PromotionBatch {
  return {
    id: row.id,
    tenantId: row.tenantId,
    fromAcademicYearId: row.fromAcademicYearId,
    toAcademicYearId: row.toAcademicYearId,
    status: row.status as PromotionBatch['status'],
    createdBy: row.createdBy,
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toPromotionItem(row: ItemRow): PromotionItem {
  return {
    id: row.id,
    tenantId: row.tenantId,
    batchId: row.batchId,
    studentId: row.studentId,
    fromAcademicYearId: row.fromAcademicYearId,
    toAcademicYearId: row.toAcademicYearId,
    fromSectionId: row.fromSectionId,
    toSectionId: row.toSectionId,
    status: row.status as PromotionItem['status'],
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

interface LifecycleCtx {
  userId: string;
  tenantId: string | null;
  campusId: string | null;
}

export async function createPromotionBatch(
  tx: Tx,
  ctx: LifecycleCtx,
  input: { fromAcademicYearId: string; toAcademicYearId: string },
  requestId: string,
): Promise<BatchRow> {
  try {
    for (const id of [input.fromAcademicYearId, input.toAcademicYearId]) {
      const year = await tx
        .select({ id: academicYears.id })
        .from(academicYears)
        .where(
          and(
            eq(academicYears.tenantId, ctx.tenantId ?? ''),
            eq(academicYears.id, id),
            isNull(academicYears.deletedAt),
          ),
        )
        .limit(1)
        .execute()
        .then((r) => r[0]);
      if (!year) throw notFoundError('Academic year not found');
    }
    const inserted = await tx
      .insert(promotionBatches)
      .values({
        tenantId: ctx.tenantId ?? '',
        fromAcademicYearId: input.fromAcademicYearId,
        toAcademicYearId: input.toAcademicYearId,
        status: 'draft',
        createdBy: ctx.userId,
      })
      .returning();
    const batch = inserted[0]!;
    await writeAudit(tx, {
      scope: 'tenant',
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action: 'promotion.batch.created',
      resourceType: 'promotion_batch',
      resourceId: batch.id,
      newValue: {
        fromAcademicYearId: batch.fromAcademicYearId,
        toAcademicYearId: batch.toAcademicYearId,
      },
      requestId,
    });
    return batch;
  } catch (err) {
    throw mapDomainError(err);
  }
}

/**
 * Add students to a DRAFT batch. Every student must belong to the tenant, be live,
 * and pass the campus-scope check; their item carries the batch's from/to years.
 * A student already in the batch hits `promotion_items_batch_student_uq` -> 409
 * `student_already_in_batch`.
 */
export async function addPromotionItems(
  tx: Tx,
  ctx: LifecycleCtx,
  batchId: string,
  studentIds: string[],
  requestId: string,
): Promise<ItemRow[]> {
  try {
    const batch = await tx
      .select()
      .from(promotionBatches)
      .where(
        and(
          eq(promotionBatches.tenantId, ctx.tenantId ?? ''),
          eq(promotionBatches.id, batchId),
          isNull(promotionBatches.deletedAt),
        ),
      )
      .limit(1)
      .execute()
      .then((r) => r[0]);
    if (!batch) throw notFoundError('Promotion batch not found');
    if (batch.status !== 'draft') {
      throw new HttpError('Promotion batch is not in draft state', {
        status: 409,
        code: 'invalid_batch_state',
      });
    }

    const validated: Array<{ studentId: string; campusId: string | null }> = [];
    for (const studentId of studentIds) {
      const student = await tx
        .select({ id: students.id, primaryCampusId: students.primaryCampusId })
        .from(students)
        .where(
          and(
            eq(students.tenantId, ctx.tenantId ?? ''),
            eq(students.id, studentId),
            isNull(students.deletedAt),
          ),
        )
        .limit(1)
        .execute()
        .then((r) => r[0]);
      if (!student) throw notFoundError('Student not found');
      assertCampusScope(ctx, student.primaryCampusId);
      validated.push({ studentId, campusId: student.primaryCampusId });
    }

    const inserted = await tx
      .insert(promotionItems)
      .values(
        validated.map((v) => ({
          tenantId: ctx.tenantId ?? '',
          batchId,
          studentId: v.studentId,
          fromAcademicYearId: batch.fromAcademicYearId,
          toAcademicYearId: batch.toAcademicYearId,
          status: 'pending' as const,
        })),
      )
      .returning();
    for (const item of inserted) {
      await writeAudit(tx, {
        scope: 'tenant',
        tenantId: ctx.tenantId,
        actorUserId: ctx.userId,
        action: 'promotion.batch.item.added',
        resourceType: 'promotion_item',
        resourceId: item.id,
        newValue: {
          batchId,
          studentId: item.studentId,
          fromAcademicYearId: item.fromAcademicYearId,
          toAcademicYearId: item.toAcademicYearId,
          campusId: validated.find((v) => v.studentId === item.studentId)?.campusId ?? null,
        },
        requestId,
      });
    }
    return inserted;
  } catch (err) {
    throw mapDomainError(err);
  }
}

/**
 * Grab a DRAFT batch (guarded single-row UPDATE -> in_progress, single-winner) and
 * enqueue the worker-driven `promotion.batch.execute` event. A batch that no longer
 * exists is 404; one not in draft state is 409 `invalid_batch_state`.
 */
export async function executePromotionBatch(
  tx: Tx,
  ctx: LifecycleCtx,
  batchId: string,
  requestId: string,
): Promise<BatchRow> {
  try {
    const existing = await tx
      .select({ id: promotionBatches.id })
      .from(promotionBatches)
      .where(
        and(
          eq(promotionBatches.tenantId, ctx.tenantId ?? ''),
          eq(promotionBatches.id, batchId),
          isNull(promotionBatches.deletedAt),
        ),
      )
      .limit(1)
      .execute()
      .then((r) => r[0]);
    if (!existing) throw notFoundError('Promotion batch not found');

    const grabbed = await tx
      .update(promotionBatches)
      .set({ status: 'in_progress' })
      .where(
        and(
          eq(promotionBatches.tenantId, ctx.tenantId ?? ''),
          eq(promotionBatches.id, batchId),
          eq(promotionBatches.status, 'draft'),
          isNull(promotionBatches.deletedAt),
        ),
      )
      .returning();
    const batch = grabbed[0];
    if (!batch) {
      throw new HttpError('Promotion batch is not in draft state', {
        status: 409,
        code: 'invalid_batch_state',
      });
    }

    await writeAudit(tx, {
      scope: 'tenant',
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action: 'promotion.batch.execute_requested',
      resourceType: 'promotion_batch',
      resourceId: batch.id,
      newValue: { status: batch.status, itemCount: 0 },
      requestId,
    });
    await enqueueOutbox(tx, {
      tenantId: ctx.tenantId,
      eventType: 'promotion.batch.execute',
      aggregateType: 'promotion_batch',
      aggregateId: batch.id,
      payload: { tenantId: ctx.tenantId, batchId: batch.id },
      correlationId: requestId,
    });
    return batch;
  } catch (err) {
    throw mapDomainError(err);
  }
}

export default async function promotionBatchRoutes(app: FastifyInstance) {
  app.post(
    '/api/v1/promotion-batches',
    {
      config: { authorization: { kind: 'tenant', permission: 'enrollment.manage' } },
      preHandler: [
        requireSession(),
        requireTenantContext(),
        requirePermission('enrollment.manage'),
        requireCsrf(),
      ],
    },
    async (request, reply) => {
      const body = createPromotionBatchRequestSchema.parse(request.body);
      const ctx = request.ctx!;
      const idemKey = idempotencyKeyFromHeader(request.headers);
      const fingerprint = requestFingerprint(request.method, request.url, body);
      const outcome = await withTenant(app.db, ctx, (tx) =>
        withIdempotency(tx, { tenantId: ctx.tenantId, key: idemKey }, fingerprint, async () => {
          const batch = await createPromotionBatch(tx, ctx, body, request.requestId);
          return { status: 201, body: { promotionBatch: toPromotionBatch(batch) } };
        }),
      );
      return reply.code(outcome.status).send(outcome.body);
    },
  );

  app.get(
    '/api/v1/promotion-batches',
    {
      config: { authorization: { kind: 'tenant', permission: 'enrollment.read' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('enrollment.read')],
    },
    async (request) => {
      const ctx = request.ctx!;
      const query = promotionBatchListQuerySchema.parse(request.query);
      const conditions = [
        eq(promotionBatches.tenantId, ctx.tenantId ?? ''),
        isNull(promotionBatches.deletedAt),
      ];
      if (query.status) conditions.push(eq(promotionBatches.status, query.status));
      const rows = await withTenant(app.db, ctx, (tx) =>
        tx
          .select()
          .from(promotionBatches)
          .where(and(...conditions))
          .orderBy(desc(promotionBatches.createdAt), asc(promotionBatches.id))
          .limit(query.limit)
          .offset(query.offset)
          .execute(),
      );
      const totalRow = await withTenant(app.db, ctx, (tx) =>
        tx
          .select({ total: count() })
          .from(promotionBatches)
          .where(and(...conditions))
          .execute(),
      );
      return {
        items: rows.map(toPromotionBatch),
        total: totalRow[0]?.total ?? 0,
      };
    },
  );

  app.get(
    '/api/v1/promotion-batches/:id',
    {
      config: { authorization: { kind: 'tenant', permission: 'enrollment.read' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('enrollment.read')],
    },
    async (request) => {
      const { id } = idParamSchema.parse(request.params);
      const ctx = request.ctx!;
      const batch = await withTenant(app.db, ctx, (tx) =>
        tx
          .select()
          .from(promotionBatches)
          .where(
            and(
              eq(promotionBatches.tenantId, ctx.tenantId ?? ''),
              eq(promotionBatches.id, id),
              isNull(promotionBatches.deletedAt),
            ),
          )
          .limit(1)
          .execute()
          .then((r) => r[0]),
      );
      if (!batch) throw notFoundError('Promotion batch not found');
      const items = await withTenant(app.db, ctx, (tx) =>
        tx
          .select()
          .from(promotionItems)
          .where(
            and(
              eq(promotionItems.tenantId, ctx.tenantId ?? ''),
              eq(promotionItems.batchId, id),
            ),
          )
          .orderBy(asc(promotionItems.id))
          .execute(),
      );
      return { promotionBatch: toPromotionBatch(batch), items: items.map(toPromotionItem) };
    },
  );

  app.post(
    '/api/v1/promotion-batches/:id/items',
    {
      config: { authorization: { kind: 'tenant', permission: 'enrollment.manage' } },
      preHandler: [
        requireSession(),
        requireTenantContext(),
        requirePermission('enrollment.manage'),
        requireCsrf(),
      ],
    },
    async (request, reply) => {
      const { id } = idParamSchema.parse(request.params);
      const body = addPromotionItemsRequestSchema.parse(request.body);
      const ctx = request.ctx!;
      const idemKey = idempotencyKeyFromHeader(request.headers);
      const fingerprint = requestFingerprint(request.method, request.url, body);
      const outcome = await withTenant(app.db, ctx, (tx) =>
        withIdempotency(tx, { tenantId: ctx.tenantId, key: idemKey }, fingerprint, async () => {
          const items = await addPromotionItems(tx, ctx, id, body.studentIds, request.requestId);
          return { status: 201, body: { items: items.map(toPromotionItem) } };
        }),
      );
      return reply.code(outcome.status).send(outcome.body);
    },
  );

  app.post(
    '/api/v1/promotion-batches/:id/execute',
    {
      config: { authorization: { kind: 'tenant', permission: 'enrollment.manage' } },
      preHandler: [
        requireSession(),
        requireTenantContext(),
        requirePermission('enrollment.manage'),
        requireCsrf(),
      ],
    },
    async (request, reply) => {
      const { id } = idParamSchema.parse(request.params);
      const ctx = request.ctx!;
      const idemKey = idempotencyKeyFromHeader(request.headers);
      const fingerprint = requestFingerprint(request.method, request.url, {});
      const outcome = await withTenant(app.db, ctx, (tx) =>
        withIdempotency(tx, { tenantId: ctx.tenantId, key: idemKey }, fingerprint, async () => {
          const batch = await executePromotionBatch(tx, ctx, id, request.requestId);
          return { status: 200, body: { promotionBatch: toPromotionBatch(batch) } };
        }),
      );
      return reply.code(outcome.status).send(outcome.body);
    },
  );
}