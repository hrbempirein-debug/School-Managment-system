import { AppError } from '@sms/core';

type Permission = string;

/** Single source of truth for authorization permission identifiers. */
export const PERMISSION_CATALOG: readonly Permission[] = Object.freeze([
  // Platform scope
  'platform.tenants.create',
  'platform.tenants.read',
  'platform.tenants.update',
  'platform.tenants.status_change',
  'platform.users.read',
  'platform.plans.manage',
  'platform.billing.read',
  'platform.audit.read',

  // Tenant scope
  'tenant.read',
  'tenant.update',
  'users.read',
  'users.create',
  'users.update',
  'memberships.read',
  'memberships.create',
  'memberships.update',
  'roles.read',
  'roles.create',
  'roles.update',
  'audit.read',
]);

export const PERMISSION_SET: ReadonlySet<Permission> = new Set(PERMISSION_CATALOG);

export type RoleScope = 'platform' | 'tenant';

export interface RoleTemplate {
  code: string;
  scope: RoleScope;
  name: string;
  description: string;
  permissions: readonly Permission[];
}

export const ROLE_TEMPLATES: readonly RoleTemplate[] = Object.freeze([
  {
    code: 'platform_admin',
    scope: 'platform',
    name: 'Platform Administrator',
    description: 'Full platform administration',
    permissions: PERMISSION_CATALOG.filter((p) => p.startsWith('platform.')),
  },
  {
    code: 'school_owner',
    scope: 'tenant',
    name: 'School Owner (Admin)',
    description: 'Full school administration',
    permissions: [
      'tenant.read',
      'tenant.update',
      'users.read',
      'users.create',
      'users.update',
      'memberships.read',
      'memberships.create',
      'memberships.update',
      'roles.read',
      'roles.create',
      'roles.update',
      'audit.read',
    ],
  },
  {
    code: 'principal',
    scope: 'tenant',
    name: 'Principal',
    description: 'School leadership, read-mostly',
    permissions: ['tenant.read', 'users.read', 'memberships.read', 'roles.read', 'audit.read'],
  },
  {
    code: 'teacher',
    scope: 'tenant',
    name: 'Teacher',
    description: 'Teaching staff',
    permissions: ['tenant.read', 'users.read'],
  },
  {
    code: 'accountant',
    scope: 'tenant',
    name: 'Accountant',
    description: 'Finance staff (finance module lands in a later phase)',
    permissions: ['tenant.read', 'users.read', 'audit.read'],
  },
  {
    code: 'parent',
    scope: 'tenant',
    name: 'Parent / Guardian',
    description: 'Parent portal',
    permissions: ['tenant.read'],
  },
  {
    code: 'student',
    scope: 'tenant',
    name: 'Student',
    description: 'Student portal',
    permissions: ['tenant.read'],
  },
]);

/**
 * Fail-fast validation of the permission registry. Invoked at application boot
 * so the process never starts with a broken authorization metadata model.
 */
export function assertCatalogConsistent(): void {
  const seen = new Set<string>();
  const dupes: string[] = [];
  for (const p of PERMISSION_CATALOG) {
    if (seen.has(p)) dupes.push(p);
    seen.add(p);
  }
  if (dupes.length > 0) {
    throw new AppError(`Duplicate permission identifiers in catalog: ${dupes.join(', ')}`);
  }
  if (!seen.has('audit.read')) {
    throw new AppError('audit.read is a required system permission');
  }
  for (const template of ROLE_TEMPLATES) {
    for (const p of template.permissions) {
      if (!seen.has(p)) {
        throw new AppError(
          `Role template "${template.code}" references unknown permission "${p}"`,
        );
      }
    }
    if (template.scope === 'platform' && template.permissions.some((p) => !p.startsWith('platform.'))) {
      throw new AppError(`Platform role "${template.code}" contains a tenant permission`);
    }
    if (template.scope === 'tenant' && template.permissions.some((p) => p.startsWith('platform.'))) {
      throw new AppError(`Tenant role "${template.code}" contains a platform permission`);
    }
  }
}

export function permissionForTemplate(templateCode: string): Permission[] {
  const t = ROLE_TEMPLATES.find((r) => r.code === templateCode);
  if (!t) throw new AppError(`Unknown role template: ${templateCode}`);
  return [...t.permissions];
}

export function isPlatformPermission(p: string): boolean {
  return p.startsWith('platform.');
}

export function isRegisteredPermission(p: string): boolean {
  return PERMISSION_SET.has(p);
}