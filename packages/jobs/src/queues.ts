import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { JOB_NAME_TO_QUEUE } from '@sms/contracts';

export { JOB_NAME_TO_QUEUE };

export type JobQueueName = 'events' | 'mail';

export interface QueueDelegates {
  events: Queue;
  mail: Queue;
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
  };
}

export async function closeQueues(queues: QueueDelegates): Promise<void> {
  await Promise.all([queues.events.close(), queues.mail.close()]);
}

export function queueForJob(jobName: string): JobQueueName {
  const mapped = JOB_NAME_TO_QUEUE[jobName];
  return mapped === 'mail' ? 'mail' : 'events';
}