import type { FastifyInstance } from 'fastify';
import { HttpError } from '@sms/core';
import { requireSession, requireTenantContext, requirePermission } from '../plugins/auth.js';

/**
 * Development-purpose object download (used by the FS storage driver until the
 * S3 presigned-URL driver lands). Object identity is derived from the path and
 * the route rejects any tenant mismatch — cross-tenant object reads are denied
 * before the provider is consulted.
 */
export default async function filesRoutes(app: FastifyInstance) {
  app.get(
    '/api/v1/files/:tenantId/*',
    { preHandler: [requireSession(), requireTenantContext(), requirePermission('tenant.read')] },
    async (request, reply) => {
      const ctx = request.ctx!;
      const { tenantId } = request.params as { tenantId: string };
      const key = (request.params as { '*': string })['*'];
      if (!key || tenantId !== ctx.tenantId) {
        throw new HttpError('File not found', { status: 404, code: 'not_found' });
      }
      const keyClean = key.split('/').map(decodeURIComponent).join('/');
      const buffer = await app.storage.readObject(tenantId, keyClean);
      reply.header('content-type', 'application/octet-stream');
      reply.header('cache-control', 'private, max-age=60');
      return buffer;
    },
  );
}