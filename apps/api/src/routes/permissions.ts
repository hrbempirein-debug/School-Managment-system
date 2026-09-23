import type { FastifyInstance } from 'fastify';
import { PERMISSION_CATALOG } from '@sms/permissions';
import { requireSession } from '../plugins/auth.js';

export default async function permissionsRoutes(app: FastifyInstance) {
  app.get(
    '/api/v1/permissions',
    { preHandler: requireSession() },
    async () => ({
      permissions: [...PERMISSION_CATALOG],
    }),
  );
}