import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  memberships,
  roles,
  rolePermissions,
  membershipRoles,
  platformRoleAssignments,
  tenants,
  type Db,
  type Tx,
  withGuc,
} from '@sms/db';
import { HttpError, type RequestContext } from '@sms/core';

export { withTenant, withPlatform, withSystem } from '@sms/db';

/**
 * Mint an 'account' scope ticket mid-transaction (userId only, no tenant). Used by
 * pre-context flows (registration, login) after the user row already exists.
 */
export async function setAccountScope(tx: Tx, userId: string): Promise<void> {
  await tx.execute(sql`select app_ctx_mint('account', ${userId}, null)`);
}

/** Mint a 'tenant' scope ticket mid-transaction. Fails closed unless (userId, tenantId) is a real active membership. */
export async function setTenantScope(tx: Tx, userId: string, tenantId: string): Promise<void> {
  await tx.execute(sql`select app_ctx_mint('tenant', ${userId}, ${tenantId})`);
}

/** Mint a 'platform' scope ticket mid-transaction. Fails closed unless the user has a platform role assignment. */
export async function setPlatformScope(tx: Tx, userId: string): Promise<void> {
  await tx.execute(sql`select app_ctx_mint('platform', ${userId}, null)`);
}

export interface MembershipSummary {
  id: string;
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  tenantStatus: string;
  status: string;
  campusId: string | null;
  roles: { id: string; code: string; name: string; scope: string }[];
  permissions: string[];
}

export interface TenantSummaryRow {
  id: string;
  slug: string;
  name: string;
  status: string;
}

/**
 * Canonical tenant-context resolver. The ONLY place a tenant context is created
 * for authenticated users. Fails closed: missing/inactive membership => 403.
 */
export async function resolveTenantContext(
  db: Db,
  input: { userId: string; tenantId: string; requestId: string },
): Promise<RequestContext> {
  const { userId, tenantId, requestId } = input;
  const res = await withGuc(
    db,
    { userId, tenantId, platform: false },
    async (t) => {
      const memberRows = await t
        .select()
        .from(memberships)
        .where(and(eq(memberships.userId, userId), eq(memberships.tenantId, tenantId)))
        .execute();
      const member = memberRows[0];
      if (!member || member.status !== 'active') {
        throw new HttpError('Tenant access denied', {
          status: 403,
          code: 'forbidden',
        });
      }

      const links = await t
        .select()
        .from(membershipRoles)
        .where(eq(membershipRoles.membershipId, member.id))
        .execute();
      const roleIds = links.map((l) => l.roleId);
      const allPerms: string[] = [];
      if (roleIds.length > 0) {
        const rows = await t
          .select({ permission: rolePermissions.permission })
          .from(rolePermissions)
          .where(inArray(rolePermissions.roleId, roleIds))
          .execute();
        allPerms.push(...rows.map((r) => r.permission));
      }

      return { member, roleIds, permissions: new Set(allPerms) };
    },
  );

  return {
    requestId,
    userId,
    scope: 'tenant',
    tenantId,
    membershipId: res.member.id,
    campusId: res.member.campusId,
    roleIds: res.roleIds,
    permissions: res.permissions,
    platformAccess: false,
    isSystem: false,
  };
}

export async function loadPlatformContext(
  db: Db,
  input: { userId: string; requestId: string },
): Promise<RequestContext> {
  const { userId, requestId } = input;
  const res = await withGuc(db, { userId, platform: true }, async (t) => {
    const assigned = await t
      .select()
      .from(platformRoleAssignments)
      .where(eq(platformRoleAssignments.userId, userId))
      .execute();
    const roleIds = assigned.map((a) => a.roleId);
    const perms = new Set<string>();
    if (roleIds.length > 0) {
      const rows = await t
        .select({ permission: rolePermissions.permission })
        .from(rolePermissions)
        .where(inArray(rolePermissions.roleId, roleIds))
        .execute();
      rows.forEach((r) => perms.add(r.permission));
    }
    return { roleIds, perms };
  });
  return {
    requestId,
    userId,
    scope: 'platform',
    tenantId: null,
    membershipId: null,
    campusId: null,
    roleIds: res.roleIds,
    permissions: res.perms,
    platformAccess: true,
    isSystem: false,
  };
}

/** List the user's own memberships (used by /me/memberships and tenant switching). */
export async function listMemberships(db: Db, userId: string): Promise<MembershipSummary[]> {
  return withGuc(db, { userId }, async (t) => {
    const rows = await t
      .select({
        membership: memberships,
        tenant: tenants,
      })
      .from(memberships)
      .innerJoin(tenants, eq(memberships.tenantId, tenants.id))
      .where(eq(memberships.userId, userId))
      .execute();

    const summaries: MembershipSummary[] = [];
    for (const row of rows) {
      const links = await t
        .select()
        .from(membershipRoles)
        .where(eq(membershipRoles.membershipId, row.membership.id))
        .execute();
      const roleIds = links.map((l) => l.roleId);
      const roleRows =
        roleIds.length > 0
          ? await t
              .select({ id: roles.id, code: roles.code, name: roles.name, scope: roles.scope })
              .from(roles)
              .where(inArray(roles.id, roleIds))
              .execute()
          : [];
      const permRows =
        roleIds.length > 0
          ? await t
              .select({ permission: rolePermissions.permission })
              .from(rolePermissions)
              .where(inArray(rolePermissions.roleId, roleIds))
              .execute()
          : [];
      summaries.push({
        id: row.membership.id,
        tenantId: row.tenant.id,
        tenantName: row.tenant.name,
        tenantSlug: row.tenant.slug,
        tenantStatus: row.tenant.status,
        status: row.membership.status,
        campusId: row.membership.campusId,
        roles: roleRows,
        permissions: permRows.map((p) => p.permission),
      });
    }
    return summaries;
  });
}

/** Verify an active membership for a specific tenant (used by tenant switching). */
export async function findActiveMembership(
  db: Db,
  userId: string,
  tenantId: string,
): Promise<{ id: string; tenant: TenantSummaryRow } | null> {
  return withGuc(db, { userId }, async (t) => {
    const rows = await t
      .select({
        id: memberships.id,
        status: memberships.status,
        tenant: tenants,
      })
      .from(memberships)
      .innerJoin(tenants, eq(memberships.tenantId, tenants.id))
      .where(and(eq(memberships.userId, userId), eq(memberships.tenantId, tenantId)))
      .execute();
    const row = rows[0];
    if (!row || row.status !== 'active') return null;
    return { id: row.id, tenant: row.tenant };
  });
}