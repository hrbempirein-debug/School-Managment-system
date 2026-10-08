import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import {
  JOB_NAME_TO_QUEUE,
  JOB_PAYLOAD_SCHEMAS,
  jobNameSchema,
  type JobName,
  type JobPayload,
  type JobQueueName,
} from '@sms/contracts';

export { JOB_NAME_TO_QUEUE, JOB_PAYLOAD_SCHEMAS };
export type { JobName, JobPayload, JobQueueName };

/**
 * `reports` is Phase 6's artifact queue (JOB_ARCHITECTURE §2). It is separate
 * from `events` because a report card is a heavy, idempotent artifact job, not a
 * request/response event: it must not be blocked behind event handling and must
 * not compete with the outbox for concurrency.
 *
 * `QueueDelegates` has exactly one member per `JobQueueName`, so the union above
 * indexes it and there is no way to route to a queue that is not wired.
 */
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

/**
 * Thrown when a job cannot be routed with certainty. Routing is fail-closed by
 * design: there is no default queue, no silent fallback, and no "probably events"
 * heuristic. Every rejection below is a bug in the caller, not a transient
 * condition, so it must surface as an error rather than be absorbed.
 */
export class JobRoutingError extends Error {
  override readonly name = 'JobRoutingError';
}

/**
 * AUTHORITATIVE queue router (D1 remediation).
 *
 * Replaces two non-failing implementations that both defaulted to `events`:
 *   - the binary ternary in `apps/worker/src/worker.ts`
 *     (`job.queue === 'mail' ? mail : events`), which silently mis-routed the
 *     `reports` category so `report.studentReportCard` never reached its consumer;
 *   - `queueForJob()` here, whose `return 'events'` swallowed unknown job names.
 *
 * Fail-closed contract — ALL of these throw `JobRoutingError`:
 *   - the job name is not a known `JobName`
 *   - the declared `job.queue` disagrees with the authoritative mapping
 *   - the payload does not satisfy the schema registered for that job name
 *
 * Returns the queue category the job must be delivered to. Callers MUST NOT
 * catch and re-route.
 */
export function resolveQueueForJob(job: JobPayload): JobQueueName {
  const nameResult = jobNameSchema.safeParse(job?.name);
  if (!nameResult.success) {
    throw new JobRoutingError(
      `refusing to route unknown job name ${JSON.stringify(job?.name)}: ` +
        `it is not in the job-name catalog, so no queue is authoritative for it`,
    );
  }
  const name: JobName = nameResult.data;

  const mapped = JOB_NAME_TO_QUEUE[name];
  if (!mapped) {
    // Unreachable while `JOB_NAME_TO_QUEUE` is typed `Record<JobName, ...>`;
    // retained so a future cast or a hand-built object still fails closed.
    throw new JobRoutingError(`job name '${name}' has no entry in JOB_NAME_TO_QUEUE`);
  }

  if (job.queue !== mapped) {
    throw new JobRoutingError(
      `job '${name}' declares queue '${String(job.queue)}' but JOB_NAME_TO_QUEUE says '${mapped}': ` +
        `a declared queue may not override the authoritative mapping`,
    );
  }

  const payloadSchema = JOB_PAYLOAD_SCHEMAS[name];
  const payloadResult = payloadSchema?.safeParse(job.data);
  if (!payloadResult || !payloadResult.success) {
    const issues = payloadResult?.success === false ? payloadResult.error.issues.length : 0;
    throw new JobRoutingError(
      `job '${name}' has a malformed payload (${issues} schema issue(s)); refusing to route it`,
    );
  }

  return mapped;
}
