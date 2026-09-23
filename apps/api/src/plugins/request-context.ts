import fp from 'fastify-plugin';
import { getEnv } from '@sms/config';
import { uuidv7 } from '@sms/core';
import { readSession } from '@sms/auth';
import type { FastifyInstance } from 'fastify';

/**
 * Assigns a request id, parses the session cookie into `request.auth` (best
 * effort — missing/invalid cookies simply leave `auth` unset), and surfaces the
 * request id on the response.
 */
export default fp(async function requestContextPlugin(app: FastifyInstance) {
  app.decorateRequest('requestId', '');
  app.decorateRequest('auth', undefined);

  app.addHook('onRequest', async (request, reply) => {
    const headerId = request.headers['x-request-id'];
    const requestId = typeof headerId === 'string' && headerId ? headerId : uuidv7();
    request.requestId = requestId;
    reply.header('x-request-id', requestId);

    const cookie = request.cookies?.[getEnv().SESSION_COOKIE_NAME];
    if (!cookie) return;
    const session = await readSession(app.redis, cookie);
    if (session) {
      request.auth = { token: cookie, session };
    }
  });
});