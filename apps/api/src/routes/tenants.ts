import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { HttpError } from '@sms/core';
import {
  tenants,
  memberships,
  roles,
  rolePermissions,
  membershipRoles,
  withTenant,
  type Tx,
} from '@sms/db';
import { writeAudit } from '@sms/audit';
import { enqueueOutbox } from '@sms/events';
import { ROLE_TEMPLATES } from '@sms/permissions';
import { setTenantScope } from '@sms/tenancy';
import {
  requireSession,
  requirePlatformContext,
  requirePermission,
} from '../plugins/auth.js';

const createTenantSchema = z.object({
  slug: z.string().min(2).max(60).regex(/^[a-z0-9-]+$/, 'slug must be lowercase letters, numbers, hyphens'),
  name: z.string().min(1).max(160),
});

export interface CreateTenantInput {
  slug: string;
  name: string;
  requestId: string;
}

/**
 * Creates a tenant and bootstraps the creator's owner membership in one
 * transaction, then establishes tenant context and records the tenant-scoped
 * audit/outbox entries.
 *
 * The tenant ticket MUST be minted only AFTER the membership row exists:
 * app_ctx_mint('tenant', ...) is gated on an active membership and leaves the
 * previous context untouched when it returns NULL. Minting before the insert
 * therefore keeps the (platform) context active, and the tenant-scoped
 * audit/outbox writes below are rejected by RLS, aborting the transaction.
 */
export async function createTenantTransaction(
  tx: Tx,
  ctx: { userId: string },
  input: CreateTenantInput,
): Promise<{ tenantId: string; membershipId: string }> {
  const { slug, name, requestId } = input;
  const { userId } = ctx;

  let tenantId: string;
  try {
    const insertedRows = await tx
      .insert(tenants)
      .values({ slug, name })
      .returning({ id: tenants.id });
    tenantId = insertedRows[0]!.id;
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      throw new HttpError('A tenant with that slug already exists', {
        status: 409,
        code: 'tenant_slug_taken',
      });
    }
    throw err;
  }

  const seededRoleIds: Record<string, string> = {};
  for (const template of ROLE_TEMPLATES.filter((t) => t.scope === 'tenant')) {
    const roleRows = await tx
      .insert(roles)
      .values({
        tenantId,
        scope: 'tenant',
        code: template.code,
        name: template.name,
        description: template.description,
        isSystem: true,
      })
      .returning({ id: roles.id });
    const role = roleRows[0]!;
    seededRoleIds[template.code] = role.id;
    for (const permission of template.permissions) {
      await tx.insert(rolePermissions).values({ roleId: role.id, permission });
    }
  }

  const membershipRows = await tx
    .insert(memberships)
    .values({ tenantId, userId, status: 'active' })
    .returning({ id: memberships.id });
  const membership = membershipRows[0]!;
  const ownerRole = seededRoleIds['school_owner'];
  if (ownerRole) {
    await tx.insert(membershipRoles).values({ membershipId: membership.id, roleId: ownerRole });
  }

  // Tenant context is established only after the membership exists. Subsequent
  // operations (audit, outbox) run under the new tenant's identity.
  await setTenantScope(tx, userId, tenantId);

  await writeAudit(tx, {
    scope: 'tenant',
    tenantId,
    actorUserId: userId,
    action: 'tenant.created',
    resourceType: 'tenant',
    resourceId: tenantId,
    newValue: { slug, name },
    requestId,
  });
  await writeAudit(tx, {
    scope: 'tenant',
    tenantId,
    actorUserId: userId,
    action: 'membership.created',
    resourceType: 'membership',
    resourceId: membership.id,
    newValue: { tenantId, status: 'active' },
    requestId,
  });

  await enqueueOutbox(tx, {
    tenantId,
    eventType: 'tenant.created',
    aggregateType: 'tenant',
    aggregateId: tenantId,
    payload: { tenantId, slug, name },
    correlationId: requestId,
  });
  await enqueueOutbox(tx, {
    tenantId,
    eventType: 'membership.created',
    aggregateType: 'membership',
    aggregateId: membership.id,
    payload: { tenantId, userId, roleCode: 'school_owner' },
    correlationId: requestId,
  });

  return { tenantId, membershipId: membership.id };
}

export default async function tenantsRoutes(app: FastifyInstance) {
  app.post(
    '/api/v1/platform/tenants',
    {
      config: { authorization: { kind: 'platform', permission: 'platform.tenants.create' } },
      preHandler: [requireSession(), requirePlatformContext(), requirePermission('platform.tenants.create')],
    },
    async (request, reply) => {
      const body = createTenantSchema.parse(request.body);
      const ctx = request.ctx!;

      const created = await withTenant(app.db, ctx, (tx) =>
        createTenantTransaction(tx, ctx, {
          slug: body.slug,
          name: body.name,
          requestId: request.requestId,
        }),
      );

      reply.code(201);
      return {
        id: created.tenantId,
        slug: body.slug,
        name: body.name,
        status: 'active',
        membershipId: created.membershipId,
      };
    },
  );

  app.get(
    '/api/v1/platform/tenants',
    {
      config: { authorization: { kind: 'platform', permission: 'platform.tenants.read' } },
      preHandler: [requireSession(), requirePlatformContext(), requirePermission('platform.tenants.read')],
    },
    async (request) => {
      const ctx = request.ctx!;
      const rows = await withTenant(app.db, ctx, (tx) =>
        tx.select().from(tenants).orderBy(tenants.createdAt).limit(100).execute(),
      );
      return {
        tenants: rows.map((t) => ({
          id: t.id,
          slug: t.slug,
          name: t.name,
          status: t.status,
          createdAt: t.createdAt.toISOString(),
        })),
      };
    },
  );
}