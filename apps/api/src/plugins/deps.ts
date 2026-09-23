import fp from 'fastify-plugin';
import type { Db } from '@sms/db';
import type { StorageProvider } from '@sms/storage';
import type { Redis } from 'ioredis';
import type { FastifyInstance } from 'fastify';

export interface ApiDeps {
  db: Db;
  redis: Redis;
  storage: StorageProvider;
}

export default fp(async function depsPlugin(app: FastifyInstance, opts: ApiDeps) {
  app.decorate('db', opts.db);
  app.decorate('redis', opts.redis);
  app.decorate('storage', opts.storage);
}, { name: '@sms/deps' });