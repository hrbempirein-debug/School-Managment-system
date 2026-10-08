import { z } from 'zod';
import { outboxEventSchema } from './events.js';

export const jobNameSchema = z.enum([
  'event.process',
  'event.process.single',
  'mail.stub.send',
  // Phase 6: report-card PDF generation. JOB_ARCHITECTURE §2 gives `reports` its
  // own queue (concurrency 3) because a report card is a heavy artifact, not a
  // request/response job. The name is the documented one from §3.
  'report.studentReportCard',
]);
export type JobName = z.infer<typeof jobNameSchema>;

export const eventProcessJobSchema = z.object({
  event: outboxEventSchema,
});
export type EventProcessJob = z.infer<typeof eventProcessJobSchema>;

export const mailStubSendJobSchema = z.object({
  to: z.string().email(),
  template: z.string(),
  data: z.record(z.unknown()),
  tenantId: z.string().uuid().nullable(),
  correlationId: z.string().nullable(),
});
export type MailStubSendJob = z.infer<typeof mailStubSendJobSchema>;

/**
 * Report-card artifact job. `reportCardId` is the only input: the handler loads
 * the snapshot, generates the PDF and stamps `report_cards.file_id`, so the job
 * payload can never carry (or override) result data. `idempotencyKey` is the
 * outbox event id, which keeps a redelivered `report_card.generated` convergent.
 */
export const studentReportCardJobSchema = z.object({
  reportCardId: z.string().uuid(),
  tenantId: z.string().uuid(),
  idempotencyKey: z.string().min(1),
  correlationId: z.string().nullable().optional(),
});
export type StudentReportCardJob = z.infer<typeof studentReportCardJobSchema>;

/**
 * The closed set of queue categories the worker knows how to consume. Adding a
 * queue is a deliberate, reviewable act: `JOB_NAME_TO_QUEUE` below must map every
 * `JobName` onto one of these, and the router in `@sms/jobs` refuses anything else.
 */
export const JOB_QUEUE_NAMES = ['events', 'mail', 'reports'] as const;
export type JobQueueName = (typeof JOB_QUEUE_NAMES)[number];
export const jobQueueNameSchema = z.enum(JOB_QUEUE_NAMES);

export interface JobPayload {
  name: JobName;
  queue: JobQueueName;
  data: unknown;
}

/**
 * AUTHORITATIVE job-name → queue-category map (D1 remediation).
 *
 * This is the single source of truth for routing. Two properties are load-bearing:
 *
 *  1. The value type is `JobQueueName`, not `string`, so a typo fails to compile.
 *  2. The key type is the `JobName` union, so adding a member to `jobNameSchema`
 *     without mapping it here is a compile error.
 *
 * Routing MUST derive from this table. An earlier binary ternary in
 * `apps/worker/src/worker.ts` (`job.queue === 'mail' ? mail : events`) silently
 * collapsed `reports` onto `events`, which is why `report.studentReportCard`
 * never reached its consumer.
 */
export const JOB_NAME_TO_QUEUE: Readonly<Record<JobName, JobQueueName>> = {
  'event.process': 'events',
  'event.process.single': 'events',
  'mail.stub.send': 'mail',
  'report.studentReportCard': 'reports',
};

/**
 * Per-job payload contracts, keyed by the same `JobName` union. The router
 * validates the payload against the schema for the job it is about to route, so a
 * malformed payload fails closed instead of being handed to a consumer that will
 * misread it.
 */
export const JOB_PAYLOAD_SCHEMAS: Readonly<Record<JobName, z.ZodTypeAny>> = {
  'event.process': eventProcessJobSchema,
  'event.process.single': eventProcessJobSchema,
  'mail.stub.send': mailStubSendJobSchema,
  'report.studentReportCard': studentReportCardJobSchema,
};