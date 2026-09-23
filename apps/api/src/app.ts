import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit, { type RateLimitOptions } from '@fastify/rate-limit';
import { ZodError } from 'zod';
import { getEnv } from '@sms/config';
import { toApiErrorEnvelope, HttpError, isAuthzDeny } from '@sms/core';
import { assertCatalogConsistent } from '@sms/permissions';
import depsPlugin, { type ApiDeps } from './plugins/deps.js';
import requestContextPlugin from './plugins/request-context.js';
import './plugins/types.js';
import healthRoutes from './routes/health.js';
import authRoutes from './routes/auth.js';
import meRoutes from './routes/me.js';
import permissionsRoutes from './routes/permissions.js';
import tenantsRoutes from './routes/tenants.js';
import auditRoutes from './routes/audit.js';
import filesRoutes from './routes/files.js';

export interface BuildAppOptions {
  deps: ApiDeps;
  logger?: boolean | Record<string, unknown>;
}

export async function buildApp({ deps, logger = true }: BuildAppOptions): Promise<FastifyInstance> {
  assertCatalogConsistent();

  const app = Fastify({
    logger,
    trustProxy: true,
    disableRequestLogging: false,
    requestIdHeader: 'x-request-id',
  });

  await app.register(depsPlugin, deps);
  await app.register(cookie);
  await app.register(helmet, { global: true });
  await app.register(cors, {
    origin: getEnv().WEB_BASE_URL,
    credentials: true,
  });
  await app.register(requestContextPlugin);
  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: '1 minute',
    redis: deps.redis,
    keyGenerator: (req: { ip?: string }) => String(req.ip ?? 'unknown'),
  } as unknown as RateLimitOptions);

  await app.register(healthRoutes, { prefix: '/' });
  await app.register(authRoutes);
  await app.register(meRoutes);
  await app.register(permissionsRoutes);
  await app.register(tenantsRoutes);
  await app.register(auditRoutes);
  await app.register(filesRoutes);

  app.setErrorHandler(async (error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: {
          code: 'validation_error',
          message: 'Request validation failed',
          details: error.issues.map((i) => ({
            path: i.path.join('.'),
            message: i.message,
          })),
          requestId: request.requestId,
          requiredPermission: null,
        },
      });
    }

    const status = error instanceof HttpError ? error.status : 500;
    const envelope = toApiErrorEnvelope(error, request.requestId);
    if (status >= 500) request.log.error({ err: error }, 'unhandled error');
    else if (!isAuthzDeny(error)) request.log.warn({ err: error }, 'request error');
    return reply.code(status).send(envelope);
  });

  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('x-request-id', request.requestId);
    return payload;
  });

  return app;
}