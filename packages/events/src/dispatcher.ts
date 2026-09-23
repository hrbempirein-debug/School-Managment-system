import { eq, isNull } from 'drizzle-orm';
import type { Queue } from 'bullmq';
import { outboxEvents, withSystem, type Db, type Tx } from '@sms/db';
import type { OutboxEvent } from '@sms/contracts';

export const OUTBOX_QUEUE = 'events';
export const OUTBOX_JOB = 'event.process';

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
 */
export async function dispatchPendingEvents(
  db: Db,
  queue: Pick<Queue, 'add'>,
  batchSize = 100,
): Promise<{ dispatched: number }> {
  let dispatched = 0;
  await withSystem(db, async (tx) => {
    const pending = await tx
      .select()
      .from(outboxEvents)
      .where(isNull(outboxEvents.processedAt))
      .orderBy(outboxEvents.createdAt)
      .limit(batchSize)
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
        .set({
          dispatchedAt: new Date(),
          attempts: (row.attempts ?? 0) + 1,
          lastError: null,
        })
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