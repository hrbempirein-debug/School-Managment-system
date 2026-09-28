import { beforeAll, describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { sql, eq, and } from 'drizzle-orm';
import type { Job } from 'bullmq';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { getEnv } from '@sms/config';
import {
  outboxEventSchema,
  outboxEventTypeSchema,
  SUPPORTED_EVENT_VERSION,
  type OutboxEvent,
  type NewOutboxEvent,
  type OutboxEventType,
} from '@sms/contracts';
import {
  campuses,
  auditLogs,
  outboxEvents,
  enrollments,
  promotionBatches,
  promotionItems,
  createDb,
  withSystem,
} from '@sms/db';
import { enqueueOutbox, dispatchPendingEvents, serializeEvent } from '@sms/events';
import {
  processEvent,
  startOutboxWorker,
  buildHandlers,
  type OutboxHandler,
} from './worker.js';

/**
 * Phase 2B.5 outbox/worker integration proofs, run against the REAL disposable test Postgres
 * (school_saas_test) and REAL Redis (Red/RedLI: 127.0.0.1:6379, redis 8.10.1).
 * All rows use a suite-unique tenant; every fixture is removed at the end.
 *
 * Opt-in: RUN_RUNTIME_SECURITY_TESTS=1 (requires migrations 0001..0005 + Redis).
 */
const enabled = process.env.RUN_RUNTIME_SECURITY_TESTS === '1';
const describeDb = enabled ? describe : describe.skip;

describeDb('outbox + worker integration (real PG + real Redis/BullMQ)', () => {
  let db: ReturnType<typeof createDb>['db'];
  let pool: ReturnType<typeof createDb>['pool'];
  let tenantA: string;
  let slug: string;

  const silentLog = (): void => {};

  const outboxEventTypeSchemaOptions = outboxEventTypeSchema.options as readonly OutboxEventType[];

  beforeAll(async () => {
    const env = getEnv();
    const created = createDb({ url: env.DATABASE_URL_MIGRATOR });
    db = created.db;
    pool = created.pool;
    tenantA = randomUUID();
    slug = 'bx' + randomUUID().slice(0, 8);
    await withSystem(db, async (tx) => {
      // Drain any rows left pending by an earlier aborted gated run so the
      // dispatcher claim/redrive counts below assert against fixtures only.
      await tx.execute(
        sql`update outbox_events set dispatched_at = now() where processed_at is null`,
      );
      await tx.execute(
        sql`insert into tenants (id, slug, name) values (${tenantA}, ${`t-${slug}`}, 'Outbox Suite Tenant') on conflict do nothing`,
      );
    });
  });

  afterAll(async () => {
    try {
      await withSystem(db, async (tx) => {
        await tx.execute(sql`delete from outbox_events where tenant_id = ${tenantA}`);
        await tx.execute(sql`delete from audit_logs where tenant_id = ${tenantA}`);
        await tx.execute(sql`delete from campuses where tenant_id = ${tenantA}`);
        await tx.execute(sql`delete from tenants where id = ${tenantA}`);
      });
    } catch {
      // best-effort cleanup
    }
    await pool.end();
  });

  /**
   * The Redis connection is returned alongside the Queue and MUST be closed with it.
   *
   * `Queue.close()` only closes the queue when BullMQ OWNS the connection. Given a
   * caller-supplied `connection`, BullMQ leaves it open, so the previous version of
   * this helper - which created a connection, returned only `{ queue }`, and closed
   * only the queue - leaked one live ioredis socket per call. That is a real defect in
   * a test harness: sockets accumulate for the life of the file and the abandoned
   * ones emit terminal `error` events on their way out.
   *
   * Note this was NOT the cause of the intermittent "Connection is closed" failures
   * seen locally while validating this file. Those traced to Redis being unreachable
   * from the test process (ECONNREFUSED on every attempt, on both the loopback
   * address and the WSL address, while `redis-cli` inside the VM answered PONG), i.e.
   * host networking rather than anything in this file. The fix below stands on its
   * own merit; the teardown is simply no longer leaking.
   */
  const makeQueue = async (name: string): Promise<{ queue: Queue; conn: Redis }> => {
    const conn = new Redis(getEnv().REDIS_URL, {
      maxRetriesPerRequest: null,
      enableOfflineQueue: false,
      lazyConnect: true,
    });
    await conn.connect();
    const queue = new Queue(name, { connection: conn as never });
    return { queue, conn };
  };

  const closeQueue = async (queue: Queue, conn: Redis): Promise<void> => {
    await queue.close().catch(() => {});
    // `quit()` is the graceful path; `disconnect()` is the fallback for a socket that
    // is already gone, so teardown cannot itself throw and mask a real failure.
    try {
      await conn.quit();
    } catch {
      conn.disconnect();
    }
  };

  const withIsolatedQueue = async (
    name: string,
    fn: (queue: Queue) => Promise<void>,
  ): Promise<void> => {
    const { queue, conn } = await makeQueue(name);
    try {
      await fn(queue);
    } finally {
      await closeQueue(queue, conn);
    }
  };

  const enqueueFixture = async (partial: Partial<NewOutboxEvent> & Pick<NewOutboxEvent, 'eventType' | 'aggregateType' | 'aggregateId'>): Promise<string> => {
    let id = '';
    await withSystem(db, async (tx) => {
      await enqueueOutbox(tx, {
        tenantId: tenantA,
        eventType: partial.eventType,
        aggregateType: partial.aggregateType,
        aggregateId: partial.aggregateId,
        payload: partial.payload ?? { tenantId: tenantA },
        correlationId: partial.correlationId ?? randomUUID(),
      });
    });
    const rows = await withSystem(db, async (tx) =>
      tx
        .select({ id: outboxEvents.id })
        .from(outboxEvents)
        .where(eq(outboxEvents.aggregateId, partial.aggregateId))
        .limit(1)
        .execute(),
    );
    id = rows[0]?.id ?? '';
    expect(id.length).toBeGreaterThan(0);
    return id;
  };

  const getRow = async (id: string): Promise<typeof outboxEvents.$inferSelect> => {
    const rows = await withSystem(db, async (tx) =>
      tx.select().from(outboxEvents).where(eq(outboxEvents.id, id)).limit(1).execute(),
    );
    return rows[0]!;
  };

  const makeJob = (event: OutboxEvent, attemptsMade = 0, id?: string): Job<{ event: OutboxEvent }> =>
    ({
      data: { event },
      attemptsMade,
      id: id ?? event.id,
    }) as unknown as Job<{ event: OutboxEvent }>;

  const poll = async (fn: () => Promise<boolean>, timeoutMs: number, everyMs = 100): Promise<void> => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (await fn()) return;
      await new Promise((r) => setTimeout(r, everyMs));
    }
    throw new Error('poll timeout');
  };

  // ── Section 8: domain + audit + outbox atomicity ─────────────────────────
  it('1. rolls back domain+audit+outbox as ONE transaction', async () => {
    const action = 'campus.created';
    const code = `at-${slug}`;
    await expect(
      withSystem(db, async (tx) => {
        const c = (
          await tx
            .insert(campuses)
            .values({ tenantId: tenantA, code, name: 'Atomic' })
            .returning()
        )[0]!;
        await tx.insert(auditLogs).values({
          scope: 'tenant',
          tenantId: tenantA,
          actorType: 'user',
          action,
          resourceType: 'campus',
          resourceId: c.id,
          newValue: { id: c.id, code },
        });
        await enqueueOutbox(tx, {
          tenantId: tenantA,
          eventType: 'campus.created',
          aggregateType: 'campus',
          aggregateId: c.id,
          payload: { tenantId: tenantA, campusId: c.id },
          correlationId: randomUUID(),
        });
        throw new Error('simulated mid-transaction failure');
      }),
    ).rejects.toThrow('simulated mid-transaction failure');

    const rows = await withSystem(db, async (tx) =>
      tx.execute(
        sql`select
             (select count(*) from campuses where tenant_id = ${tenantA} and code = ${code}) c,
             (select count(*) from audit_logs where tenant_id = ${tenantA} and action = ${action}) a,
             (select count(*) from outbox_events where tenant_id = ${tenantA} and event_type = ${action}) o`,
      ),
    );
    const r = rows.rows[0] as { c: string; a: string; o: string };
    expect([Number(r.c), Number(r.a), Number(r.o)]).toEqual([0, 0, 0]);
  });

  it('2. commits domain+audit+outbox as ONE transaction', async () => {
    const action = 'campus.created';
    const code = `cm-${slug}`;
    let campusId = '';
    await withSystem(db, async (tx) => {
const c = (
          await tx
            .insert(campuses)
            .values({ tenantId: tenantA, code, name: 'Committed' })
            .returning()
        )[0]!;
      campusId = c.id;
      await tx.insert(auditLogs).values({
        scope: 'tenant',
        tenantId: tenantA,
        actorType: 'user',
        action,
        resourceType: 'campus',
        resourceId: c.id,
        newValue: { id: c.id, code },
      });
      await enqueueOutbox(tx, {
        tenantId: tenantA,
        eventType: 'campus.created',
        aggregateType: 'campus',
        aggregateId: c.id,
        payload: { tenantId: tenantA, campusId: c.id },
        correlationId: randomUUID(),
      });
    });

    const rows = await withSystem(db, async (tx) =>
      tx.execute(
        sql`select
             (select count(*) from campuses where tenant_id = ${tenantA} and id = ${campusId}) c,
             (select count(*) from audit_logs where tenant_id = ${tenantA} and action = ${action}) a,
             (select count(*) from outbox_events where tenant_id = ${tenantA} and event_type = ${action}) o`,
      ),
    );
    const r = rows.rows[0] as { c: string; a: string; o: string };
    expect([Number(r.c), Number(r.a), Number(r.o)]).toEqual([1, 1, 1]);

    // Clean the committed fixture so later dispatcher claim/redrive counts stay
    // fixture-only and the afterAll tenant teardown finds no trailing rows.
    await withSystem(db, async (tx) => {
      await tx.execute(sql`delete from outbox_events where tenant_id = ${tenantA} and event_type = ${action}`);
      await tx.execute(sql`delete from audit_logs where tenant_id = ${tenantA} and action = ${action}`);
      await tx.execute(sql`delete from campuses where id = ${campusId}`);
    });
  });

  // ── Sections 5-7, 9-10: dispatcher claim / redrive / dedupe ──────────────
  it('3. dispatcher claims a pending row once, stamps dispatched_at, keeps attempts at 0', async () => {
    const aggId = randomUUID();
    const id = await enqueueFixture({ eventType: 'campus.created', aggregateType: 'campus', aggregateId: aggId });
    const before = await getRow(id);
    expect(before.processedAt).toBeNull();
    expect(before.dispatchedAt).toBeNull();

    await withIsolatedQueue(`it-claim-${slug}`, async (queue) => {
      const first = await dispatchPendingEvents(db, queue, 100);
      expect(first.dispatched).toBe(1);

      const claimed = await getRow(id);
      expect(claimed.dispatchedAt).not.toBeNull();
      expect(claimed.processedAt).toBeNull();
      expect(claimed.attempts).toBe(0);

      const job = await queue.getJob(id);
      expect(job).not.toBeNull();
      expect(job!.name).toBe('event.process');
      expect(job!.data.event.id).toBe(id);
      expect(job!.data.event.version).toBe(1);
      expect(job!.data.event.tenantId).toBe(tenantA);

      // In-flight re-scan: freshly dispatched + unprocessed rows are NOT re-enqueued
      const second = await dispatchPendingEvents(db, queue, 100);
      expect(second.dispatched).toBe(0);
      const afterSecond = await getRow(id);
      expect(afterSecond.attempts).toBe(0);
      expect(afterSecond.lastError).toBeNull();
    });
    await withSystem(db, async (tx) =>
      tx.delete(outboxEvents).where(eq(outboxEvents.id, id)).execute(),
    );
  });

  it('4. stale unacknowledged rows are re-driven once without duplicate queue slots', async () => {
    const aggId = randomUUID();
    const id = await enqueueFixture({ eventType: 'campus.created', aggregateType: 'campus', aggregateId: aggId });
    await withIsolatedQueue(`it-stale-${slug}`, async (queue) => {
      await dispatchPendingEvents(db, queue, 100);
      await withSystem(db, async (tx) =>
        tx
          .update(outboxEvents)
          .set({ dispatchedAt: new Date(Date.now() - 10 * 60 * 1000) })
          .where(eq(outboxEvents.id, id))
          .execute(),
      );
      const stale = await getRow(id);
      expect(stale.dispatchedAt!.getTime()).toBeLessThan(Date.now() - 9 * 60 * 1000);

      const third = await dispatchPendingEvents(db, queue, 100);
      expect(third.dispatched).toBe(1);
      const counts = await queue.getJobCounts();
      expect(counts.waiting).toBe(1);
      const redriven = await getRow(id);
      expect(redriven.attempts).toBe(0);
      expect(redriven.lastError).toBeNull();
    });
    await withSystem(db, async (tx) =>
      tx.delete(outboxEvents).where(eq(outboxEvents.id, id)).execute(),
    );
  });

  it('5. concurrent dispatcher replicas never enqueue the same pending row twice', async () => {
    const aggIds = Array.from({ length: 5 }, () => randomUUID());
    for (const a of aggIds) {
      await enqueueFixture({ eventType: 'campus.created', aggregateType: 'campus', aggregateId: a });
    }
    await withIsolatedQueue(`it-skip-${slug}`, async (queue) => {
      const [r1, r2] = await Promise.all([
        dispatchPendingEvents(db, queue, 10),
        dispatchPendingEvents(db, queue, 10),
      ]);
      expect(r1.dispatched + r2.dispatched).toBe(5);
      const counts = await queue.getJobCounts();
      expect(counts.waiting).toBe(5);
    });
    for (const aggId of aggIds) {
      const rows = await withSystem(db, async (tx) =>
        tx
          .select()
          .from(outboxEvents)
          .where(eq(outboxEvents.aggregateId, aggId))
          .execute(),
      );
      for (const row of rows) expect(row.dispatchedAt).not.toBeNull();
    }
    await withSystem(db, async (tx) =>
      tx
        .delete(outboxEvents)
        .where(sql`tenant_id = ${tenantA} and event_type = 'campus.created'`)
        .execute(),
    );
  });

  // ── Section 1-4: envelope contract + payload hygiene ─────────────────────
  it('6. envelope schema enforces typed event names; unknown types are rejected', () => {
    const base = {
      id: randomUUID(),
      tenantId: tenantA,
      payload: {},
      correlationId: null,
      causationId: null,
      createdAt: new Date().toISOString(),
    };
    const good = outboxEventSchema.safeParse({ ...base, eventType: 'campus.created', aggregateType: 'campus', aggregateId: 'x' });
    expect(good.success).toBe(true);
    if (good.success) expect(good.data.version).toBe(1);

    const bad = outboxEventSchema.safeParse({ ...base, eventType: 'mystery.thing', aggregateType: 'campus', aggregateId: 'x' });
    expect(bad.success).toBe(false);
  });

  it('7. outbox payloads redact sensitive keys at the write path', async () => {
    const aggId = randomUUID();
    await withSystem(db, async (tx) => {
      await enqueueOutbox(tx, {
        tenantId: tenantA,
        eventType: 'campus.created',
        aggregateType: 'campus',
        aggregateId: aggId,
        payload: { tenantId: tenantA, campusId: aggId, password: 'hunter2', token: 'sekret', apiKey: 'abc' },
      });
    });
    const rows = await withSystem(db, async (tx) =>
      tx.select().from(outboxEvents).where(eq(outboxEvents.aggregateId, aggId)).limit(1).execute(),
    );
    const row = rows[0]!;
    const payload = row.payload as Record<string, unknown>;
    expect(payload['password']).toBe('[redacted]');
    expect(payload['token']).toBe('[redacted]');
    expect(payload['apiKey']).toBe('[redacted]');
    await withSystem(db, async (tx) =>
      tx.delete(outboxEvents).where(eq(outboxEvents.aggregateId, aggId)).execute(),
    );
  });

  // ── Sections 11-12, 15: handler registry, unknown/malformed, retry ────────
  it('8. every declared event type (93) has exactly one registered handler; registry count equals catalog count', () => {
    const registry = buildHandlers(silentLog);
    const catalog = Object.values(outboxEventTypeSchemaOptions);
    // 89 through Phase 5; Phase 6 adds exam.result.compute, exam.published,
    // report_card.generated and result.corrected. Pinning the number is the point:
    // a new event type must be registered deliberately, never drift in.
    expect(catalog.length).toBe(93);
    expect(Object.keys(registry).length).toBe(catalog.length);
    for (const t of catalog) {
      expect(typeof registry[t]).toBe('function');
    }
    // an undeclared type has no disposition and is not silently registered
    expect(registry['mystery.thing']).toBeUndefined();
  });

  it('9. a Malformed envelope is rejected by the worker (no silent ack)', async () => {
    const aggId = randomUUID();
    const id = await enqueueFixture({ eventType: 'campus.created', aggregateType: 'campus', aggregateId: aggId });
    const bad = {
      id,
      eventType: 'campus.created',
      aggregateType: 42, // must be a string
      aggregateId: aggId,
      payload: {},
      correlationId: null,
      causationId: null,
      createdAt: new Date().toISOString(),
    };
    const job = makeJob(bad as unknown as OutboxEvent, 0, id);
    await expect(processEvent(db, job, {})).rejects.toThrow(/invalid outbox event envelope/);
    const after = await getRow(id);
    expect(after.processedAt).toBeNull();
    expect(after.attempts).toBe(1);
    expect(after.lastError).toMatch(/invalid outbox event envelope/);
    await withSystem(db, async (tx) =>
      tx.delete(outboxEvents).where(eq(outboxEvents.id, id)).execute(),
    );
  });

  it('10. an event with no registered handler is recorded and NOT silently acked', async () => {
    const aggId = randomUUID();
    const id = await enqueueFixture({ eventType: 'campus.created', aggregateType: 'campus', aggregateId: aggId });
    const row = await getRow(id);
    const event = serializeEvent(row);
    const job = makeJob(event, 0, id);
    await expect(processEvent(db, job, {})).rejects.toThrow(/no handler registered for event type 'campus.created'/);
    const after = await getRow(id);
    expect(after.processedAt).toBeNull();
    expect(after.attempts).toBe(1);
    expect(after.lastError).toContain("event type 'campus.created'");
    await withSystem(db, async (tx) =>
      tx.delete(outboxEvents).where(eq(outboxEvents.id, id)).execute(),
    );
  });

  it('11. a known handler acks (processed_at set) and duplicate delivery stays safe', async () => {
    const aggId = randomUUID();
    const id = await enqueueFixture({ eventType: 'campus.created', aggregateType: 'campus', aggregateId: aggId });
    const row = await getRow(id);
    const event = serializeEvent(row);
    let calls = 0;
    const registry: Record<string, OutboxHandler> = {
      'campus.created': async () => {
        calls += 1;
      },
    };
    await processEvent(db, makeJob(event, 0, id), registry);
    const processedRow = await getRow(id);
    expect(processedRow.processedAt).not.toBeNull();
    expect(processedRow.lastError).toBeNull();
    expect(calls).toBe(1);

    // at-least-once redelivery: re-running the handler must remain side-effect
    // safe. Phase 2B handlers are log-only (no external effects), so calls just
    // increment; the ack is idempotent and the outbox stays a single row.
    await processEvent(db, makeJob(event, 0, id), registry);
    const again = await getRow(id);
    expect(again.processedAt).not.toBeNull();
    expect(calls).toBe(2);
    await withSystem(db, async (tx) =>
      tx.delete(outboxEvents).where(eq(outboxEvents.id, id)).execute(),
    );
  });

  it('12. a failing handler retries via BullMQ and converges once attempts clear', async () => {
    const aggId = randomUUID();
    const id = await enqueueFixture({ eventType: 'campus.created', aggregateType: 'campus', aggregateId: aggId });
    const row = await getRow(id);
    const event = serializeEvent(row);
    const queueName = `it-retry-${slug}`;
    let calls = 0;
    const fragile: Record<string, OutboxHandler> = {
      'campus.created': async ({ tx, event: ev }) => {
        calls += 1;
        const rows = await tx
          .select({ a: outboxEvents.attempts })
          .from(outboxEvents)
          .where(eq(outboxEvents.id, ev.id))
          .limit(1)
          .execute();
        if ((rows[0]?.a ?? 0) < 1) throw new Error('transient failure');
      },
    };
    const conn = new Redis(getEnv().REDIS_URL, { maxRetriesPerRequest: null, enableOfflineQueue: false, lazyConnect: true });
    await conn.connect();
    const queue = new Queue(queueName, { connection: conn as never });
    const worker = new Worker(
      queueName,
      (job) => processEvent(db, job as Job<{ event: OutboxEvent }>, fragile) as Promise<void>,
      { connection: conn as never, concurrency: 1 },
    );
    await queue.add('event.process', { event }, { jobId: id, attempts: 5, backoff: { type: 'exponential', delay: 100 } });
    try {
      await poll(async () => (await getRow(id)).processedAt !== null, 15_000);
    } finally {
      await worker.close();
      await queue.close();
      await conn.quit();
    }
    expect(calls).toBeGreaterThan(1);
    const finalRow = await getRow(id);
    expect(finalRow.processedAt).not.toBeNull();
    await withSystem(db, async (tx) =>
      tx.delete(outboxEvents).where(eq(outboxEvents.id, id)).execute(),
    );
  });

  // ── Section 13: worker security context ──────────────────────────────────
  it('13. worker runs on the trusted-executor path with NO forged tenant ticket', async () => {
    const aggId = randomUUID();
    const id = await enqueueFixture({ eventType: 'campus.created', aggregateType: 'campus', aggregateId: aggId });
    const row = await getRow(id);
    const event = serializeEvent(row);
    let ctx: Record<string, string | null> = {};
    const spy: Record<string, OutboxHandler> = {
      'campus.created': async ({ tx }) => {
        const rows = await tx.execute(
          sql`select current_user u, app_ctx_scope() s, app_current_tenant_id() t, app_privileged() p, current_setting('app.rls', true) rls`,
        );
        ctx = rows.rows[0] as unknown as Record<string, string | null>;
      },
    };
    await processEvent(db, makeJob(event, 0, id), spy);
    expect(ctx['u']).toBe('school_migrator');
    expect(ctx['s']).toBeNull(); // no signed tenant ticket minted for the worker
    expect(ctx['t']).toBeNull();
    expect(ctx['p']).toBe(true); // policy escape only through the trusted role
    expect(ctx['rls']).toBe('');

    // Static guard: the worker source must not use raw escalations or forging.
    const src = await readFile(new URL('./worker.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/SET\s+ROLE/i);
    expect(src).not.toMatch(/BYPASSRLS/i);
    expect(src).not.toMatch(/DISABLE\s+ROW\s+LEVEL\s+SECURITY/i);
    expect(src).not.toMatch(/set_role/i);
    await withSystem(db, async (tx) =>
      tx.delete(outboxEvents).where(eq(outboxEvents.id, id)).execute(),
    );
  });

  it('14. handler tenant scoping is DATA-based (event.tenant_id), never GUC-based', async () => {
    const tenantB = randomUUID();
    const aggId = randomUUID();
    const marker = `sec-${slug}`;
    await withSystem(db, async (tx) => {
      await tx.execute(
        sql`insert into tenants (id, slug, name) values (${tenantB}, ${`b-${slug}`}, 'Suite Tenant B') on conflict do nothing`,
      );
      await tx.insert(campuses).values({ tenantId: tenantA, code: marker, name: 'A' });
      await tx.insert(campuses).values({ tenantId: tenantB, code: marker, name: 'B' });
    });
    const id = await enqueueFixture({ eventType: 'campus.created', aggregateType: 'campus', aggregateId: aggId });
    const row = await getRow(id);
    const event = serializeEvent(row);
    let seen = -1;
    const scoped: Record<string, OutboxHandler> = {
      'campus.created': async ({ tx, event: ev }) => {
        const rows = await tx
          .select({ id: campuses.id })
          .from(campuses)
          .where(and(eq(campuses.tenantId, ev.tenantId as string), eq(campuses.code, marker)))
          .execute();
        seen = rows.length;
      },
    };
    await processEvent(db, makeJob(event, 0, id), scoped);
    expect(seen).toBe(1); // only the event's tenant row, despite two markers existing
    await withSystem(db, async (tx) => {
      await tx.execute(sql`delete from campuses where code = ${marker}`);
      await tx.execute(sql`delete from outbox_events where id = ${id}`);
      await tx.execute(sql`delete from tenants where id = ${tenantB}`);
    });
  });

  // ── Section 14: live Redis/BullMQ dispatcher → worker e2e ────────────────
  it('15. LIVE: dispatcher enqueues and the outbox worker delivers + acks end-to-end', async () => {
    const aggId = randomUUID();
    const id = await enqueueFixture({ eventType: 'campus.created', aggregateType: 'campus', aggregateId: aggId });
    const queueName = `it-e2e-${slug}`;
    const conn = new Redis(getEnv().REDIS_URL, { maxRetriesPerRequest: null, enableOfflineQueue: false, lazyConnect: true });
    await conn.connect();
    const queue = new Queue(queueName, { connection: conn as never });
    const runtime = startOutboxWorker({ db, redis: conn, log: silentLog, queueName });
    try {
      const first = await dispatchPendingEvents(db, queue, 100);
      expect(first.dispatched).toBe(1);
      await poll(async () => (await getRow(id)).processedAt !== null, 15_000);
      const after = await getRow(id);
      expect(after.processedAt).not.toBeNull();
      expect(after.lastError).toBeNull();
      const second = await dispatchPendingEvents(db, queue, 100);
      expect(second.dispatched).toBe(0);
    } finally {
      await runtime.close();
      await queue.close();
      await conn.quit();
    }
    await withSystem(db, async (tx) =>
      tx.delete(outboxEvents).where(eq(outboxEvents.id, id)).execute(),
    );
  }, 30_000);

  it('16. LIVE: mail worker delivers a mail.stub.send job to completion', async () => {
    const queueName = `it-e2e-mail-${slug}`;
    const conn = new Redis(getEnv().REDIS_URL, { maxRetriesPerRequest: null, enableOfflineQueue: false, lazyConnect: true });
    await conn.connect();
    // A PRIVATE mail queue: the shared 'mail' queue may be served by a dev worker
    // running alongside the suite, which would consume the job and leave `seen`
    // empty for reasons that have nothing to do with this worker.
    const queue = new Queue(queueName, { connection: conn as never });
    const seen: string[] = [];
    const captureLog: Parameters<typeof startOutboxWorker>[0]['log'] = (_level, msg) => {
      seen.push(msg);
    };
    const runtime = startOutboxWorker({
      db,
      redis: conn,
      log: captureLog,
      queueName: `it-e2e-events-${slug}`,
      mailQueueName: queueName,
    });
    const jobId = `mail-${randomUUID()}`;
    try {
      await queue.add(
        'mail.stub.send',
        {
          data: {
            to: 'adhoc@example.com',
            template: 'welcome',
            data: {},
            tenantId: tenantA,
            correlationId: randomUUID(),
          },
        },
        { jobId, attempts: 2, removeOnComplete: false, removeOnFail: false },
      );
      await poll(async () => {
        const j = await queue.getJob(jobId);
        if (j === null || j === undefined) return false;
        const st = await j.getState();
        return st === 'completed';
      }, 15_000);
      expect(seen).toContain('mail.stub.send');
    } finally {
      await runtime.close();
      await queue.close();
      await conn.quit();
    }
  }, 30_000);

  // ── Verification pass: envelope version matrix + payload contracts ────────
  it('17. envelope version matrix: v1 ok; missing → 1; non-integer/0/-1/2/999 rejected', () => {
    const base = {
      id: randomUUID(),
      tenantId: tenantA,
      eventType: 'campus.created',
      aggregateType: 'campus',
      aggregateId: 'x',
      payload: {},
      correlationId: null,
      causationId: null,
      createdAt: new Date().toISOString(),
    };
    expect(SUPPORTED_EVENT_VERSION).toBe(1);

    const missing = outboxEventSchema.safeParse(base);
    expect(missing.success).toBe(true);
    if (missing.success) expect(missing.data.version).toBe(1);

    expect(outboxEventSchema.safeParse({ ...base, version: 1 }).success).toBe(true);
    expect(outboxEventSchema.safeParse({ ...base, version: '1' }).success).toBe(false);
    expect(outboxEventSchema.safeParse({ ...base, version: true }).success).toBe(false);
    expect(outboxEventSchema.safeParse({ ...base, version: 0 }).success).toBe(false);
    expect(outboxEventSchema.safeParse({ ...base, version: -1 }).success).toBe(false);
    expect(outboxEventSchema.safeParse({ ...base, version: 2 }).success).toBe(false);
    expect(outboxEventSchema.safeParse({ ...base, version: 999 }).success).toBe(false);
  });

  it('18. a supported-v1 event with a generic payload reaches the handler; a non-object payload for a known type is rejected', async () => {
    const base = {
      id: randomUUID(),
      tenantId: tenantA,
      eventType: 'campus.created',
      aggregateType: 'campus',
      aggregateId: 'x',
      correlationId: null,
      causationId: null,
      createdAt: new Date().toISOString(),
    };
    // generic object payload (any shape) is the current contract boundary
    expect(outboxEventSchema.safeParse({ ...base, payload: { code: 42, name: 'X' } }).success).toBe(true);
    expect(outboxEventSchema.safeParse({ ...base, payload: {} }).success).toBe(true);
    // non-record payloads are rejected even for a known event type
    expect(outboxEventSchema.safeParse({ ...base, payload: 'oops' }).success).toBe(false);
    expect(outboxEventSchema.safeParse({ ...base, payload: null }).success).toBe(false);
    expect(outboxEventSchema.safeParse({ ...base, payload: [] as unknown as Record<string, unknown> }).success).toBe(false);

    // worker level: valid v1 event with object payload is processed and acked
    const aggId = randomUUID();
    const id = await enqueueFixture({ eventType: 'campus.created', aggregateType: 'campus', aggregateId: aggId });
    const row = await getRow(id);
    const event = serializeEvent(row);
    let reached = false;
    const registry: Record<string, OutboxHandler> = {
      'campus.created': async () => {
        reached = true;
      },
    };
    await processEvent(db, makeJob(event, 0, id), registry);
    const after = await getRow(id);
    expect(reached).toBe(true);
    expect(after.processedAt).not.toBeNull();
    expect(after.lastError).toBeNull();
    await withSystem(db, async (tx) => tx.delete(outboxEvents).where(eq(outboxEvents.id, id)).execute());
  });

  it('19. an unsupported future envelope version is rejected by the worker and NEVER silently processed', async () => {
    const aggId = randomUUID();
    const id = await enqueueFixture({ eventType: 'campus.created', aggregateType: 'campus', aggregateId: aggId });
    const row = await getRow(id);
    const event = serializeEvent(row);
    const bad = { ...event, version: 999 };
    let calls = 0;
    const registry: Record<string, OutboxHandler> = {
      'campus.created': async () => {
        calls += 1;
      },
    };
    await expect(processEvent(db, makeJob(bad as unknown as OutboxEvent, 0, id), registry)).rejects.toThrow(
      /invalid outbox event envelope/,
    );
    const after = await getRow(id);
    expect(calls).toBe(0);
    expect(after.processedAt).toBeNull();
    expect(after.attempts).toBe(1);
    expect(after.lastError).toMatch(/invalid outbox event envelope/);
    await withSystem(db, async (tx) => tx.delete(outboxEvents).where(eq(outboxEvents.id, id)).execute());
  });

  // ── Phase 3.3: promotion.batch.execute executor ──────────────────────────
  interface PromotionFixture {
    yearFrom: string;
    yearTo: string;
    sActive: string;
    sApplicant: string;
    sAlready: string;
    batchId: string;
    itemActive: string;
    itemApplicant: string;
    itemAlready: string;
  }

  const tuitionFixtures = async (slugSuffix: string): Promise<PromotionFixture> => {
    const f: PromotionFixture = {
      yearFrom: randomUUID(),
      yearTo: randomUUID(),
      sActive: randomUUID(),
      sApplicant: randomUUID(),
      sAlready: randomUUID(),
      batchId: randomUUID(),
      itemActive: '',
      itemApplicant: '',
      itemAlready: '',
    };
    await withSystem(db, async (tx) => {
      await tx.execute(
        sql`insert into academic_years (id, tenant_id, code, name, starts_on, ends_on, status) values
             (${f.yearFrom}, ${tenantA}, ${`w-pf-${slugSuffix}`}, 'Worker From', '2026-01-01', '2026-12-31', 'active'),
             (${f.yearTo}, ${tenantA}, ${`w-pt-${slugSuffix}`}, 'Worker To', '2027-01-01', '2027-12-31', 'active')`,
      );
      await tx.execute(
        sql`insert into students (id, tenant_id, student_no, first_name, last_name, status) values
             (${f.sActive}, ${tenantA}, ${`w-sa-${slugSuffix}`}, 'Active', 'A', 'active'),
             (${f.sApplicant}, ${tenantA}, ${`w-sp-${slugSuffix}`}, 'Applicant', 'A', 'applicant'),
             (${f.sAlready}, ${tenantA}, ${`w-sx-${slugSuffix}`}, 'Already', 'A', 'active')`,
      );
      await tx.execute(
        sql`insert into promotion_batches (id, tenant_id, from_academic_year_id, to_academic_year_id, status) values
             (${f.batchId}, ${tenantA}, ${f.yearFrom}, ${f.yearTo}, 'in_progress')`,
      );
      const items = await tx.execute(
        sql`insert into promotion_items (tenant_id, batch_id, student_id, from_academic_year_id, to_academic_year_id, status) values
             (${tenantA}, ${f.batchId}, ${f.sActive}, ${f.yearFrom}, ${f.yearTo}, 'pending'),
             (${tenantA}, ${f.batchId}, ${f.sApplicant}, ${f.yearFrom}, ${f.yearTo}, 'pending'),
             (${tenantA}, ${f.batchId}, ${f.sAlready}, ${f.yearFrom}, ${f.yearTo}, 'pending')
           returning id`,
      );
      const itemRows = items.rows as unknown as Array<{ id: string }>;
      f.itemActive = String(itemRows[0]!.id);
      f.itemApplicant = String(itemRows[1]!.id);
      f.itemAlready = String(itemRows[2]!.id);
      // sAlready is already enrolled in the target year: the insert is a 23505
      // idempotent success for its item.
      await tx.execute(
        sql`insert into enrollments (id, tenant_id, student_id, academic_year_id, status)
             values (${randomUUID()}, ${tenantA}, ${f.sAlready}, ${f.yearTo}, 'active')`,
      );
    });
    return f;
  };

  const tearDownPromotion = async (f: PromotionFixture): Promise<void> => {
    await withSystem(db, async (tx) => {
      await tx.execute(sql`delete from enrollments where tenant_id = ${tenantA} and academic_year_id in (${f.yearFrom}, ${f.yearTo})`);
      await tx.execute(sql`delete from promotion_items where tenant_id = ${tenantA} and batch_id = ${f.batchId}`);
      await tx.execute(sql`delete from promotion_batches where tenant_id = ${tenantA} and id = ${f.batchId}`);
      await tx.execute(sql`delete from students where tenant_id = ${tenantA} and id in (${f.sActive}, ${f.sApplicant}, ${f.sAlready})`);
      await tx.execute(sql`delete from academic_years where tenant_id = ${tenantA} and id in (${f.yearFrom}, ${f.yearTo})`);
      await tx.execute(sql`delete from audit_logs where tenant_id = ${tenantA} and action = 'promotion.batch.executed'`);
      await tx.execute(
        sql`delete from outbox_events where tenant_id = ${tenantA} and
            (event_type = 'promotion.batch.execute' or event_type = 'student.enrolled')`,
      );
    });
  };

  it('20. promotion.batch.execute creates target-year enrollments, completes the batch, audits, enqueues student.enrolled', async () => {
    const f = await tuitionFixtures('e2e');
    const id = await enqueueFixture({
      eventType: 'promotion.batch.execute',
      aggregateType: 'promotion_batch',
      aggregateId: f.batchId,
      payload: { tenantId: tenantA, batchId: f.batchId },
    });
    const row = await getRow(id);
    const event = serializeEvent(row);
    await processEvent(db, makeJob(event, 0, id), buildHandlers(silentLog));

    try {
      const batch = await withSystem(db, async (tx) =>
      tx
        .select({ status: promotionBatches.status, completedAt: promotionBatches.completedAt })
        .from(promotionBatches)
        .where(eq(promotionBatches.id, f.batchId))
        .limit(1)
        .execute(),
    );
    expect(batch[0]!.status).toBe('completed');
    expect(batch[0]!.completedAt).not.toBeNull();

    const enr = await withSystem(db, async (tx) =>
      tx
        .select({ studentId: enrollments.studentId })
        .from(enrollments)
        .where(
          and(
            eq(enrollments.tenantId, tenantA),
            eq(enrollments.academicYearId, f.yearTo),
            eq(enrollments.status, 'active'),
          ),
        )
        .execute(),
    );
    expect(enr.map((e) => e.studentId).sort()).toEqual([f.sActive, f.sAlready].sort());

    const items = await withSystem(db, async (tx) =>
      tx.select().from(promotionItems).where(eq(promotionItems.batchId, f.batchId)).execute(),
    );
    expect(items.find((i) => i.id === f.itemActive)!.status).toBe('promoted');
    expect(items.find((i) => i.id === f.itemApplicant)!.status).toBe('failed');
    expect(items.find((i) => i.id === f.itemApplicant)!.error).toBe('student is not active');
    expect(items.find((i) => i.id === f.itemAlready)!.status).toBe('promoted');

    const audits = await withSystem(db, async (tx) =>
      tx
        .select()
        .from(auditLogs)
        .where(and(eq(auditLogs.tenantId, tenantA), eq(auditLogs.action, 'promotion.batch.executed'), eq(auditLogs.resourceId, f.batchId)))
        .execute(),
    );
    expect(audits.length).toBe(1);
    expect(audits[0]!.actorType).toBe('job');
    expect((audits[0]!.newValue as { itemCount: number; promoted: number; failed: number })).toEqual({
      batchId: f.batchId,
      itemCount: 3,
      promoted: 2,
      failed: 1,
    });

    const enrollmentEvents = await withSystem(db, async (tx) =>
      tx
        .select({ causationId: outboxEvents.causationId })
        .from(outboxEvents)
        .where(and(eq(outboxEvents.tenantId, tenantA), eq(outboxEvents.eventType, 'student.enrolled'), eq(outboxEvents.causationId, event.id)))
        .execute(),
    );
    expect(enrollmentEvents.length).toBe(1);

    const processed = await getRow(id);
    expect(processed.processedAt).not.toBeNull();
    expect(processed.lastError).toBeNull();
    } finally {
      await tearDownPromotion(f);
    }
  });

  it('21. redriving the same event after completion is a no-op ack: no duplicate enrollments or enrollment events', async () => {
    const f = await tuitionFixtures('idem');
    const id = await enqueueFixture({
      eventType: 'promotion.batch.execute',
      aggregateType: 'promotion_batch',
      aggregateId: f.batchId,
      payload: { tenantId: tenantA, batchId: f.batchId },
    });
    const row = await getRow(id);
    const event = serializeEvent(row);
    const registry = buildHandlers(silentLog);
    await processEvent(db, makeJob(event, 0, id), registry);
    await processEvent(db, makeJob(event, 0, id), registry);
    try {
      const enr = await withSystem(db, async (tx) =>
      tx
        .select({ studentId: enrollments.studentId })
        .from(enrollments)
        .where(and(eq(enrollments.tenantId, tenantA), eq(enrollments.academicYearId, f.yearTo)))
        .execute(),
    );
    expect(enr.map((e) => e.studentId).sort()).toEqual([f.sActive, f.sAlready].sort());

    const batch = await withSystem(db, async (tx) =>
      tx
        .select({ status: promotionBatches.status })
        .from(promotionBatches)
        .where(eq(promotionBatches.id, f.batchId))
        .limit(1)
        .execute(),
    );
    expect(batch[0]!.status).toBe('completed');

    const events = await withSystem(db, async (tx) =>
      tx
        .select()
        .from(outboxEvents)
        .where(and(eq(outboxEvents.tenantId, tenantA), eq(outboxEvents.eventType, 'student.enrolled'), eq(outboxEvents.causationId, event.id)))
        .execute(),
    );
    expect(events.length).toBe(1);

    // A batch that does not exist at all is also an idempotent no-op ack.
    const ghost = randomUUID();
    const ghostId = await enqueueFixture({
      eventType: 'promotion.batch.execute',
      aggregateType: 'promotion_batch',
      aggregateId: ghost,
      payload: { tenantId: tenantA, batchId: ghost },
    });
    const ghostRow = await getRow(ghostId);
    await processEvent(db, makeJob(serializeEvent(ghostRow), 0, ghostId), registry);
    const ghostAfter = await getRow(ghostId);
    expect(ghostAfter.processedAt).not.toBeNull();
    expect(ghostAfter.lastError).toBeNull();
    } finally {
      await tearDownPromotion(f);
    }
  }, 30_000);

  it('22. dispatcher + real BullMQ worker promote a batch end-to-end', async () => {
    const f = await tuitionFixtures('live');
    const id = await enqueueFixture({
      eventType: 'promotion.batch.execute',
      aggregateType: 'promotion_batch',
      aggregateId: f.batchId,
      payload: { tenantId: tenantA, batchId: f.batchId },
    });
    const queueName = `it-pprom-${slug}`;
    const conn = new Redis(getEnv().REDIS_URL, { maxRetriesPerRequest: null, enableOfflineQueue: false, lazyConnect: true });
    await conn.connect();
    const queue = new Queue(queueName, { connection: conn as never });
    const runtime = startOutboxWorker({ db, redis: conn, log: silentLog, queueName });
    try {
      const { dispatched } = await dispatchPendingEvents(db, queue, 100);
      expect(dispatched).toBe(1);
      await poll(async () => {
        const b = await withSystem(db, async (tx) =>
          tx
            .select({ status: promotionBatches.status })
            .from(promotionBatches)
            .where(eq(promotionBatches.id, f.batchId))
            .limit(1)
            .execute(),
        );
        return b[0]?.status === 'completed';
      }, 15_000);
      const enr = await withSystem(db, async (tx) =>
        tx
          .select({ studentId: enrollments.studentId })
          .from(enrollments)
          .where(and(eq(enrollments.tenantId, tenantA), eq(enrollments.academicYearId, f.yearTo)))
          .execute(),
      );
      expect(enr.map((e) => e.studentId).sort()).toEqual([f.sActive, f.sAlready].sort());
      const after = await getRow(id);
      expect(after.processedAt).not.toBeNull();
      expect(after.lastError).toBeNull();
    } finally {
      await runtime.close();
      await queue.close();
      await conn.quit();
      await tearDownPromotion(f);
    }
  }, 30_000);

  it('23. concurrent execute events on one batch stay idempotent: single enrollment per student, batch completes once', async () => {
    const f = await tuitionFixtures('conc');
    try {
      const ids: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      const eid = await enqueueFixture({
        eventType: 'promotion.batch.execute',
        aggregateType: 'promotion_batch',
        aggregateId: f.batchId,
        payload: { tenantId: tenantA, batchId: f.batchId },
      });
      ids.push(eid);
    }
    const registry = buildHandlers(silentLog);
    const jobs = await Promise.all(ids.map(async (eid) => serializeEvent(await getRow(eid))));
    await Promise.all(jobs.map((event) => processEvent(db, makeJob(event, 0, event.id), registry)));

    const enr = await withSystem(db, async (tx) =>
      tx
        .select({ studentId: enrollments.studentId })
        .from(enrollments)
        .where(and(eq(enrollments.tenantId, tenantA), eq(enrollments.academicYearId, f.yearTo)))
        .execute(),
    );
    // Exactly one 'active' row per student even under two racing executions.
    expect(enr.map((e) => e.studentId).sort()).toEqual([f.sActive, f.sAlready].sort());

    const batch = await withSystem(db, async (tx) =>
      tx
        .select({ status: promotionBatches.status })
        .from(promotionBatches)
        .where(eq(promotionBatches.id, f.batchId))
        .limit(1)
        .execute(),
    );
    expect(batch[0]!.status).toBe('completed');

    for (const eid of ids) {
        const r = await getRow(eid);
        expect(r.processedAt).not.toBeNull();
      }
    } finally {
      await tearDownPromotion(f);
    }
  }, 30_000);
});