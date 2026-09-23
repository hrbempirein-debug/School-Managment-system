import { z } from 'zod';
import { EmailSchema, UserPasswordSchema } from './common.js';

export const registerRequestSchema = z.object({
  email: EmailSchema,
  password: UserPasswordSchema,
  fullName: z.string().min(1).max(120),
});
export type RegisterRequest = z.infer<typeof registerRequestSchema>;

export const loginRequestSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(1).max(512),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const userProfileSchema = z.object({
  userId: z.string().uuid(),
  email: z.string().email(),
  fullName: z.string(),
});

export const roleSummarySchema = z.object({
  id: z.string().uuid(),
  scope: z.enum(['platform', 'tenant']),
  code: z.string(),
  name: z.string(),
});

export const membershipSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  tenantName: z.string(),
  tenantSlug: z.string(),
  tenantStatus: z.string(),
  status: z.string(),
  roles: z.array(roleSummarySchema),
});
export type MembershipDto = z.infer<typeof membershipSchema>;

export const tenantSummarySchema = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  name: z.string(),
  status: z.string(),
});

export const meResponseSchema = z.object({
  user: userProfileSchema,
  scope: z.enum(['platform', 'tenant']),
  activeTenant: tenantSummarySchema.nullable(),
  permissions: z.array(z.string()),
});
export type MeResponse = z.infer<typeof meResponseSchema>;

export const membershipsResponseSchema = z.object({ memberships: z.array(membershipSchema) });
export type MembershipsResponse = z.infer<typeof membershipsResponseSchema>;

export const registerResponseSchema = z.object({ userId: z.string().uuid() });
export const loginResponseSchema = meResponseSchema;
export const logoutResponseSchema = z.object({ ok: z.literal(true) });