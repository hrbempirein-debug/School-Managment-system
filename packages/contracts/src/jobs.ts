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

export interface JobPayload {
  name: string;
  queue: string;
  data: unknown;
}

export const JOB_NAME_TO_QUEUE: Record<string, string> = {
  'event.process': 'events',
  'event.process.single': 'events',
  'mail.stub.send': 'mail',
  'report.studentReportCard': 'reports',
};