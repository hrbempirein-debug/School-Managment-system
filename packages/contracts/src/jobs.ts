import { z } from 'zod';
import { outboxEventSchema } from './events.js';

export const jobNameSchema = z.enum([
  'event.process',
  'event.process.single',
  'mail.stub.send',
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

export interface JobPayload {
  name: string;
  queue: string;
  data: unknown;
}

export const JOB_NAME_TO_QUEUE: Record<string, string> = {
  'event.process': 'events',
  'event.process.single': 'events',
  'mail.stub.send': 'mail',
};