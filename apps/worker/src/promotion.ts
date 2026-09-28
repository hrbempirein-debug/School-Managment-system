import { and, eq, isNull } from 'drizzle-orm';
import { enrollments, promotionBatches, promotionItems, students, type Tx } from '@sms/db';
import { writeAudit } from '@sms/audit';
import { enqueueOutbox } from '@sms/events';
import type { OutboxEvent } from '@sms/contracts';

type Logger = (level: 'info' | 'warn' | 'error', msg: string, data?: unknown) => void;

export interface PromotionHandlerDeps {
  tx: Tx;
  event: OutboxEvent;
}

export type PromotionHandler = (deps: PromotionHandlerDeps) => Promise<void>;

/**
 * Executor for `promotion.batch.execute` (POST /promotion-batches/:id/execute enqueues it).
 *
 * Runs inside runEventHandler's system transaction (app_privileged, app.rls cleared), so
 * tenant scoping is DATA-based: every read/write filters on event.payload.tenantId. Per item:
 *   * student live + active  -> insert an 'active' enrollment in the item's to_academic_year_id;
 *     a 23505 on enrollments_student_year_uq means the student is already promoted there and is
 *     treated as an idempotent success.
 *   * student missing/inactive -> item marked 'failed' with a reason; the batch still completes.
 * A batch that is missing or not in 'in_progress' (already completed, cancelled, or soft-deleted)
 * is a no-op ack so redriven dispatches converge. student.enrolled is enqueued per promoted item
 * with causationId = this event's id. On any handler throw the whole transaction rolls back and
 * BullMQ redrives.
 */
export function makePromotionHandler(log: Logger): PromotionHandler {
  return async ({ tx, event }) => {
    const tenantId = typeof event.payload['tenantId'] === 'string' ? event.payload['tenantId'] : null;
    const batchId = typeof event.payload['batchId'] === 'string' ? event.payload['batchId'] : null;
    if (!tenantId || !batchId) {
      throw new Error("promotion.batch.execute requires string 'tenantId' and 'batchId' in payload");
    }

    const batch = await tx
      .select()
      .from(promotionBatches)
      .where(
        and(
          eq(promotionBatches.tenantId, tenantId),
          eq(promotionBatches.id, batchId),
          isNull(promotionBatches.deletedAt),
        ),
      )
      .limit(1)
      .execute()
      .then((r) => r[0]);

    if (!batch || batch.status !== 'in_progress') {
      log('info', 'promotion.batch.execute: no-op (batch not in progress)', {
        batchId,
        status: batch?.status ?? 'missing',
      });
      return;
    }

    const pending = await tx
      .select()
      .from(promotionItems)
      .where(
        and(
          eq(promotionItems.tenantId, tenantId),
          eq(promotionItems.batchId, batchId),
          eq(promotionItems.status, 'pending'),
        ),
      )
      .execute();

    let promoted = 0;
    let failed = 0;
    for (const item of pending) {
      const student = await tx
          .select()
          .from(students)
          .where(
            and(
              eq(students.tenantId, tenantId),
              eq(students.id, item.studentId),
              isNull(students.deletedAt),
            ),
          )
          .limit(1)
          .execute()
          .then((r) => r[0]);
        if (!student || student.status !== 'active') {
          await tx
            .update(promotionItems)
            .set({ status: 'failed', error: 'student is not active' })
            .where(eq(promotionItems.id, item.id))
            .execute();
          failed += 1;
          continue;
        }

        // Idempotent pre-check: a live enrollment in the target year already
        // satisfies this item (e.g. an earlier redrive or a concurrent execute).
        const existing = await tx
          .select({ id: enrollments.id })
          .from(enrollments)
          .where(
            and(
              eq(enrollments.tenantId, tenantId),
              eq(enrollments.studentId, item.studentId),
              eq(enrollments.academicYearId, item.toAcademicYearId),
              isNull(enrollments.deletedAt),
            ),
          )
          .limit(1)
          .execute();
        if (existing[0]) {
          await tx
            .update(promotionItems)
            .set({ status: 'promoted' })
            .where(eq(promotionItems.id, item.id))
            .execute();
          promoted += 1;
          continue;
        }

        // Insert inside a savepoint so a 23505 (a concurrent executor promoted
        // this student first) rolls back only the savepoint and never aborts the
        // outer transaction, which still has to finish the batch + audit.
        let enrollmentId: string | undefined;
        try {
          await tx.transaction(async (sp) => {
            const inserted = await sp
              .insert(enrollments)
              .values({
                tenantId,
                studentId: item.studentId,
                academicYearId: item.toAcademicYearId,
                status: 'active',
              })
              .returning();
            enrollmentId = inserted[0]!.id;
          });
        } catch (err) {
          const pg = err as { code?: string; constraint?: string };
          if (pg.code === '23505' && pg.constraint === 'enrollments_student_year_uq') {
            // Already promoted in the target year by a concurrent executor.
            await tx
              .update(promotionItems)
              .set({ status: 'promoted' })
              .where(eq(promotionItems.id, item.id))
              .execute();
            promoted += 1;
            continue;
          }
          await tx
            .update(promotionItems)
            .set({ status: 'failed', error: err instanceof Error ? err.message : String(err) })
            .where(eq(promotionItems.id, item.id))
            .execute();
          failed += 1;
          continue;
        }

        await enqueueOutbox(tx, {
          tenantId,
          eventType: 'student.enrolled',
          aggregateType: 'enrollment',
          aggregateId: enrollmentId!,
          payload: {
            tenantId,
            studentId: item.studentId,
            academicYearId: item.toAcademicYearId,
            enrollmentId: enrollmentId!,
          },
          causationId: event.id,
        });

        await tx
          .update(promotionItems)
          .set({ status: 'promoted' })
          .where(eq(promotionItems.id, item.id))
          .execute();
        promoted += 1;
    }

    await tx
      .update(promotionBatches)
      .set({ status: 'completed', completedAt: new Date() })
      .where(eq(promotionBatches.id, batchId))
      .execute();

    await writeAudit(tx, {
      scope: 'tenant',
      tenantId,
      actorUserId: null,
      actorType: 'job',
      action: 'promotion.batch.executed',
      resourceType: 'promotion_batch',
      resourceId: batchId,
      newValue: { batchId, itemCount: pending.length, promoted, failed },
      requestId: event.correlationId ?? event.id,
    });

    log('info', 'promotion.batch.execute completed', { batchId, itemCount: pending.length, promoted, failed });
  };
}