import type { FastifyInstance } from 'fastify';
import { desc } from 'drizzle-orm';
import { auditLogs, withTenant } from '@sms/db';
import { requireSession, requireTenantContext, requirePermission } from '../plugins/auth.js';

export default async function auditRoutes(app: FastifyInstance) {
  app.get(
    '/api/v1/audit',
    {
      config: { authorization: { kind: 'tenant', permission: 'audit.read' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('audit.read')],
    },
    async (request) => {
      const ctx = request.ctx!;
      const rows = await withTenant(app.db, ctx, (tx) =>
        tx
          .select({
            id: auditLogs.id,
            action: auditLogs.action,
            actorUserId: auditLogs.actorUserId,
            actorType: auditLogs.actorType,
            resourceType: auditLogs.resourceType,
            resourceId: auditLogs.resourceId,
            occurredAt: auditLogs.occurredAt,
          })
          .from(auditLogs)
          .orderBy(desc(auditLogs.occurredAt))
          .limit(100)
          .execute(),
      );
      return {
        auditLogs: rows.map((r) => ({
          id: r.id,
          action: r.action,
          actorUserId: r.actorUserId,
          actorType: r.actorType,
          resourceType: r.resourceType,
          resourceId: r.resourceId,
          occurredAt: r.occurredAt.toISOString(),
        })),
      };
    },
  );
}