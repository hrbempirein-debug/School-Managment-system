import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { Worker, Job, Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { getEnv } from '@sms/config';
import type { MailStubSendJob, OutboxEvent, OutboxEventType } from '@sms/contracts';
import { createDb, type Db, type Tx, withGuc, outboxEvents } from '@sms/db';
import { failEvent, dispatchPendingEvents, OUTBOX_JOB } from '@sms/events';
import { createRedis } from '@sms/redis';
import { createQueues } from '@sms/jobs';

type Logger = (level: 'info' | 'warn' | 'error', msg: string, data?: unknown) => void;

export interface EventHandlerDeps {
  tx: Tx;
  event: OutboxEvent;
}

export type OutboxHandler = (deps: EventHandlerDeps) => Promise<void>;

/**
 * Invoke a handler inside a tenant-scoped transaction. The system GUC stays on so
 * the transaction may update the outbox row; business tables remain tenant-walled.
 * On handler failure the row keeps processed_at NULL so BullMQ retries converge.
 */
export async function runEventHandler(
  db: Db,
  event: OutboxEvent,
  handlers: Record<string, OutboxHandler>,
): Promise<void> {
  const actor =
    (typeof event.payload['actorUserId'] === 'string' && event.payload['actorUserId']) ||
    (typeof event.payload['userId'] === 'string' ? event.payload['userId'] : undefined);

  return withGuc(
    db,
    { tenantId: event.tenantId, userId: actor, system: true },
    async (tx) => {
      const handler = handlers[event.eventType];
      if (handler) await handler({ tx, event });
      await tx.update(outboxEvents).set({ processedAt: new Date() }).where(eq(outboxEvents.id, event.id));
    },
  );
}

export async function processEvent(
  db: Db,
  job: Job<{ event: OutboxEvent }>,
  handlers: Record<string, OutboxHandler>,
): Promise<void> {
  const event = job.data.event;
  try {
    await runEventHandler(db, event, handlers);
  } catch (err) {
    await failEvent(db, event.id, err instanceof Error ? err.message : String(err), job.attemptsMade + 1);
    throw err;
  }
}

function buildHandlers(log: Logger): Record<string, OutboxHandler> {
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
  for (const type of ['user.created', 'user.login', 'user.logout', 'session.created', 'membership.created', 'tenant.created']) {
    registry[type] = logEvent(type as OutboxEventType);
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
}): WorkerRuntime {
  const { db, redis, log } = opts;
  const handlers = buildHandlers(log);

  const eventsWorker = new Worker(
    'events',
    (job) => processEvent(db, job as Job<{ event: OutboxEvent }>, handlers),
    { connection: redis as never, concurrency: 5 },
  );
  const mailWorker = new Worker(
    'mail',
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

  eventsWorker.on('failed', (job, err) => {
    log('error', 'event job failed', { eventId: job?.data?.event?.id, error: err.message });
  });
  mailWorker.on('failed', (job, err) => {
    log('error', 'mail job failed', { jobId: job?.id, error: err.message });
  });

  return {
    async close() {
      await Promise.all([eventsWorker.close(), mailWorker.close()]);
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

async function main(): Promise<void> {
  const env = getEnv();
  const { db } = createDb({ url: env.DATABASE_URL_MIGRATOR, max: env.DB_POOL_MAX });
  const redis = createRedis(env.REDIS_URL);
  const queues = createQueues(redis);

  const log: Logger = (level, msg, data) => {
    const target = level === 'info' ? console.info : level === 'warn' ? console.warn : console.error;
    target(msg, data ?? '');
  };

  const runtime = startOutboxWorker({ db, redis, log });
  const stopDispatcher = startDispatcher({ db, eventsQueue: queues.events, log });

  console.log('[worker] outbox worker + dispatcher started');

  const shutdown = async () => {
    console.log('[worker] shutting down...');
    await stopDispatcher();
    await runtime.close();
    await Promise.all([queues.events.close(), queues.mail.close()]);
    await redis.quit();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void main();
}