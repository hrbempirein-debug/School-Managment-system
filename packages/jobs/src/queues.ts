import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { JOB_NAME_TO_QUEUE } from '@sms/contracts';

export { JOB_NAME_TO_QUEUE };

/**
 * `reports` is Phase 6's artifact queue (JOB_ARCHITECTURE §2). It is separate
 * from `events` because a report card is a heavy, idempotent artifact job, not a
 * request/response event: it must not be blocked behind event handling and must
 * not compete with the outbox for concurrency.
 */
export type JobQueueName = 'events' | 'mail' | 'reports';

export interface QueueDelegates {
  events: Queue;
  mail: Queue;
  reports: Queue;
}

function buildQueue(name: JobQueueName, redis: Redis): Queue {
  return new Queue(name as never, {
    connection: redis as never,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: 1000,
      removeOnFail: 5000,
    },
  });
}

export function createQueues(redis: Redis): QueueDelegates {
  return {
    events: buildQueue('events', redis),
    mail: buildQueue('mail', redis),
    reports: buildQueue('reports', redis),
  };
}

export async function closeQueues(queues: QueueDelegates): Promise<void> {
  await Promise.all([queues.events.close(), queues.mail.close(), queues.reports.close()]);
}

export function queueForJob(jobName: string): JobQueueName {
  const mapped = JOB_NAME_TO_QUEUE[jobName];
  if (mapped === 'mail') return 'mail';
  if (mapped === 'reports') return 'reports';
  return 'events';
}
