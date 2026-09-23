import { z } from 'zod';

export const errorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown(),
    requestId: z.string(),
    requiredPermission: z.string().nullable(),
  }),
});

export type ApiErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;