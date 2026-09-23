import { z } from 'zod';

export const outboxEventTypeSchema = z.enum([
  'user.created',
  'user.login',
  'user.logout',
  'session.created',
  'membership.created',
  'tenant.created',
]);

export type OutboxEventType = z.infer<typeof outboxEventTypeSchema>;

export const outboxEventSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid().nullable(),
  eventType: outboxEventTypeSchema,
  aggregateType: z.string(),
  aggregateId: z.string(),
  payload: z.record(z.unknown()),
  correlationId: z.string().nullable(),
  causationId: z.string().nullable(),
  createdAt: z.string(),
});

export type OutboxEvent = z.infer<typeof outboxEventSchema>;

export interface NewOutboxEvent {
  tenantId: string | null;
  eventType: OutboxEventType;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  correlationId?: string | null;
  causationId?: string | null;
}