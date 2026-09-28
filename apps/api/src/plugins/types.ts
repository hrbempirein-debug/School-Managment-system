import type { FastifyRequest } from 'fastify';
import type { RedisSession } from '@sms/auth';
import type { RequestContext } from '@sms/core';
import type { Db } from '@sms/db';
import type { StorageProvider } from '@sms/storage';
import type { Redis } from 'ioredis';
import type { RouteAuthorizationMatrix, AuthorizationContract } from './authorization.js';

declare module 'fastify' {
  interface FastifyContextConfig {
    authorization?: AuthorizationContract;
  }

  interface FastifyRequest {
    auth?: { token: string; session: RedisSession };
    ctx?: RequestContext;
    requestId: string;
  }

  interface FastifyInstance {
    db: Db;
    redis: Redis;
    storage: StorageProvider;
    routeAuthorizationMatrix: () => RouteAuthorizationMatrix;
  }
}