import type { FastifyInstance } from 'fastify';
import { pingRedis } from '@sms/redis';

export default async function healthRoutes(app: FastifyInstance) {
  app.get(
    '/health',
    { config: { authorization: { kind: 'public' } } },
    async () => ({
      status: 'ok',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    }),
  );

  app.get(
    '/ready',
    { config: { authorization: { kind: 'public' } } },
    async (request, reply) => {
    let dbOk = true;
    let redisOk = true;
    try {
      await app.db.execute(`SELECT current_database()`);
    } catch {
      dbOk = false;
    }
    redisOk = await pingRedis();
    const ready = dbOk && redisOk;
    reply.code(ready ? 200 : 503);
    return {
      status: ready ? 'ready' : 'not_ready',
      checks: { database: dbOk ? 'ok' : 'down', redis: redisOk ? 'ok' : 'down' },
    };
  });
}