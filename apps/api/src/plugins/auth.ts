import type { FastifyRequest, FastifyReply } from 'fastify';
import { getEnv } from '@sms/config';
import { HttpError } from '@sms/core';
import {
  resolveTenantContext,
  loadPlatformContext,
  findActiveMembership,
} from '@sms/tenancy';
import { updateSessionActiveTenant } from '@sms/auth';
import type { RedisSession } from '@sms/auth';

export type PreHandler = (request: FastifyRequest, reply: FastifyReply) => void | Promise<void>;

export function requireSession(): PreHandler {
  return async (request) => {
    if (!request.auth) {
      throw new HttpError('Authentication required', { status: 401, code: 'unauthenticated' });
    }
  };
}

/**
 * Establish a tenant context for the request. Prefers `X-Tenant-Id` header,
 * falling back to the session's active tenant. Fails closed (403) when the user
 * has no active membership for the requested tenant.
 */
export function requireTenantContext(): PreHandler {
  return async (request) => {
    const auth = request.auth;
    if (!auth) {
      throw new HttpError('Authentication required', { status: 401, code: 'unauthenticated' });
    }
    const headerTenant = headerString(request.headers['x-tenant-id']);
    const candidate = headerTenant ?? auth.session.activeTenantId;
    if (!candidate) {
      throw new HttpError('No tenant selected', { status: 400, code: 'tenant_required' });
    }

    try {
      request.ctx = await resolveTenantContext(request.server.db, {
        userId: auth.session.userId,
        tenantId: candidate,
        requestId: request.requestId,
      });
    } catch (err) {
      if (err instanceof HttpError && err.status === 403) {
        throw new HttpError('Tenant access denied', {
          status: 403,
          code: 'forbidden',
          meta: { requiredPermission: null },
        });
      }
      throw err;
    }

    if (headerTenant && headerTenant !== auth.session.activeTenantId) {
      updateSessionActiveTenant(request.server.redis, auth.token, headerTenant).catch(() => {});
    }
  };
}

export function requirePlatformContext(): PreHandler {
  return async (request) => {
    const auth = request.auth;
    if (!auth) {
      throw new HttpError('Authentication required', { status: 401, code: 'unauthenticated' });
    }
    request.ctx = await loadPlatformContext(request.server.db, {
      userId: auth.session.userId,
      requestId: request.requestId,
    });
  };
}

export function requirePermission(permission: string): PreHandler {
  return async (request) => {
    const ctx = request.ctx;
    if (!ctx || !ctx.permissions.has(permission)) {
      throw new HttpError('Insufficient permissions', {
        status: 403,
        code: 'forbidden',
        meta: { requiredPermission: permission },
      });
    }
  };
}

/** Validate an existing (still active) membership so tenant switching is cheap. */
export async function assertActiveMembership(request: FastifyRequest, tenantId: string): Promise<void> {
  const auth = request.auth;
  if (!auth) throw new HttpError('Authentication required', { status: 401, code: 'unauthenticated' });
  const membership = await findActiveMembership(request.server.db, auth.session.userId, tenantId);
  if (!membership) {
    throw new HttpError('Tenant access denied', { status: 403, code: 'forbidden' });
  }
}

/** CSRF double-submit guard for state-changing endpoints. */
export function requireCsrf(): PreHandler {
  return async (request) => {
    const session = request.auth?.session as RedisSession | undefined;
    const header = headerString(request.headers['x-csrf-token']);
    if (!request.auth) {
      throw new HttpError('Authentication required', { status: 401, code: 'unauthenticated' });
    }
    if (!session || !header || header !== session.csrfToken) {
      throw new HttpError('CSRF token mismatch', { status: 403, code: 'csrf_invalid' });
    }
  };
}

function headerString(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

export function setSessionCookie(reply: FastifyReply, token: string): FastifyReply {
  return reply.setCookie(getEnv().SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: getEnv().NODE_ENV === 'production',
    path: '/',
    maxAge: getEnv().SESSION_TTL_ABSOLUTE_MINUTES * 60,
  });
}

export function clearSessionCookie(reply: FastifyReply): FastifyReply {
  return reply.clearCookie(getEnv().SESSION_COOKIE_NAME, { path: '/' });
}