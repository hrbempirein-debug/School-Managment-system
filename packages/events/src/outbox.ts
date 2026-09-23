import { eq } from 'drizzle-orm';
import { uuidv7 } from '@sms/core';
import { outboxEvents, type Tx } from '@sms/db';
import type { NewOutboxEvent } from '@sms/contracts';

const NEVER_STORE = ['password', 'passwordHash', 'token', 'secret', 'apiKey', 'authorization'];

function sanitizePayload(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    out[k] = NEVER_STORE.includes(k) ? '[redacted]' : v;
  }
  return out;
}

/**
 * Append an event to the transactional outbox INSIDE the same transaction as the
 * business mutation. Nothing is published to Redis from here — the dispatcher
 * delivers later, so an event can never be lost after COMMIT.
 */
export async function enqueueOutbox(tx: Tx, event: NewOutboxEvent): Promise<void> {
  await tx.insert(outboxEvents).values({
    id: uuidv7(),
    tenantId: event.tenantId,
    eventType: event.eventType,
    aggregateType: event.aggregateType,
    aggregateId: event.aggregateId,
    payload: sanitizePayload(event.payload),
    correlationId: event.correlationId ?? null,
    causationId: event.causationId ?? null,
  });
}

export async function markProcessed(tx: Tx, eventId: string): Promise<void> {
  await tx
    .update(outboxEvents)
    .set({ processedAt: new Date(), lastError: null })
    .where(eq(outboxEvents.id, eventId));
}