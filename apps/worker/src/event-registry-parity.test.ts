import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Job } from 'bullmq';
import { eq } from 'drizzle-orm';
import {
  outboxEventSchema,
  outboxEventTypeSchema,
  type OutboxEvent,
  type OutboxEventType,
} from '@sms/contracts';
import { createDb, outboxEvents, withSystem, type Db } from '@sms/db';
import { getEnv } from '@sms/config';
import { serializeEvent } from '@sms/events';
import { buildHandlers, processEvent } from './worker.js';

/**
 * D2 event-registry remediation — parity between what the DATABASE emits and what
 * the application will accept.
 *
 * THE DEFECT
 * `0028_phase7_finance_security.sql` writes three event types into `outbox_events`
 * through `app_finance_emit_event`:
 *
 *     refund.approved   (0028:1144)
 *     refund.rejected   (0028:1241)
 *     refund.processed  (0028:1291)
 *
 * None of them was in `outboxEventTypeSchema`. The API side could not drift this
 * way — `NewOutboxEvent.eventType` is typed as the union, so TypeScript refuses an
 * unregistered literal at compile time — but SQL has no such check, so three types
 * shipped unregistered. Every refund approval then produced a row the worker could
 * never validate: `processEvent` failed `safeParse`, `processed_at` stayed NULL,
 * and the dispatcher re-drove the row forever.
 *
 * WHY THE GUARD IS DB-SIDE
 * The TS side is already compile-checked. The SQL side is not, and never will be
 * without a migration (a CHECK constraint on `outbox_events.event_type` — recorded
 * as follow-up MIG-1). Until then this suite is the compensating control: it reads
 * the migrations themselves and fails if any `app_finance_emit_event` argument is
 * absent from the enum.
 *
 * Pure parts run in the default suite. The end-to-end part is opt-in
 * (`RUN_RUNTIME_SECURITY_TESTS=1`) and uses the established disposable database.
 */

const enumSet = new Set<string>(outboxEventTypeSchema.options);
const catalog = outboxEventTypeSchema.options as unknown as readonly OutboxEventType[];

const migrationsDir = fileURLToPath(new URL('../../../packages/db/migrations/', import.meta.url));
const sourceRoots = [
  fileURLToPath(new URL('../../../apps/', import.meta.url)),
  fileURLToPath(new URL('../../../packages/', import.meta.url)),
];

/** Every event type the SQL migrations write to `outbox_events`, by literal. */
function dbEmittedEventTypes(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of readdirSync(migrationsDir)) {
    if (!file.endsWith('.sql')) continue;
    const sql = readFileSync(join(migrationsDir, file), 'utf8');
    for (const m of sql.matchAll(/app_finance_emit_event\(\s*'([^']+)'/g)) {
      const type = m[1]!;
      found.set(type, [...(found.get(type) ?? []), file]);
    }
  }
  return found;
}

/** Every `eventType: 'literal'` in production (non-test) TypeScript sources. */
function tsEmittedEventTypes(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir, { withFileTypes: true }).map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === 'node_modules/' || entry === '.next/' || entry === 'dist/') continue;
      const full = join(dir, entry.replace(/\/$/, ''));
      if (entry.endsWith('/')) {
        walk(full);
        continue;
      }
      if (!entry.endsWith('.ts') || entry.endsWith('.test.ts')) continue;
      const src = readFileSync(full, 'utf8');
      for (const m of src.matchAll(/\beventType:\s*'([^']+)'/g)) {
        const type = m[1]!;
        found.set(type, [...(found.get(type) ?? []), full.replace(/\\/g, '/')]);
      }
    }
  };
  for (const root of sourceRoots) walk(root);
  return found;
}

describe('D2: DB-emitted and app-emitted event types are all registered', () => {
  it('the migrations emit exactly the three Phase 7 finance events', () => {
    const emitted = [...dbEmittedEventTypes().keys()].sort();
    expect(emitted, 'the set of SQL outbox emitters changed — re-audit the registry').toEqual([
      'refund.approved',
      'refund.processed',
      'refund.rejected',
    ]);
  });

  it('every event type the DATABASE can write is in the TypeScript registry', () => {
    const missing: string[] = [];
    for (const [type, files] of dbEmittedEventTypes()) {
      if (!enumSet.has(type)) missing.push(`${type} (emitted by ${[...new Set(files)].join(', ')})`);
    }
    expect(
      missing,
      'SQL writes event types the worker cannot validate — this is exactly the D2 poison loop',
    ).toEqual([]);
  });

  it('every event type production code passes to enqueueOutbox is in the registry', () => {
    const missing: string[] = [];
    for (const [type, files] of tsEmittedEventTypes()) {
      if (!enumSet.has(type)) missing.push(`${type} (${[...new Set(files)].join(', ')})`);
    }
    expect(missing).toEqual([]);
  });

  it('the three refund events are registered, unrenamed, and valid in an envelope', () => {
    for (const type of ['refund.approved', 'refund.rejected', 'refund.processed'] as const) {
      expect(catalog, `${type} must be registered`).toContain(type);
      const parsed = outboxEventSchema.safeParse({
        version: 1,
        id: randomUUID(),
        tenantId: randomUUID(),
        eventType: type,
        aggregateType: 'fin_refunds',
        aggregateId: randomUUID(),
        payload: {},
        correlationId: null,
        causationId: null,
        createdAt: new Date().toISOString(),
      });
      expect(parsed.success, `${type} must be accepted by the envelope schema`).toBe(true);
    }
  });

  it('an unregistered event type is still rejected by the envelope schema', () => {
    for (const bogus of ['mystery.thing', 'refund.approval', 'invoice.issued', 'fee.invoice.overdue']) {
      const parsed = outboxEventSchema.safeParse({
        version: 1,
        id: randomUUID(),
        tenantId: randomUUID(),
        eventType: bogus,
        aggregateType: 'x',
        aggregateId: randomUUID(),
        payload: {},
        correlationId: null,
        causationId: null,
        createdAt: new Date().toISOString(),
      });
      expect(parsed.success, `'${bogus}' must NOT be accepted as an outbox event type`).toBe(false);
    }
  });

  it('the worker registry recognises all three refund events (no "no handler registered")', () => {
    const registry = buildHandlers(() => {});
    for (const type of ['refund.approved', 'refund.rejected', 'refund.processed'] as const) {
      expect(typeof registry[type], `${type} has no worker handler — it would fail, not ack`).toBe(
        'function',
      );
    }
    // ...and they are deliberately no-ops, not silently aliased to a real handler.
    expect(registry['refund.approved']).not.toBe(registry['attendance.marked']);
    expect(registry['refund.approved']).not.toBe(registry['report_card.generated']);
  });

  it('an unknown event type still has no disposition in the worker registry', () => {
    const registry = buildHandlers(() => {});
    for (const bogus of ['mystery.thing', 'refund.approval', 'invoice.issued']) {
      expect(registry[bogus], `'${bogus}' must remain unregistered`).toBeUndefined();
    }
  });
});

/** Opt-in: end-to-end proof that a refund event is ACKED, not poison-looped. */
const enabled = process.env.RUN_RUNTIME_SECURITY_TESTS === '1';
const describeDb = enabled ? describe : describe.skip;

describeDb('D2 LIVE: refund events traverse the registry without a poison loop', () => {
  const slug = 'd2r' + randomUUID().slice(0, 8);
  let db: Db;
  let pool: ReturnType<typeof createDb>['pool'];
  let tenantId = '';

  const makeJob = (event: OutboxEvent, attemptsMade: number): Job<{ event: OutboxEvent }> =>
    ({ data: { event }, attemptsMade, id: event.id }) as unknown as Job<{ event: OutboxEvent }>;

  beforeAll(async () => {
    const env = getEnv();
    const created = createDb({ url: env.DATABASE_URL_MIGRATOR });
    db = created.db;
    pool = created.pool;
    tenantId = randomUUID();
    await withSystem(db, (tx) =>
      tx
        .insert(outboxEvents)
        .values({ id: randomUUID(), tenantId, eventType: 'tenant.created', aggregateType: 'tenants', aggregateId: tenantId })
        .execute(),
    );
  });

  afterAll(async () => {
    await withSystem(db, async (tx) =>
      tx.delete(outboxEvents).where(eq(outboxEvents.tenantId, tenantId)).execute(),
    );
    await pool.end();
  });

  const seed = async (type: OutboxEventType): Promise<{ id: string; event: OutboxEvent }> => {
    const id = randomUUID();
    await withSystem(db, (tx) =>
      tx
        .insert(outboxEvents)
        .values({
          id,
          tenantId,
          eventType: type,
          aggregateType: 'fin_refunds',
          aggregateId: randomUUID(),
          payload: { refundId: randomUUID() },
        })
        .execute(),
    );
    const rows = await withSystem(db, (tx) =>
      tx.select().from(outboxEvents).where(eq(outboxEvents.id, id)).execute(),
    );
    return { id, event: serializeEvent(rows[0]!) };
  };

  it.each(['refund.approved', 'refund.rejected', 'refund.processed'] as const)(
    '%s is accepted end-to-end and acked on the FIRST attempt',
    async (type) => {
      const { event } = await seed(type);
      // Uses the REAL production registry — no test-specific handler map.
      await processEvent(db, makeJob(event, 0), buildHandlers(() => {}));
      const rows = await withSystem(db, (tx) =>
        tx.select().from(outboxEvents).where(eq(outboxEvents.id, event.id)).execute(),
      );
      const row = rows[0]!;
      expect(row.processedAt, `${type} was not acked — it would be re-driven forever`).not.toBeNull();
      expect(row.lastError, `${type} recorded an error: ${row.lastError}`).toBeNull();
      expect(row.attempts, 'no retry was needed').toBe(0);
    },
  );

  it('an UNREGISTERED event type is still rejected, recorded, and never silently acked', async () => {
    const id = randomUUID();
    await withSystem(db, (tx) =>
      tx
        .insert(outboxEvents)
        .values({
          id,
          tenantId,
          eventType: 'mystery.thing',
          aggregateType: 'mystery',
          aggregateId: randomUUID(),
          payload: {},
        })
        .execute(),
    );
    const rows = await withSystem(db, (tx) =>
      tx.select().from(outboxEvents).where(eq(outboxEvents.id, id)).execute(),
    );
    const event = serializeEvent(rows[0]!) as unknown as OutboxEvent;
    await expect(processEvent(db, makeJob(event, 0), buildHandlers(() => {}))).rejects.toThrow(
      /invalid outbox event envelope/,
    );
    const after = await withSystem(db, (tx) =>
      tx.select().from(outboxEvents).where(eq(outboxEvents.id, id)).execute(),
    );
    expect(after[0]!.processedAt, 'an invalid envelope must never be acked').toBeNull();
    expect(after[0]!.lastError).toMatch(/invalid outbox event envelope/);
  });
});
