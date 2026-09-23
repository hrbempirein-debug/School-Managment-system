import { z } from 'zod';
import { SlugSchema, UuidSchema } from './common.js';
import { tenantSummarySchema } from './auth.js';

export const createTenantRequestSchema = z.object({
  name: z.string().min(1).max(120),
  slug: SlugSchema,
  ownerEmail: z.string().email().max(320),
  ownerFullName: z.string().min(1).max(120),
  initialRoleCode: z.string().default('school_owner'),
});
export type CreateTenantRequest = z.infer<typeof createTenantRequestSchema>;

export const createTenantResponseSchema = z.object({ tenant: tenantSummarySchema });
export type CreateTenantResponse = z.infer<typeof createTenantResponseSchema>;

export const switchTenantRequestSchema = z.object({ tenantId: UuidSchema });
export type SwitchTenantRequest = z.infer<typeof switchTenantRequestSchema>;

const meResponseLikeSchema = z.object({
  user: z.object({ userId: z.string().uuid(), email: z.string(), fullName: z.string() }),
  scope: z.enum(['platform', 'tenant']),
  activeTenant: tenantSummarySchema.nullable(),
  permissions: z.array(z.string()),
});

export const switchTenantResponseSchema = meResponseLikeSchema;
export type SwitchTenantResponse = z.infer<typeof switchTenantResponseSchema>;

export const listTenantsResponseSchema = z.object({ tenants: z.array(tenantSummarySchema) });
export type ListTenantsResponse = z.infer<typeof listTenantsResponseSchema>;