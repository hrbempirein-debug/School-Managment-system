import type { FastifyInstance } from 'fastify';
import { and, eq, sql } from 'drizzle-orm';
import { memberships, membershipRoles, roles, withTenant } from '@sms/db';
import { requireSession, requireTenantContext, requirePermission } from '../../plugins/auth.js';

/**
 * Eligible-teacher directory (GET /api/v1/teachers): ACTIVE memberships in the
 * current tenant carrying the tenant-scoped `teacher` role. Exposes only the
 * user identity and display name — no PII beyond it, and never any secret.
 * Display names are resolved through app_safe_user_display(), a controlled
 * SECURITY DEFINER helper, because user_profiles is self-visible only (the
 * helper still enforces a mutual active-membership check in the same tenant).
 */
export default async function teacherDirectoryRoutes(app: FastifyInstance) {
  app.get(
    '/api/v1/teachers',
    {
      config: { authorization: { kind: 'tenant', permission: 'teacher.assignments.read' } },
      preHandler: [
        requireSession(),
        requireTenantContext(),
        requirePermission('teacher.assignments.read'),
      ],
    },
    async (request) => {
      const ctx = request.ctx!;
      const rows = await withTenant(app.db, ctx, (tx) =>
        tx
          .select({
            userId: memberships.userId,
            fullName: sql<string | null>`app_safe_user_display(${memberships.userId}, ${ctx.tenantId})`,
          })
          .from(memberships)
          .innerJoin(membershipRoles, eq(membershipRoles.membershipId, memberships.id))
          .innerJoin(roles, eq(roles.id, membershipRoles.roleId))
          .where(
            and(
              eq(memberships.tenantId, ctx.tenantId ?? ''),
              eq(memberships.status, 'active'),
              eq(roles.scope, 'tenant'),
              eq(roles.code, 'teacher'),
            ),
          )
          .orderBy(memberships.userId)
          .execute(),
      );
      return { items: rows, total: rows.length };
    },
  );
}