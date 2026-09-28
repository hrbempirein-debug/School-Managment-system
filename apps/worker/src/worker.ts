import { fileURLToPath } from 'node:url';
import { Worker, Job, Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { getEnv } from '@sms/config';
import type { JobPayload, MailStubSendJob, OutboxEvent, OutboxEventType } from '@sms/contracts';
import { outboxEventSchema, outboxEventTypeSchema } from '@sms/contracts';
import { createDb, type Db, type Tx, withGuc } from '@sms/db';
import { failEvent, dispatchPendingEvents, markProcessed, OUTBOX_JOB } from '@sms/events';
import { createRedis } from '@sms/redis';
import { createQueues, type QueueDelegates } from '@sms/jobs';
import { createStorageProvider, type StorageProvider } from '@sms/storage';
import { makePromotionHandler } from './promotion.js';
import { makeScanHandler } from './documents.js';
import { makeStudentImportHandler } from './student-import.js';
import {
  makeLateNotificationHandler,
  makeLeaveDecisionHandler,
  runDailyAttendanceSummaries,
} from './attendance.js';
import {
  makePublishNotificationHandler,
  makeReportCardGeneratedHandler,
  makeResultComputeHandler,
  processReportCardJob,
} from './exams.js';

type Logger = (level: 'info' | 'warn' | 'error', msg: string, data?: unknown) => void;

export interface EventHandlerDeps {
  tx: Tx;
  event: OutboxEvent;
  /**
   * Queues an external job to run AFTER this handler's transaction COMMITS.
   * Handlers must never enqueue directly: a throw rolls the transaction back and
   * an already-queued job would be a side effect of work that never happened.
   */
  defer: (job: JobPayload) => void;
}

export type OutboxHandler = (deps: EventHandlerDeps) => Promise<void>;

/**
 * Invoke a handler inside a transaction. The session is the trusted executor
 * (school_migrator), so `app_privileged()` is true and app.rls is cleared via
 * `set_config('app.rls', '', true)` — no raw per-tenant GUC is set and no role
 * escalation occurs. Tenant scoping for handlers is therefore DATA-based: a handler must
 * select the intended tenant's rows by `event.tenant_id`, never rely on context.
 * On handler failure the row keeps processed_at NULL so BullMQ retries converge.
 * Unknown event types are rejected (no silent ack): they throw so the row is
 * recorded as failed and re-driven rather than quietly consumed.
 *
 * Returns the jobs the handler deferred; they are handed to the caller only once
 * the transaction has committed.
 */
export async function runEventHandler(
  db: Db,
  event: OutboxEvent,
  handlers: Record<string, OutboxHandler>,
): Promise<JobPayload[]> {
  const actor =
    (typeof event.payload['actorUserId'] === 'string' && event.payload['actorUserId']) ||
    (typeof event.payload['userId'] === 'string' ? event.payload['userId'] : undefined);

  const deferred: JobPayload[] = [];
  await withGuc(
    db,
    { tenantId: event.tenantId, userId: actor, system: true },
    async (tx) => {
      const handler = handlers[event.eventType];
      if (!handler) throw new Error(`no handler registered for event type '${event.eventType}'`);
      await handler({ tx, event, defer: (job) => deferred.push(job) });
      await markProcessed(tx, event.id);
    },
  );
  return deferred;
}

/** Enqueue a deferred job on its queue. Failures propagate so BullMQ redrives. */
async function enqueueDeferred(
  queues: QueueDelegates | undefined,
  job: JobPayload,
  log: Logger,
): Promise<void> {
  if (!queues) {
    log('warn', 'deferred job dropped: no queues wired into the worker', job);
    return;
  }
  const target: Queue | undefined =
    job.queue === 'mail' ? (queues.mail as Queue) : (queues.events as Queue);
  await target.add(job.name, job.data);
}

export async function processEvent(
  db: Db,
  job: Job<{ event: OutboxEvent }>,
  handlers: Record<string, OutboxHandler>,
  queues?: QueueDelegates,
  log?: Logger,
): Promise<void> {
  const raw = job.data.event as unknown;
  const rawevent = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const id = typeof rawevent['id'] === 'string' ? rawevent['id'] : (job.id ?? '');
  const parsed = outboxEventSchema.safeParse(raw);
  if (!parsed.success) {
    // Malformed payloads fail validation: recorded on the outbox row and rethrown
    // so BullMQ retries (and the redriven dispatcher) converge on the failure.
    const msg = `invalid outbox event envelope (${parsed.error.issues.length} issue(s)): ${parsed.error.message}`;
    await failEvent(db, id, msg, job.attemptsMade + 1);
    throw new Error(msg);
  }
  const event = parsed.data;
  try {
    const deferred = await runEventHandler(db, event, handlers);
    // Post-commit: the business change is durable, so the notification stubs are
    // safe to publish.
    const noop: Logger = log ?? (() => {});
    for (const deferredJob of deferred) {
      await enqueueDeferred(queues, deferredJob, noop);
    }
  } catch (err) {
    await failEvent(db, event.id, err instanceof Error ? err.message : String(err), job.attemptsMade + 1);
    throw err;
  }
}

export function buildHandlers(log: Logger, deps?: { storage?: StorageProvider }): Record<string, OutboxHandler> {
  const registry: Record<string, OutboxHandler> = {};
  const logEvent =
    (eventType: OutboxEventType): OutboxHandler =>
    async ({ event }) => {
      log('info', `outbox: ${eventType}`, {
        eventId: event.id,
        tenantId: event.tenantId,
        aggregateId: event.aggregateId,
      });
    };
  // Every declared event type has a known disposition. Phase 2B handlers have no
  // external side effects; the disposition is "log-only ack", which is what the
  // delivery proof below exercises. Types NOT in the schema fail validation.
  // Real side-effecting handlers (Phase 3.3+): promotion.batch.execute,
  // student.document.uploaded (scan hook), student.import.submitted (Phase 3.5),
  // the Phase 5 attendance/leave notification stubs, and Phase 6's result
  // computation, report-card artifact hand-off and publication notifications.
  const promotionHandler = makePromotionHandler(log);
  const scanHandler = makeScanHandler(log, deps?.storage);
  const importHandler = makeStudentImportHandler(log, deps?.storage);
  const lateHandler = makeLateNotificationHandler(log);
  const leaveDecisionHandler = makeLeaveDecisionHandler(log);
  const resultComputeHandler = makeResultComputeHandler(log);
  const reportCardGeneratedHandler = makeReportCardGeneratedHandler(log);
  const publishNotificationHandler = makePublishNotificationHandler(log);
  for (const type of outboxEventTypeSchema.options as readonly OutboxEventType[]) {
    registry[type] =
      type === 'promotion.batch.execute'
        ? promotionHandler
        : type === 'student.document.uploaded'
          ? scanHandler
          : type === 'student.import.submitted'
            ? importHandler
            : type === 'attendance.marked'
              ? lateHandler
              : type === 'leave.approved' || type === 'leave.rejected'
                ? leaveDecisionHandler
                : type === 'exam.result.compute'
                  ? resultComputeHandler
                  : type === 'report_card.generated'
                    ? reportCardGeneratedHandler
                    : type === 'exam.published'
                      ? publishNotificationHandler
                      : logEvent(type);
  }
  return registry;
}

export interface WorkerRuntime {
  close(): Promise<void>;
}

export function startOutboxWorker(opts: {
  db: Db;
  redis: Redis;
  log: Logger;
  queueName?: string;
  /**
   * Mail queue name. Defaults to the shared 'mail' queue; a test (or a second
   * deployment that must not steal each other's stub jobs) can point its worker
   * at a private queue so an already-running dev worker cannot consume its jobs.
   */
  mailQueueName?: string;
  /** Phase 6 report-artifact queue; same private-queue escape hatch as mail. */
  reportsQueueName?: string;
  storage?: StorageProvider;
  queues?: QueueDelegates;
}): WorkerRuntime {
  const {
    db,
    redis,
    log,
    queueName = 'events',
    mailQueueName = 'mail',
    reportsQueueName = 'reports',
    storage,
    queues,
  } = opts;
  const handlers = buildHandlers(log, { storage });

  const eventsWorker = new Worker(
    queueName,
    (job) => processEvent(db, job as Job<{ event: OutboxEvent }>, handlers, queues, log),
    { connection: redis as never, concurrency: 5 },
  );
  const mailWorker = new Worker(
    mailQueueName,
    async (job: Job<{ data: MailStubSendJob }>) => {
      const payload = job.data.data as unknown as MailStubSendJob;
      log('info', 'mail.stub.send', {
        to: payload.to,
        template: payload.template,
        tenantId: payload.tenantId,
        correlationId: payload.correlationId,
      });
    },
    { connection: redis as never, concurrency: 2 },
  );
  // The reports queue consumes the Phase 6 artifact job. A report card is
  // rendered inside a tenant-scoped system transaction, so the PDF, its `files`
  // row and the `file_id` stamp either all land or none do.
  const reportsWorker = new Worker(
    reportsQueueName,
    async (job: Job<{ data: unknown }>) => {
      const raw = (job.data as { data?: unknown } | undefined)?.data ?? job.data;
      const payload = raw as { tenantId?: string } | undefined;
      const tenantId = typeof payload?.tenantId === 'string' ? payload.tenantId : null;
      if (!storage) {
        throw new Error('report.studentReportCard requires a storage provider');
      }
      if (!tenantId) {
        throw new Error('report.studentReportCard requires a tenantId');
      }
      await withGuc(db, { tenantId, system: true }, (tx) => processReportCardJob(tx, storage, log, raw));
    },
    { connection: redis as never, concurrency: 3 },
  );

  eventsWorker.on('failed', (job, err) => {
    log('error', 'event job failed', { eventId: job?.data?.event?.id, error: err.message });
  });
  mailWorker.on('failed', (job, err) => {
    log('error', 'mail job failed', { jobId: job?.id, error: err.message });
  });
  reportsWorker.on('failed', (job, err) => {
    log('error', 'report job failed', { jobId: job?.id, error: err.message });
  });

  return {
    async close() {
      await Promise.all([eventsWorker.close(), mailWorker.close(), reportsWorker.close()]);
    },
  };
}

export function startDispatcher(opts: {
  db: Db;
  eventsQueue: Queue;
  intervalMs?: number;
  log: Logger;
}): () => Promise<void> {
  const { db, eventsQueue, intervalMs = 1500, log } = opts;
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    try {
      const { dispatched } = await dispatchPendingEvents(db, eventsQueue as never);
      if (dispatched > 0) log('info', 'dispatched outbox events', { dispatched });
    } catch (err) {
      log('error', 'outbox dispatch failed', { error: err instanceof Error ? err.message : String(err) });
    }
  };

  void tick();
  const timer = setInterval(tick, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();

  return async () => {
    stopped = true;
    clearInterval(timer);
  };
}

/**
 * Daily attendance summary. Re-runs are safe: `runDailyAttendanceSummaries`
 * writes at most one `attendance.daily_summary` audit row per (tenant, date), so
 * a repeating interval — or a restart that replays a tick — converges instead of
 * duplicating the artifact.
 */
export function startAttendanceSummaryScheduler(opts: {
  db: Db;
  log: Logger;
  intervalMs?: number;
  runImmediately?: boolean;
}): () => Promise<void> {
  const { db, log, intervalMs = 3_600_000, runImmediately = true } = opts;
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    try {
      const written = await runDailyAttendanceSummaries(db, log);
      if (written.length) log('info', 'attendance daily summary complete', { tenants: written.length });
    } catch (err) {
      log('error', 'attendance daily summary failed', { error: err instanceof Error ? err.message : String(err) });
    }
  };

  if (runImmediately) void tick();
  const timer = setInterval(tick, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();

  return async () => {
    stopped = true;
    clearInterval(timer);
  };
}

async function main(): Promise<void> {
  const env = getEnv();
  const { db } = createDb({ url: env.DATABASE_URL_MIGRATOR, max: env.DB_POOL_MAX });
  const redis = createRedis(env.REDIS_URL);
  const queues = createQueues(redis);

  const log: Logger = (level, msg, data) => {
    const target = level === 'info' ? console.info : level === 'warn' ? console.warn : console.error;
    target(msg, data ?? '');
  };

  const storage = createStorageProvider();

  const runtime = startOutboxWorker({ db, redis, log, storage, queues });
  const stopDispatcher = startDispatcher({ db, eventsQueue: queues.events, log });
  const stopSummary = startAttendanceSummaryScheduler({ db, log });

  console.log('[worker] outbox worker + reports queue + dispatcher + attendance summary started');

  const shutdown = async () => {
    console.log('[worker] shutting down...');
    await stopDispatcher();
    await stopSummary();
    await runtime.close();
    await Promise.all([queues.events.close(), queues.mail.close(), queues.reports.close()]);
    await redis.quit();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void main();
}