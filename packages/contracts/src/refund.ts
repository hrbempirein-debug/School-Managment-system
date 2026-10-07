import { z } from 'zod';
import { UuidSchema } from './common.js';

/**
 * Phase 7 refund command surface (0028 F11/F12).
 *
 * The approve and process commands are step-up (MFA) gated: the caller first
 * mints a single-use challenge for the exact refund (`POST …/step-up`) and then
 * supplies the 6-digit code from their enrolled authenticator alongside the
 * command. The code is never a response field — it only ever travels on the
 * request — and is never persisted.
 */

export const refundStepUpActionSchema = z.enum(['refund.approve', 'refund.process']);
export type RefundStepUpAction = z.infer<typeof refundStepUpActionSchema>;

export const refundStatusSchema = z.enum(['requested', 'approved', 'rejected', 'processed']);
export type RefundStatus = z.infer<typeof refundStatusSchema>;

const stepUpCodeSchema = z
  .string()
  .regex(/^[0-9]{6}$/, 'A 6-digit step-up code is required');

export const approveRefundRequestSchema = z.object({ code: stepUpCodeSchema });
export type ApproveRefundRequest = z.infer<typeof approveRefundRequestSchema>;

export const processRefundRequestSchema = z.object({
  code: stepUpCodeSchema,
  disbursementReference: z.string().trim().min(1).max(160),
});
export type ProcessRefundRequest = z.infer<typeof processRefundRequestSchema>;

export const rejectRefundRequestSchema = z.object({
  reason: z.string().trim().min(1).max(500),
});
export type RejectRefundRequest = z.infer<typeof rejectRefundRequestSchema>;

export const refundStepUpMintResponseSchema = z.object({
  code: z.string(),
  action: refundStepUpActionSchema,
});

export const refundDecisionResponseSchema = z.object({
  refund: z.object({
    id: UuidSchema,
    status: refundStatusSchema,
  }),
});