import type { FastifyInstance } from 'fastify';
import '@fastify/rate-limit';
import { getEnv } from '@sms/config';
import { registerRequestSchema, loginRequestSchema } from '@sms/contracts';
import { registerUser, loginUser, logoutUser, currentUser } from '@sms/auth';
import { listMemberships } from '@sms/tenancy';
import {
  requireSession,
  requireCsrf,
  setSessionCookie,
  clearSessionCookie,
} from '../plugins/auth.js';
import { buildMeResponse } from './shared.js';

export default async function authRoutes(app: FastifyInstance) {

  app.post(
    '/api/v1/auth/register',
    { config: { rateLimit: { max: getEnv().RATE_REGISTER_POINTS, timeWindow: getEnv().RATE_REGISTER_DURATION_SECONDS * 1000 } } },
    async (request) => {
    const body = registerRequestSchema.parse(request.body);
    const { userId } = await registerUser(app.db, {
      email: body.email,
      password: body.password,
      fullName: body.fullName,
      ip: request.ip,
      userAgent: request.headers['user-agent'],
      requestId: request.requestId,
    });
    return { userId };
  });

  app.post(
    '/api/v1/auth/login',
    { config: { rateLimit: { max: getEnv().RATE_LOGIN_POINTS, timeWindow: getEnv().RATE_LOGIN_DURATION_SECONDS * 1000 } } },
    async (request, reply) => {
      const body = loginRequestSchema.parse(request.body);
      const result = await loginUser({
        db: app.db,
        redis: app.redis,
        input: {
          email: body.email,
          password: body.password,
          ip: request.ip,
          userAgent: request.headers['user-agent'],
          requestId: request.requestId,
        },
      });
      setSessionCookie(reply, result.token);
      reply.setCookie('csrf', result.session.csrfToken, {
        httpOnly: false,
        sameSite: 'strict',
        secure: getEnv().NODE_ENV === 'production',
        path: '/',
      });
      const memberships = await listMemberships(app.db, result.user.userId);
      return buildMeResponse(result.user, memberships, null);
    },
  );

  app.post(
    '/api/v1/auth/logout',
    { preHandler: [requireSession(), requireCsrf()] },
    async (request, reply) => {
      await logoutUser({
        db: app.db,
        redis: app.redis,
        input: {
          token: request.auth!.token,
          ip: request.ip,
          userAgent: request.headers['user-agent'],
          requestId: request.requestId,
        },
      });
      clearSessionCookie(reply);
      reply.clearCookie('csrf', { path: '/' });
      return { ok: true } as const;
    },
  );
}