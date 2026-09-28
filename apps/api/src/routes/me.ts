import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { HttpError } from '@sms/core';
import { currentUser, updateSessionActiveTenant } from '@sms/auth';
import { listMemberships, findActiveMembership } from '@sms/tenancy';
import { withTenant } from '@sms/db';
import { attendanceRangeQuerySchema } from '@sms/contracts';
import { requireSession, requireTenantContext, requirePermission, requireCsrf } from '../plugins/auth.js';
import { buildMeResponse } from './shared.js';
import { resolveHomeworkContext } from './school/homework.js';
import { resolveAttendanceContext, resolveAttendancePortal } from './school/attendance.js';

const switchSchema = z.object({ tenantId: z.string().uuid() });

export default async function meRoutes(app: FastifyInstance) {
  app.get(
    '/api/v1/me',
    {
      config: { authorization: { kind: 'authenticated' } },
      preHandler: requireSession(),
    },
    async (request) => {
      const auth = request.auth!;
      const [user, memberships] = await Promise.all([
        currentUser(app.db, auth.session.userId),
        listMemberships(app.db, auth.session.userId),
      ]);
      return buildMeResponse(user, memberships, auth.session.activeTenantId);
    },
  );

  app.get(
    '/api/v1/me/homework-context',
    {
      config: { authorization: { kind: 'tenant', permission: 'homework.read' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('homework.read')],
    },
    async (request) => {
      const ctx = request.ctx!;
      const context = await withTenant(app.db, ctx, (tx) => resolveHomeworkContext(tx, ctx));
      return { context };
    },
  );

  app.get(
    '/api/v1/me/attendance-context',
    {
      config: { authorization: { kind: 'tenant', permission: 'attendance.read' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('attendance.read')],
    },
    async (request) => {
      const ctx = request.ctx!;
      const context = await withTenant(app.db, ctx, (tx) => resolveAttendanceContext(tx, ctx));
      return { context };
    },
  );

  app.get(
    '/api/v1/me/attendance',
    {
      config: { authorization: { kind: 'tenant', permission: 'attendance.read' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('attendance.read')],
    },
    async (request) => {
      const ctx = request.ctx!;
      const query = attendanceRangeQuerySchema.parse(request.query);
      return withTenant(app.db, ctx, (tx) => resolveAttendancePortal(tx, ctx, query));
    },
  );

  app.get(
    '/api/v1/me/memberships',
    {
      config: { authorization: { kind: 'authenticated' } },
      preHandler: requireSession(),
    },
    async (request) => {
      const auth = request.auth!;
      const memberships = await listMemberships(app.db, auth.session.userId);
      return {
        memberships: memberships
          .filter((m) => m.status === 'active')
          .map((m) => ({
            id: m.id,
            tenantId: m.tenantId,
            tenantName: m.tenantName,
            tenantSlug: m.tenantSlug,
            tenantStatus: m.tenantStatus,
            status: m.status,
            roles: m.roles,
          })),
      };
    },
  );

  app.post(
    '/api/v1/tenants/switch',
    {
      config: { authorization: { kind: 'authenticated' } },
      preHandler: [requireSession(), requireCsrf()],
    },
    async (request) => {
      const auth = request.auth!;
      const body = switchSchema.parse(request.body);
      const membership = await findActiveMembership(app.db, auth.session.userId, body.tenantId);
      if (!membership) {
        throw new HttpError('Tenant access denied', { status: 403, code: 'forbidden' });
      }
      await updateSessionActiveTenant(app.redis, auth.token, body.tenantId);
      const [user, memberships] = await Promise.all([
        currentUser(app.db, auth.session.userId),
        listMemberships(app.db, auth.session.userId),
      ]);
      return buildMeResponse(user, memberships, body.tenantId);
    },
  );
}