import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import {
  JOB_NAME_TO_QUEUE,
  JOB_QUEUE_NAMES,
  jobNameSchema,
  type JobName,
  type JobPayload,
} from '@sms/contracts';
import { JobRoutingError, resolveQueueForJob, type QueueDelegates } from '@sms/jobs';
import { enqueueDeferred } from './worker.js';

/**
 * D1 queue-routing remediation — the fail-closed routing contract.
 *
 * WHY THIS SUITE EXISTS
 * Routing used to be a binary ternary in `apps/worker/src/worker.ts`:
 *
 *     job.queue === 'mail' ? queues.mail : queues.events
 *
 * plus a `queueForJob()` helper whose final statement was `return 'events'`.
 * Together they meant any queue category that was neither `mail` nor explicitly
 * recognised collapsed onto `events`. That is exactly what happened to `reports`:
 * `exams.ts` deferred `{ name: 'report.studentReportCard', queue: 'reports' }`,
 * the job landed on the events queue, `processEvent` tried to parse a report-card
 * payload as an outbox envelope, `failEvent` looked up a BullMQ job id that was
 * not a UUID, and `report.studentReportCard` never executed anywhere.
 *
 * The contract proven here:
 *   - every `JobName` has an explicit, table-derived queue;
 *   - `reports` reaches the `reports` queue and `events` reaches the `events` queue;
 *   - unknown job name              -> rejected (no default queue);
 *   - declared queue ≠ mapped queue  -> rejected (no override);
 *   - malformed payload              -> rejected (no half-routed job);
 *   - a rejected job never touches any queue.
 *
 * The first two describes are pure: no database, no Redis, no BullMQ connection,
 * and they run in the default suite. The last describe is opt-in
 * (`RUN_RUNTIME_SECURITY_TESTS=1`) because it needs a live Redis, and it proves
 * real BullMQ delivery — see its own comment for why the queue names are private.
 */

const silentLog = (): void => {};

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';

/** Minimal payloads that satisfy each job's registered schema. */
const validData: Record<JobName, unknown> = {
  'event.process': {
    event: {
      version: 1,
      id: UUID_A,
      tenantId: UUID_A,
      eventType: 'campus.created',
      aggregateType: 'campuses',
      aggregateId: UUID_A,
      payload: {},
      correlationId: null,
      causationId: null,
      createdAt: new Date().toISOString(),
    },
  },
  'event.process.single': {
    event: {
      version: 1,
      id: UUID_A,
      tenantId: UUID_A,
      eventType: 'campus.created',
      aggregateType: 'campuses',
      aggregateId: UUID_A,
      payload: {},
      correlationId: null,
      causationId: null,
      createdAt: new Date().toISOString(),
    },
  },
  'mail.stub.send': {
    to: 'guardian@example.com',
    template: 'attendance.late',
    data: { studentId: UUID_A },
    tenantId: UUID_A,
    correlationId: null,
  },
  'report.studentReportCard': {
    reportCardId: UUID_B,
    tenantId: UUID_A,
    idempotencyKey: 'evt-idempotency-key',
    correlationId: null,
  },
};

const payloadFor = (name: JobName): JobPayload => ({
  name,
  queue: JOB_NAME_TO_QUEUE[name],
  data: validData[name],
});

/** A QueueDelegates stand-in that records every `add` without touching Redis. */
function spyQueues(): QueueDelegates & { calls: Array<{ queue: string; name: string; data: unknown }> } {
  const calls: Array<{ queue: string; name: string; data: unknown }> = [];
  const mk = (queue: string) =>
    ({ add: vi.fn(async (name: string, data: unknown) => { calls.push({ queue, name, data }); }) }) as never;
  return { events: mk('events'), mail: mk('mail'), reports: mk('reports'), calls };
}

describe('D1: queue routing is table-driven and fail-closed', () => {
  it('the catalog itself is complete: every JobName maps to a known queue', () => {
    const names = jobNameSchema.options;
    expect([...names].sort()).toEqual([...(Object.keys(JOB_NAME_TO_QUEUE) as JobName[])].sort());
    for (const n of names) {
      expect(JOB_QUEUE_NAMES, `${n} maps outside the closed queue set`).toContain(JOB_NAME_TO_QUEUE[n]);
    }
    expect(new Set(Object.values(JOB_NAME_TO_QUEUE)).size).toBe(3);
  });

  it.each([
    ['event.process', 'events'],
    ['event.process.single', 'events'],
    ['mail.stub.send', 'mail'],
    ['report.studentReportCard', 'reports'],
  ] as const)('%s -> %s queue', (name, queue) => {
    expect(resolveQueueForJob(payloadFor(name))).toBe(queue);
  });

  it('REGRESSION: report.studentReportCard reaches the reports queue, not events', () => {
    // The exact payload `exams.ts:makeReportCardGeneratedHandler` defers.
    const job: JobPayload = {
      name: 'report.studentReportCard',
      queue: 'reports',
      data: validData['report.studentReportCard'],
    };
    expect(resolveQueueForJob(job)).toBe('reports');
    expect(resolveQueueForJob(job)).not.toBe('events');
  });

  it('REGRESSION: the ternary that caused D1 is gone — routing is derived from the table', () => {
    // A payload whose only truth is its declared queue must still be resolved
    // from JOB_NAME_TO_QUEUE. Under the old ternary `queue: 'reports'` fell to
    // `events`, so this is the assertion that the bug cannot recur.
    const declaredOnly = { name: 'report.studentReportCard', queue: 'reports', data: validData['report.studentReportCard'] };
    expect(resolveQueueForJob(declaredOnly as JobPayload)).toBe(JOB_NAME_TO_QUEUE['report.studentReportCard']);
  });
});

describe('D1: unknown / inconsistent / malformed jobs fail closed', () => {
  it('rejects an unknown job name (no implicit default queue)', () => {
    for (const bogus of ['report.studentReportCard2', 'mail.send', '', 'PUSH.NOTIFICATION', 42, undefined]) {
      const job = { name: bogus, queue: 'events', data: {} } as unknown as JobPayload;
      expect(() => resolveQueueForJob(job), `${String(bogus)} should not be routable`).toThrow(JobRoutingError);
    }
  });

  it('rejects a declared queue that contradicts the authoritative mapping', () => {
    for (const [name, wrong] of [
      ['report.studentReportCard', 'events'],
      ['mail.stub.send', 'events'],
      ['event.process', 'mail'],
      ['event.process.single', 'reports'],
    ] as const) {
      const job = { name, queue: wrong, data: validData[name] } as unknown as JobPayload;
      expect(() => resolveQueueForJob(job), `${name} on '${wrong}' must not be routable`).toThrow(
        /declared queue/,
      );
    }
  });

  it('rejects a queue outside the closed set', () => {
    const job = { name: 'mail.stub.send', queue: 'sms', data: validData['mail.stub.send'] } as unknown as JobPayload;
    expect(() => resolveQueueForJob(job)).toThrow(JobRoutingError);
  });

  it.each([
    ['report.studentReportCard', { reportCardId: 'not-a-uuid', tenantId: UUID_A, idempotencyKey: 'k' }],
    ['report.studentReportCard', { tenantId: UUID_A, idempotencyKey: 'k' }],
    ['mail.stub.send', { to: 'not-an-email', template: 't', data: {}, tenantId: null, correlationId: null }],
    ['mail.stub.send', { to: 'a@example.com', template: 't', tenantId: null, correlationId: null }],
    ['event.process', {}],
  ] as const)('rejects a malformed %s payload', (name, data) => {
    const job = { name, queue: JOB_NAME_TO_QUEUE[name], data } as unknown as JobPayload;
    expect(() => resolveQueueForJob(job), `${name} payload must be validated before routing`).toThrow(
      /malformed payload/,
    );
  });

  it('rejects a payload that is not an object at all', () => {
    for (const data of [null, undefined, 'string', 7]) {
      const job = { name: 'mail.stub.send', queue: 'mail', data } as unknown as JobPayload;
      expect(() => resolveQueueForJob(job)).toThrow(JobRoutingError);
    }
  });
});

describe('D1: enqueueDeferred delivers to the mapped queue only', () => {
  it('sends a reports job to queues.reports and never to queues.events', async () => {
    const q = spyQueues();
    const job = payloadFor('report.studentReportCard');
    await enqueueDeferred(q, job, silentLog);
    expect(q.reports.add).toHaveBeenCalledTimes(1);
    expect(q.events.add).not.toHaveBeenCalled();
    expect(q.mail.add).not.toHaveBeenCalled();
    expect(q.calls).toEqual([
      { queue: 'reports', name: 'report.studentReportCard', data: validData['report.studentReportCard'] },
    ]);
  });

  it('sends a mail job to queues.mail', async () => {
    const q = spyQueues();
    await enqueueDeferred(q, payloadFor('mail.stub.send'), silentLog);
    expect(q.mail.add).toHaveBeenCalledTimes(1);
    expect(q.events.add).not.toHaveBeenCalled();
    expect(q.reports.add).not.toHaveBeenCalled();
  });

  it('sends an events job to queues.events', async () => {
    const q = spyQueues();
    await enqueueDeferred(q, payloadFor('event.process'), silentLog);
    expect(q.events.add).toHaveBeenCalledTimes(1);
    expect(q.mail.add).not.toHaveBeenCalled();
    expect(q.reports.add).not.toHaveBeenCalled();
  });

  it('an unroutable job touches NO queue at all', async () => {
    const q = spyQueues();
    const bad = { name: 'report.studentReportCard', queue: 'events', data: validData['report.studentReportCard'] } as unknown as JobPayload;
    await expect(enqueueDeferred(q, bad, silentLog)).rejects.toThrow(JobRoutingError);
    expect(q.calls, 'a rejected job must not be delivered anywhere').toHaveLength(0);
    expect(q.events.add).not.toHaveBeenCalled();
    expect(q.mail.add).not.toHaveBeenCalled();
    expect(q.reports.add).not.toHaveBeenCalled();
  });

  it('routing is resolved even when no queues are wired (still fail-closed)', async () => {
    const lines: unknown[] = [];
    const log = (_l: string, _m: string, d?: unknown) => lines.push(d);
    const bad = { name: 'mystery.job', queue: 'events', data: {} } as unknown as JobPayload;
    await expect(enqueueDeferred(undefined, bad, log as never)).rejects.toThrow(JobRoutingError);
    expect(lines, 'an unroutable job must throw before any drop is logged').toHaveLength(0);

    // A routable job with no consumer is still dropped with a warning, not rerouted.
    await enqueueDeferred(undefined, payloadFor('mail.stub.send'), log as never);
    expect(lines).toHaveLength(1);
    expect(lines[0], 'the drop must name the resolved queue, not a fallback').toMatchObject({ queue: 'mail' });
  });
});

/**
 * OPT-IN (RUN_RUNTIME_SECURITY_TESTS=1): real BullMQ delivery proof.
 *
 * `startOutboxWorker` takes private queue names precisely so a suite can run
 * alongside a dev worker without it stealing jobs (see the same escape hatch used
 * by outbox-integration.test.ts test 16). All three queues here are private for
 * that reason — the object KEYS are still `events`/`mail`/`reports`, which is
 * what `enqueueDeferred` routes on, so the routing contract under test is the
 * production one while the BullMQ queue NAMES are ours alone.
 *
 * The discriminator is the consumer's own error message:
 *   - routed to `events`  -> `invalid outbox event envelope ...`
 *   - routed to `reports` -> `report.studentReportCard requires a storage provider`
 * so the assertion proves which CONSUMER executed, not merely which queue object
 * was touched.
 */
const runtimeEnabled = process.env.RUN_RUNTIME_SECURITY_TESTS === '1';
const describeLive = runtimeEnabled ? describe : describe.skip;

describeLive('D1 LIVE: report.studentReportCard is delivered to the reports consumer', () => {
  const slug = 'd1rt' + randomUUID().slice(0, 8);
  const reportsQueueName = `d1-reports-${slug}`;
  let conn: Redis;
  let queues: QueueDelegates;
  let runtime: { close(): Promise<void> } | undefined;

  beforeAll(async () => {
    const { getEnv } = await import('@sms/config');
    const { startOutboxWorker } = await import('./worker.js');
    conn = new Redis(getEnv().REDIS_URL, {
      maxRetriesPerRequest: null,
      enableOfflineQueue: false,
      lazyConnect: true,
    });
    await conn.connect();
    const mkOpts = { attempts: 1, removeOnComplete: false, removeOnFail: false };
    queues = {
      events: new Queue(`d1-events-${slug}`, { connection: conn as never, defaultJobOptions: mkOpts }),
      mail: new Queue(`d1-mail-${slug}`, { connection: conn as never, defaultJobOptions: mkOpts }),
      reports: new Queue(reportsQueueName, { connection: conn as never, defaultJobOptions: mkOpts }),
    };
    runtime = startOutboxWorker({
      // No events job is enqueued in this test, so the events consumer never runs
      // and `db` is never dereferenced.
      db: {} as never,
      redis: conn,
      log: silentLog,
      queueName: `d1-events-${slug}`,
      mailQueueName: `d1-mail-${slug}`,
      reportsQueueName,
      queues,
    });
  });

  afterAll(async () => {
    await runtime?.close();
    await Promise.all([queues.events.close(), queues.mail.close(), queues.reports.close()]);
    await conn.quit();
  });

  const poll = async (fn: () => Promise<boolean>, ms: number): Promise<void> => {
    const deadline = Date.now() + ms;
    for (;;) {
      if (await fn()) return;
      if (Date.now() > deadline) throw new Error('timed out waiting for the reports consumer');
      await new Promise((r) => setTimeout(r, 100));
    }
  };

  it('a deferred report.studentReportCard job is consumed by the REPORTS worker', async () => {
    await enqueueDeferred(queues, payloadFor('report.studentReportCard'), silentLog);

    const settled = async (): Promise<boolean> => {
      const jobs = await queues.reports.getJobs(['completed', 'failed']);
      return jobs.length > 0;
    };
    await poll(settled, 15_000);

    const jobs = await queues.reports.getJobs(['completed', 'failed']);
    expect(jobs.length, 'the reports queue received no job at all').toBeGreaterThan(0);
    const job = jobs[0]!;
    expect(job.name).toBe('report.studentReportCard');

    // Which consumer ran? The failure message is specific to the reports worker.
    const reason = String(job.failedReason ?? '');
    expect(reason, `the events consumer processed this job: ${reason}`).not.toContain(
      'invalid outbox event envelope',
    );
    expect(reason, `expected the reports consumer's own guard, got: ${reason}`).toContain(
      'requires a storage provider',
    );

    // And the events queue must have stayed empty — the D1 mis-route would have
    // put this job there.
    const eventsJobs = await queues.events.getJobs(['waiting', 'active', 'completed', 'failed']);
    expect(eventsJobs, 'the reports job leaked onto the events queue').toHaveLength(0);
  }, 30_000);
});
