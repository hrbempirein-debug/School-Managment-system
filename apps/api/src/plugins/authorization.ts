import type { FastifyInstance } from 'fastify';
import { AppError } from '@sms/core';
import {
  assertCatalogConsistent,
  isRegisteredPermission,
  isPlatformPermission,
} from '@sms/permissions';
import { AUTHZ_GATE_META, gateMetaOf, type AuthzGateMeta } from './auth.js';

/**
 * Deny-by-default authorization contract. EVERY route must declare one of these
 * in its `config.authorization`. Startup fails (onReady) if any route is missing
 * a contract, declares an unknown/out-of-scope permission, or is not enforced by
 * the gates its contract requires. There is no inferred or default permission:
 * `kind: 'authenticated'` proves only that a session is present — privilege on
 * tenant/platform data always requires an explicit `permission` and the matching
 * tenant/platform enforcement gates.
 */
export type AuthorizationKind = 'public' | 'authenticated' | 'tenant' | 'platform';

export interface AuthorizationContract {
  kind: AuthorizationKind;
  /** Required when kind is `tenant` or `platform`. */
  permission?: string;
  /** Marked true for development-only endpoints (e.g. the FS file proxy). */
  devOnly?: boolean;
}

export interface RouteAuthorizationEntry {
  method: string;
  url: string;
  kind: AuthorizationKind;
  permission: string | null;
  devOnly: boolean;
}

const CONTRACT_KINDS = new Set<AuthorizationKind>(['public', 'authenticated', 'tenant', 'platform']);

const REQUIRED_GATES: Record<AuthorizationKind, readonly AuthzGateMeta['kind'][]> = {
  public: [],
  authenticated: ['session'],
  tenant: ['session', 'tenantContext', 'permission'],
  platform: ['session', 'platformContext', 'permission'],
};

const FORBIDDEN_GATES_ON_PUBLIC = new Set<AuthzGateMeta['kind']>(['session', 'tenantContext', 'platformContext', 'permission']);

function describeRoute(method: string, url: string): string {
  return `${method} ${url}`;
}

function validateContract(
  method: string,
  url: string,
  contract: AuthorizationContract,
  presentGates: AuthzGateMeta[],
): void {
  const route = describeRoute(method, url);

  if (!CONTRACT_KINDS.has(contract.kind)) {
    throw new AppError(`Route ${route}: invalid authorization.kind "${String(contract.kind)}"`);
  }

  if (contract.kind === 'tenant' || contract.kind === 'platform') {
    if (!contract.permission) {
      throw new AppError(`Route ${route}: authorization.kind "${contract.kind}" requires an explicit permission`);
    }
    if (!isRegisteredPermission(contract.permission)) {
      throw new AppError(`Route ${route}: permission "${contract.permission}" is not in the permission catalog`);
    }
    const platformPermission = isPlatformPermission(contract.permission);
    if (contract.kind === 'tenant' && platformPermission) {
      throw new AppError(`Route ${route}: a tenant route cannot require platform-scope permission "${contract.permission}"`);
    }
    if (contract.kind === 'platform' && !platformPermission) {
      throw new AppError(`Route ${route}: a platform route must require a platform-scope permission, got "${contract.permission}"`);
    }
  } else if (contract.permission) {
    throw new AppError(`Route ${route}: authorization.kind "${contract.kind}" cannot declare a permission`);
  }

  for (const required of REQUIRED_GATES[contract.kind]) {
    if (required === 'permission') {
      const matched = presentGates.some(
        (g): boolean => g.kind === 'permission' && g.permission === contract.permission,
      );
      if (!matched) {
        throw new AppError(`Route ${route}: contract kind "${contract.kind}" is not enforced — no requirePermission("${contract.permission}") gate in preHandler`);
      }
      continue;
    }
    if (!presentGates.some((g) => g.kind === required)) {
      throw new AppError(`Route ${route}: contract kind "${contract.kind}" is not enforced — no ${required} gate in preHandler`);
    }
  }

  if (contract.kind === 'public') {
    const forbidden = presentGates.filter((g) => FORBIDDEN_GATES_ON_PUBLIC.has(g.kind));
    if (forbidden.length > 0) {
      throw new AppError(`Route ${route}: public route must not carry authorization gates (${forbidden.map((g) => g.kind).join(', ')})`);
    }
  }
}

function contractFromRouteConfig(config: Record<string, unknown> | undefined): AuthorizationContract {
  const raw = config?.['authorization'];
  if (!raw || typeof raw !== 'object') {
    throw new AppError(
      'Route has no authorization contract — configure config.authorization { kind, permission? } or start fails closed (deny-by-default).',
    );
  }
  return raw as AuthorizationContract;
}

export interface RouteAuthorizationMatrix {
  routes: readonly RouteAuthorizationEntry[];
}

/**
 * Fail-closed authorization gate. Called directly on the root Fastify instance
 * (not via register) so the onRoute capture sees every later route and the
 * onReady validator refuses to boot an app with an unannotated/under-enforced
 * route.
 */
export default function registerAuthorizationGate(app: FastifyInstance): void {
  assertCatalogConsistent();

  const inventory = new Map<
    string,
    RouteAuthorizationEntry & { contract: AuthorizationContract; gates: AuthzGateMeta[] }
  >();
  const keyOf = (method: string, url: string): string => `${method} ${url}`;

  app.addHook('onRoute', (routeOptions) => {
    const rawMethod = Array.isArray(routeOptions.method) ? routeOptions.method[0] : routeOptions.method;
    const method = (rawMethod ?? 'GET').toUpperCase();
    const url = routeOptions.url;
    const contract = contractFromRouteConfig(routeOptions.config as Record<string, unknown> | undefined);

    const preHandler = Array.isArray(routeOptions.preHandler)
      ? routeOptions.preHandler
      : routeOptions.preHandler
        ? [routeOptions.preHandler]
        : [];
    const gates: AuthzGateMeta[] = preHandler
      .flatMap((h) => (Array.isArray(h) ? h : [h]))
      .map((h) => gateMetaOf(h))
      .filter((g): g is AuthzGateMeta => g !== null);

    validateContract(method, url, contract, gates);

    inventory.set(keyOf(method, url), {
      method,
      url,
      kind: contract.kind,
      permission: contract.permission ?? null,
      devOnly: contract.devOnly === true,
      contract,
      gates,
    });
  });

  // Authoritative fail-closed gate: the application must not boot unless every
  // registered route passed full contract validation at startup time.
  app.addHook('onReady', async () => {
    if (inventory.size === 0) {
      throw new AppError('Authorization gate found no registered routes — refusing to boot');
    }
    for (const entry of inventory.values()) {
      validateContract(entry.method, entry.url, entry.contract, entry.gates);
    }
  });

  app.decorate('routeAuthorizationMatrix', () => {
    return {
      routes: [...inventory.values()]
        .sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : a.method.localeCompare(b.method)))
        .map((e) => ({
          method: e.method,
          url: e.url,
          kind: e.kind,
          permission: e.permission,
          devOnly: e.devOnly,
        })),
    };
  });
}

export { AUTHZ_GATE_META };