import { describe, it, expect } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { AppError } from '@sms/core';
import registerAuthorizationGate, {
  type AuthorizationContract,
} from './authorization.js';
import {
  requireSession,
  requireTenantContext,
  requirePlatformContext,
  requirePermission,
  gateMetaOf,
  type PreHandler,
} from './auth.js';
import './types.js';

/**
 * Always-on (no DB, no Redis, no port) proofs that the deny-by-default
 * authorization gate refuses to boot a Fastify app unless every registered
 * route declares a valid contract that its enforcement chain actually enforces.
 * `buildApp` mirrors the wiring in `app.ts` (gate registered before routes,
 * `ready()` awaited) so failures surface exactly as they would at startup.
 */
interface RouteSpec {
  url: string;
  contract?: AuthorizationContract;
  preHandler?: PreHandler[];
}

function buildApp(routes: RouteSpec[]): FastifyInstance {
  const app = Fastify({ logger: false });
  registerAuthorizationGate(app);
  for (const route of routes) {
    const opts: Record<string, unknown> = {};
    if (route.contract) opts['config'] = { authorization: route.contract };
    if (route.preHandler) opts['preHandler'] = route.preHandler;
    app.get(route.url, opts, async () => ({ ok: true }));
  }
  return app;
}

async function expectStartupFailure(routes: RouteSpec[], pattern: RegExp): Promise<void> {
  let err: unknown;
  let app: FastifyInstance | null = null;
  try {
    app = buildApp(routes);
    await app.ready();
  } catch (e) {
    err = e;
  }
  try {
    await app?.close();
  } catch {
    // instance may already be torn down after a failed boot — fine
  }
  expect(err).toBeInstanceOf(Error);
  expect((err as Error).message).toMatch(pattern);
}

const sessionPlusPermission = [requireSession(), requirePermission('audit.read')];

describe('authorization gate: deny-by-default startup validation', () => {
  it('rejects a protected (tenant) route with no contract', async () => {
    await expectStartupFailure(
      [{ url: '/protected', preHandler: sessionPlusPermission }],
      /no authorization contract/i,
    );
  });

  it('rejects a tenant route that declares kind tenant but no permission', async () => {
    await expectStartupFailure(
      [{ url: '/ten', preHandler: sessionPlusPermission, contract: { kind: 'tenant' } }],
      /requires an explicit permission/i,
    );
  });

  it('rejects a route whose permission is not in the catalog', async () => {
    await expectStartupFailure(
      [
        {
          url: '/ten',
          preHandler: [
            requireSession(),
            requireTenantContext(),
            requirePermission('attendance.not_a_real_permission'),
          ],
          contract: { kind: 'tenant', permission: 'attendance.not_a_real_permission' },
        },
      ],
      /attendance\.not_a_real_permission.*not in the permission catalog/i,
    );
  });

  it('accepts every Phase 5 attendance permission as a valid tenant contract', async () => {
    const app = buildApp([
      {
        url: '/mark',
        preHandler: [requireSession(), requireTenantContext(), requirePermission('attendance.mark')],
        contract: { kind: 'tenant', permission: 'attendance.mark' },
      },
      {
        url: '/decide',
        preHandler: [
          requireSession(),
          requireTenantContext(),
          requirePermission('attendance.approve_leave'),
        ],
        contract: { kind: 'tenant', permission: 'attendance.approve_leave' },
      },
      {
        url: '/file',
        preHandler: [
          requireSession(),
          requireTenantContext(),
          requirePermission('attendance.request_leave'),
        ],
        contract: { kind: 'tenant', permission: 'attendance.request_leave' },
      },
    ]);
    await expect(app.ready()).resolves.toBeTruthy();
    await app.close();
  });

  it('rejects a tenant route requiring a platform-scope permission', async () => {
    await expectStartupFailure(
      [
        {
          url: '/ten',
          preHandler: [requireSession(), requireTenantContext(), requirePermission('platform.tenants.read')],
          contract: { kind: 'tenant', permission: 'platform.tenants.read' },
        },
      ],
      /tenant route cannot require platform-scope permission/i,
    );
  });

  it('rejects a platform route requiring a tenant-scope permission', async () => {
    await expectStartupFailure(
      [
        {
          url: '/plat',
          preHandler: [requireSession(), requirePlatformContext(), requirePermission('tenant.read')],
          contract: { kind: 'platform', permission: 'tenant.read' },
        },
      ],
      /platform route must require a platform-scope permission/i,
    );
  });

  it('rejects an authenticated route that declares a permission', async () => {
    await expectStartupFailure(
      [{ url: '/me', preHandler: [requireSession()], contract: { kind: 'authenticated', permission: 'tenant.read' } }],
      /kind "authenticated" cannot declare a permission/i,
    );
  });

  it('rejects a tenant route whose chain lacks any permission gate', async () => {
    await expectStartupFailure(
      [{ url: '/ten', preHandler: [requireSession()], contract: { kind: 'tenant', permission: 'audit.read' } }],
      /(not enforced.*no permission gate|no tenantContext gate)/i,
    );
  });

  it('rejects a tenant route enforced by a DIFFERENT permission than declared', async () => {
    await expectStartupFailure(
      [
        {
          url: '/ten',
          preHandler: [requireSession(), requireTenantContext(), requirePermission('tenant.read')],
          contract: { kind: 'tenant', permission: 'audit.read' },
        },
      ],
      /no requirePermission\("audit\.read"\) gate/i,
    );
  });

  it('rejects a tenant route whose chain lacks the tenant context gate', async () => {
    await expectStartupFailure(
      [
        {
          url: '/ten',
          preHandler: [requireSession(), requirePermission('audit.read')],
          contract: { kind: 'tenant', permission: 'audit.read' },
        },
      ],
      /no tenantContext gate/i,
    );
  });

  it('rejects a public route that carries an authorization gate', async () => {
    await expectStartupFailure(
      [{ url: '/pub', preHandler: [requireSession()], contract: { kind: 'public' } }],
      /public route must not carry authorization gates/i,
    );
  });

  it('rejects a platform route enforced only by platform context without the permission gate', async () => {
    await expectStartupFailure(
      [
        {
          url: '/plat',
          preHandler: [requireSession(), requirePlatformContext()],
          contract: { kind: 'platform', permission: 'platform.tenants.read' },
        },
      ],
      /no requirePermission\("platform\.tenants\.read"\) gate/i,
    );
  });
});

describe('authorization gate: valid apps boot and expose the route matrix', () => {
  it('boots a fully-contracted app and reports the inventory in the matrix', async () => {
    const app = buildApp([
      { url: '/health', contract: { kind: 'public' } },
      {
        url: '/api/v1/audit',
        preHandler: [requireSession(), requireTenantContext(), requirePermission('audit.read')],
        contract: { kind: 'tenant', permission: 'audit.read' },
      },
      {
        url: '/api/v1/platform/tenants',
        preHandler: [requireSession(), requirePlatformContext(), requirePermission('platform.tenants.read')],
        contract: { kind: 'platform', permission: 'platform.tenants.read' },
      },
      {
        url: '/api/v1/me',
        preHandler: [requireSession()],
        contract: { kind: 'authenticated' },
      },
    ]);

    await expect(app.ready()).resolves.toBeTruthy();
    const matrix = app.routeAuthorizationMatrix().routes;
    expect(matrix).toEqual(
      expect.arrayContaining([
        { method: 'GET', url: '/health', kind: 'public', permission: null, devOnly: false },
        { method: 'GET', url: '/api/v1/audit', kind: 'tenant', permission: 'audit.read', devOnly: false },
        {
          method: 'GET',
          url: '/api/v1/platform/tenants',
          kind: 'platform',
          permission: 'platform.tenants.read',
          devOnly: false,
        },
        { method: 'GET', url: '/api/v1/me', kind: 'authenticated', permission: null, devOnly: false },
      ]),
    );
    await app.close();
  });

  it('reports an empty matrix as a boot failure (fail closed with zero routes)', async () => {
    await expectStartupFailure([], /found no registered routes/i);
  });
});

describe('authorization gate: HTTP-level enforcement of the contract kinds', () => {
  it('allows anonymous callers on public routes and still forces Ready', async () => {
    const app = buildApp([{ url: '/health', contract: { kind: 'public' } }]);
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    await app.close();
  });

  it('denies anonymous callers on authenticated routes (contract kind enforced at runtime)', async () => {
    const app = buildApp([{ url: '/me', preHandler: [requireSession()], contract: { kind: 'authenticated' } }]);
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/me' });
    expect(res.statusCode).toBe(401);
    // bare Fastify (no API error handler) serializes HttpError with its message
    expect(res.json().message).toBe('Authentication required');
    await app.close();
  });

  it('denies anonymous callers on tenant routes before any permission logic runs', async () => {
    const app = buildApp([
      {
        url: '/audit',
        preHandler: [requireSession(), requireTenantContext(), requirePermission('audit.read')],
        contract: { kind: 'tenant', permission: 'audit.read' },
      },
    ]);
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/audit' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});

describe('gate metadata is attached for contract/enforcement matching', () => {
  it('tags every gate factory result with its role for the startup validator', () => {
    expect(gateMetaOf(requireSession())).toEqual({ kind: 'session' });
    expect(gateMetaOf(requireTenantContext())).toEqual({ kind: 'tenantContext' });
    expect(gateMetaOf(requirePlatformContext())).toEqual({ kind: 'platformContext' });
    expect(gateMetaOf(requirePermission('audit.read'))).toEqual({ kind: 'permission', permission: 'audit.read' });
    expect(gateMetaOf(requirePermission('platform.tenants.read'))).toEqual({
      kind: 'permission',
      permission: 'platform.tenants.read',
    });
    expect(gateMetaOf(() => undefined)).toBeNull();
    expect(gateMetaOf('not-a-function')).toBeNull();
  });
});