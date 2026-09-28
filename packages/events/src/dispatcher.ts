import { and, eq, isNull, lt, or } from 'drizzle-orm';
import type { Queue } from 'bullmq';
import { outboxEvents, withSystem, type Db, type Tx } from '@sms/db';
import type { OutboxEvent } from '@sms/contracts';

export const OUTBOX_QUEUE = 'events';
export const OUTBOX_JOB = 'event.process';

/** Re-drive threshold (ms) for rows that were dispatched but never acked. */
export const DISPATCH_REDRIVE_MS = 5 * 60_000;

function serializeEvent(ev: {
  id: string;
  tenantId: string | null;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload: unknown;
  correlationId: string | null;
  causationId: string | null;
  createdAt: Date | string;
}): OutboxEvent {
  return {
    version: 1,
    id: ev.id,
    tenantId: ev.tenantId,
    eventType: ev.eventType as OutboxEvent['eventType'],
    aggregateType: ev.aggregateType,
    aggregateId: ev.aggregateId,
    payload: (ev.payload ?? {}) as Record<string, unknown>,
    correlationId: ev.correlationId,
    causationId: ev.causationId,
    createdAt: typeof ev.createdAt === 'string' ? ev.createdAt : ev.createdAt.toISOString(),
  };
}

/**
 * Deliver pending outbox rows to BullMQ. Runs under the system GUC so it may read
 * events across tenants; per-event processing re-establishes tenant context.
 * BullMQ `jobId = event.id` makes enqueue idempotent across dispatcher crashes.
 *
 * Claim model (at-least-once, multi-replica safe):
 *  - Rows are claimed with `FOR UPDATE SKIP LOCKED` so concurrent dispatcher
 *    replicas never enqueue the same batch twice.
 *  - A row is selected only when it has never been dispatched, or it has been
 *    dispatched more than DISPATCH_REDRIVE_MS ago and never acked. In-flight rows
 *    (fresh dispatched_at, processed_at NULL) are left alone, so the dispatcher
 *    does not spin them every tick and `attempts` is not inflated on dispatch.
 *  - `attempts` is reserved for processing attempts (written by the worker via
 *    failEvent); the dispatcher only stamps dispatched_at.
 *  - A row whose BullMQ job is lost (Redis flush, queue purge) is re-added by the
 *    stale redrive path; jobId dedupe keeps it single-slot while it still exists.
 */
export async function dispatchPendingEvents(
  db: Db,
  queue: Pick<Queue, 'add'>,
  batchSize = 100,
  redriveMs = DISPATCH_REDRIVE_MS,
): Promise<{ dispatched: number }> {
  let dispatched = 0;
  const staleAfter = new Date(Date.now() - redriveMs);
  await withSystem(db, async (tx) => {
    const pending = await tx
      .select()
      .from(outboxEvents)
      .where(
        and(
          isNull(outboxEvents.processedAt),
          or(isNull(outboxEvents.dispatchedAt), lt(outboxEvents.dispatchedAt, staleAfter)),
        ),
      )
      .orderBy(outboxEvents.createdAt)
      .limit(batchSize)
      .for('update', { skipLocked: true })
      .execute();

    for (const row of pending) {
      const event = serializeEvent(row);
      await queue.add(
        OUTBOX_JOB,
        { event },
        {
          jobId: event.id,
          attempts: 5,
          backoff: { type: 'exponential', delay: 2000 },
          removeOnComplete: 100,
          removeOnFail: 200,
        },
      );
      await tx
        .update(outboxEvents)
        .set({ dispatchedAt: new Date() })
        .where(eq(outboxEvents.id, event.id));
      dispatched += 1;
    }
  });
  return { dispatched };
}

export { serializeEvent };

export async function markProcessedById(db: Db, tx: Tx, eventId: string): Promise<void> {
  await tx.update(outboxEvents).set({ processedAt: new Date() }).where(eq(outboxEvents.id, eventId));
}

export async function failEvent(db: Db, eventId: string, error: string, attempts: number): Promise<void> {
  await withSystem(db, async (tx) => {
    await tx
      .update(outboxEvents)
      .set({ lastError: error.slice(0, 2000), attempts: Math.max(attempts, 1) })
      .where(eq(outboxEvents.id, eventId));
  });
}

export async function getUnprocessedCount(db: Db): Promise<number> {
  let count = 0;
  await withSystem(db, async (tx) => {
    const rows = await tx
      .select({ n: sqlCount() })
      .from(outboxEvents)
      .where(isNull(outboxEvents.processedAt))
      .execute();
    count = Number(rows[0]?.n ?? 0);
  });
  return count;
}

import { sql } from 'drizzle-orm';
function sqlCount() {
  return sql<number>`count(*)`;
}