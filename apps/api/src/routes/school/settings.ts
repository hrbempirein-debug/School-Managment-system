import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { schoolSettings, tenants, withTenant, type Tx } from '@sms/db';
import { writeAudit } from '@sms/audit';
import { enqueueOutbox } from '@sms/events';
import { updateSchoolSettingsRequestSchema, type SchoolSettings } from '@sms/contracts';
import {
  requireSession,
  requireTenantContext,
  requirePermission,
  requireCsrf,
} from '../../plugins/auth.js';
import { mapDomainError } from './util.js';

type SettingsRow = typeof schoolSettings.$inferSelect;

export function toSettings(row: SettingsRow): SchoolSettings {
  return {
    id: row.id,
    tenantId: row.tenantId,
    schoolName: row.schoolName,
    schoolCode: row.schoolCode,
    email: row.email,
    phone: row.phone,
    address: row.address,
    timezone: row.timezone,
    locale: row.locale,
    brandingColor: row.brandingColor,
    logoPath: row.logoPath,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export interface SettingsWriteInput {
  schoolName?: string;
  schoolCode?: string;
  email?: string;
  phone?: string;
  address?: string;
  timezone?: string;
  locale?: string;
  brandingColor?: string;
  logoPath?: string | null;
}

const DEFAULTS = {
  schoolName: 'My School',
  timezone: 'UTC',
  locale: 'en',
};

/**
 * Load settings, creating the singleton row on first read. The database enforces
 * "exactly one settings row per tenant" via school_settings_tenant_uq, so any
 * concurrent first-read simply adopts the winner's row.
 */
async function getOrCreateSettings(
  tx: Tx,
  ctx: { userId: string; tenantId: string | null },
): Promise<SettingsRow> {
  const existing = await tx.select().from(schoolSettings).where(eq(schoolSettings.tenantId, ctx.tenantId ?? '')).limit(1).execute();
  if (existing[0]) return existing[0];
  const tenantRows = await tx.select({ name: tenants.name }).from(tenants).where(eq(tenants.id, ctx.tenantId ?? '')).limit(1).execute();
  const inserted = await tx
    .insert(schoolSettings)
    .values({
      tenantId: ctx.tenantId ?? '',
      schoolName: tenantRows[0]?.name ?? DEFAULTS.schoolName,
      timezone: DEFAULTS.timezone,
      locale: DEFAULTS.locale,
    })
    .returning();
  return inserted[0]!;
}

export async function updateSettings(
  tx: Tx,
  ctx: { userId: string; tenantId: string | null },
  input: SettingsWriteInput,
  requestId: string,
): Promise<SettingsRow> {
  try {
    const current = await getOrCreateSettings(tx, ctx);
    const rows = await tx
      .update(schoolSettings)
      .set(input)
      .where(eq(schoolSettings.id, current.id))
      .returning();
    const row = rows[0]!;
    await writeAudit(tx, {
      scope: 'tenant',
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action: 'school.settings.updated',
      resourceType: 'school_settings',
      resourceId: current.id,
      oldValue: toSettings(current),
      newValue: toSettings(row),
      requestId,
    });
    await enqueueOutbox(tx, {
      tenantId: ctx.tenantId,
      eventType: 'school.settings.updated',
      aggregateType: 'school_settings',
      aggregateId: current.id,
      payload: { tenantId: ctx.tenantId, settingsId: current.id },
      correlationId: requestId,
    });
    return row;
  } catch (err) {
    throw mapDomainError(err);
  }
}

export default async function settingsRoutes(app: FastifyInstance) {
  app.get(
    '/api/v1/settings',
    {
      config: { authorization: { kind: 'tenant', permission: 'school.settings.manage' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('school.settings.manage')],
    },
    async (request) => {
      const ctx = request.ctx!;
      const row = await withTenant(app.db, ctx, (tx) => getOrCreateSettings(tx, ctx));
      return { settings: toSettings(row) };
    },
  );

  app.patch(
    '/api/v1/settings',
    {
      config: { authorization: { kind: 'tenant', permission: 'school.settings.manage' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('school.settings.manage'), requireCsrf()],
    },
    async (request) => {
      const body = updateSchoolSettingsRequestSchema.parse(request.body);
      const ctx = request.ctx!;
      const row = await withTenant(app.db, ctx, (tx) => updateSettings(tx, ctx, body, request.requestId));
      return { settings: toSettings(row) };
    },
  );
}