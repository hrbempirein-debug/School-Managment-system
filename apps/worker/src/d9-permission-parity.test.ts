import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import {
  PERMISSION_CATALOG,
  ROLE_TEMPLATES,
  FEES_PERMISSIONS,
  type RoleTemplate,
} from '../../../packages/permissions/src/permissions.js';
import {
  roles,
  rolePermissions,
  memberships,
  membershipRoles,
  tenants,
  users,
  outboxEvents,
  auditLogs,
  createDb,
  withSystem,
  type Db,
} from '@sms/db';
import { createTenantTransaction } from '../../api/src/routes/tenants.js';

/**
 * Phase 8 D9 fresh-tenant bootstrap proof — EXACT permission parity, verified
 * against the REAL production bootstrap path (`createTenantTransaction` from the
 * platform tenants route), never a hand-rolled fixture.
 *
 * Two layers:
 *  (1) STATIC set algebra (no DB — always runs):
 *        catalog(120) == template-union(120)            — no orphan permission
 *        tenant-union(112) == catalog minus platform.*(8)
 *        the 25 `fees.*` are reachable from tenant templates
 *        ROLE_TEMPLATES' finance matrix == 0028 §20.5 backfill, row for row
 *  (2) LIVE (RUN_RUNTIME_SECURITY_TESTS=1): TWO disposable tenants are
 *        provisioned through the production bootstrap and the resulting DB
 *        `roles` + `role_permissions` are read back:
 *          - the seven tenant roles (incl. `cashier`) exist, system, tenant-scoped
 *          - per role, permissions equal ROLE_TEMPLATES exactly
 *          - the tenant union equals the authoritative tenant permission set
 *            (112) as an EXACT SET — missing/extra/duplicates/invalid reported
 *          - every one of the 25 `fees.*` is asserted individually
 *          - `cashier` holds exactly its three §20.5 permissions
 *          - no unrelated role receives a permission outside the §20.5 matrix
 *          - Tenant A and Tenant B share NO role row identity
 *          - every role row that existed BEFORE this suite ran is byte-identical
 *            afterwards (existing tenants are never rewritten)
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(HERE, '..', '..', '..', 'packages', 'db', 'migrations');

const cat = [...PERMISSION_CATALOG];
const catSet = new Set(cat);
const tplUnion = new Set(ROLE_TEMPLATES.flatMap((t) => t.permissions));
const tenantTemplates = ROLE_TEMPLATES.filter(
  (t): t is RoleTemplate & { scope: 'tenant' } => t.scope === 'tenant',
);
const platformTemplates = ROLE_TEMPLATES.filter(
  (t): t is RoleTemplate & { scope: 'platform' } => t.scope === 'platform',
);
const tenantUnion = new Set(tenantTemplates.flatMap((t) => t.permissions));

/** The 25 Phase 7 finance permissions, taken from the canonical catalog. */
const FEES: readonly string[] = Object.freeze([...FEES_PERMISSIONS]);
const FEES_SET = new Set(FEES);

/** Authoritative tenant-scoped permission set = catalog minus the platform namespace. */
const EXPECTED_TENANT_PERMISSIONS = new Set(
  cat.filter((p) => !p.startsWith('platform.')),
);

/** Role codes `createTenantTransaction` must seed, in template order. */
const EXPECTED_TENANT_ROLE_CODES = [
  'school_owner',
  'principal',
  'teacher',
  'accountant',
  'cashier',
  'parent',
  'student',
].sort();

/** Human-readable set diff for failure messages. */
function diff(label: string, values: Iterable<string>): string {
  const arr = [...values].sort();
  return arr.length === 0 ? `  ${label}: (none)\n` : `  ${label} (${arr.length}):\n${arr.map((v) => `    ${v}\n`).join('')}`;
}

function parityReport(missing: Set<string>, extra: Set<string>, duplicates: string[], invalid: string[]): string {
  return (
    'Fresh tenant permission parity FAILED\n' +
    diff('missing', missing) +
    diff('extra', extra) +
    diff('duplicates', duplicates) +
    diff('invalid', invalid)
  );
}

/** Extract the catalog-permission literals declared by the migration files (any context). */
async function migrationDeclaredPermissions(): Promise<Set<string>> {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  const out = new Set<string>();
  const re = /['"]([a-z_]+(?:\.[a-z_]+)+)['"]/g;
  for (const f of files) {
    const s = await readFile(path.join(MIGRATIONS_DIR, f), 'utf8');
    let m: RegExpExecArray | null;
    while ((m = re.exec(s)) !== null) {
      if (catSet.has(m[1]!)) out.add(m[1]!);
    }
  }
  return out;
}

/**
 * Parse the immutable `0028` §20.5 backfill into its (role, permission) rows.
 * This is the migration's own statement of the Phase 7 finance matrix; the
 * template must reproduce it exactly rather than invent a second matrix.
 */
async function migrationFinanceMatrix(): Promise<Map<string, Set<string>>> {
  const sql = await readFile(
    path.join(MIGRATIONS_DIR, '0028_phase7_finance_security.sql'),
    'utf8',
  );
  const section = sql.slice(sql.indexOf('13. §20.5 fees.* permission backfill'));
  const out = new Map<string, Set<string>>();
  const add = (role: string, permission: string): void => {
    const set = out.get(role) ?? new Set<string>();
    set.add(permission);
    out.set(role, set);
  };

  // (a) JOIN (VALUES ('role','perm'), ...) form — school_owner / accountant / cashier.
  const tuple = /\('([a-z_]+)', '(fees\.[a-z_.]+)'\)/g;
  let m: RegExpExecArray | null;
  while ((m = tuple.exec(section)) !== null) add(m[1]!, m[2]!);

  // (b) `SELECT r.id, 'perm' ... WHERE r.code = 'role'` form — principal.
  const single = /SELECT r\.id, '(fees\.[a-z_.]+)'\s+FROM roles r\s+WHERE r\.code = '([a-z_]+)'/g;
  while ((m = single.exec(section)) !== null) add(m[2]!, m[1]!);

  // (c) `SELECT r.id, 'perm' ... WHERE r.code IN ('a', 'b')` form — parent/student.
  const multi = /SELECT r\.id, '(fees\.[a-z_.]+)'\s+FROM roles r\s+WHERE r\.code IN \(([^)]+)\)/g;
  while ((m = multi.exec(section)) !== null) {
    for (const role of m[2]!.matchAll(/'([a-z_]+)'/g)) add(role[1]!, m[1]!);
  }
  return out;
}

// ---------------------------------------------------------------- static ---

describe('D9 permission parity — STATIC set algebra (no DB required)', () => {
  it('catalog is exactly 120 unique permissions; every template permission resolves', () => {
    expect(cat).toHaveLength(120);
    expect(new Set(cat)).toHaveLength(120);
    for (const t of ROLE_TEMPLATES) {
      for (const p of t.permissions) expect(catSet.has(p)).toBe(true);
    }
  });

  it('template union == the whole catalog (no permission is granted by no template)', () => {
    expect(tplUnion.size).toBe(120);
    expect([...catSet].filter((p) => !tplUnion.has(p))).toEqual([]);
  });

  it('tenant template union is exactly the 112 tenant-scoped catalog permissions', () => {
    expect(tenantUnion.size).toBe(112);
    expect(tenantUnion).toEqual(EXPECTED_TENANT_PERMISSIONS);
    const platformUnion = new Set(platformTemplates.flatMap((t) => t.permissions));
    expect(platformUnion.size).toBe(8);
    for (const t of tenantTemplates) {
      expect(t.permissions.some((p) => p.startsWith('platform.'))).toBe(false);
    }
    for (const t of platformTemplates) {
      expect(t.permissions.every((p) => p.startsWith('platform.'))).toBe(true);
    }
  });

  it('tenant role codes are exactly the seven templates createTenantTransaction seeds', () => {
    expect(tenantTemplates.map((t) => t.code).sort()).toEqual(EXPECTED_TENANT_ROLE_CODES);
  });

  it('the catalog owns EXACTLY the 25 fees.* and every one is reachable from a tenant template', () => {
    const catalogFees = cat.filter((p) => p.startsWith('fees.'));
    expect(catalogFees).toHaveLength(25);
    expect(new Set(catalogFees)).toEqual(FEES_SET);
    // D9: this is the assertion that failed before remediation — every finance
    // permission must be reachable from at least one tenant role template.
    const unreachable = catalogFees.filter((p) => !tenantUnion.has(p));
    expect(unreachable, `fees.* granted by no tenant template: ${unreachable.join(', ')}`).toEqual([]);
  });

  it('template permissions are all declared in the catalog (no template-only drift)', () => {
    expect([...tplUnion].filter((p) => !catSet.has(p))).toEqual([]);
  });

  it('migration-declared permissions: exactly 77, all catalog-valid', async () => {
    const mig = await migrationDeclaredPermissions();
    expect(mig.size).toBe(77);
    expect([...mig].filter((p) => !catSet.has(p))).toEqual([]);
  });

  it('catalog == template-union ∪ migration-declared (120, zero unexplained gap)', async () => {
    const mig = await migrationDeclaredPermissions();
    const union = new Set([...tplUnion, ...mig]);
    expect(union.size).toBe(120);
    expect(union).toEqual(catSet);
  });

  it("ROLE_TEMPLATES' finance matrix reproduces the immutable 0028 §20.5 backfill row for row", async () => {
    const migrationMatrix = await migrationFinanceMatrix();
    // 25 (school_owner) + 22 (accountant) + 3 (cashier) + 1 (principal) + 1 (parent) + 1 (student)
    let migrationRows = 0;
    for (const set of migrationMatrix.values()) migrationRows += set.size;
    expect(migrationRows).toBe(53);

    for (const [role, expected] of migrationMatrix) {
      const template = tenantTemplates.find((t) => t.code === role);
      expect(template, `role template for migration role '${role}'`).toBeDefined();
      const actual = new Set(template!.permissions.filter((p) => p.startsWith('fees.')));
      const missing = [...expected].filter((p) => !actual.has(p));
      const extra = [...actual].filter((p) => !expected.has(p));
      expect(missing, `template '${role}' missing §20.5 grants: ${missing.join(', ')}`).toEqual([]);
      expect(extra, `template '${role}' has grants §20.5 never made: ${extra.join(', ')}`).toEqual([]);
    }
    // And the inverse: no tenant template invents a finance grant §20.5 omits.
    for (const t of tenantTemplates) {
      const expected = migrationMatrix.get(t.code) ?? new Set<string>();
      const extra = t.permissions.filter((p) => p.startsWith('fees.') && !expected.has(p));
      expect(extra, `template '${t.code}' grants fees.* beyond §20.5: ${extra.join(', ')}`).toEqual([]);
    }
  });
});

// ----------------------------------------------------------------- live ---

const LIVE = process.env.RUN_RUNTIME_SECURITY_TESTS === '1';

interface RoleRow {
  id: string;
  code: string;
  tenantId: string | null;
  scope: string;
  isSystem: boolean;
}
interface PermRow {
  roleId: string;
  permission: string;
}
interface Snapshot {
  roles: RoleRow[];
  perRole: Map<string, string[]>;
}

function byRole(perms: PermRow[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const p of perms) {
    const arr = out.get(p.roleId) ?? [];
    arr.push(p.permission);
    out.set(p.roleId, arr);
  }
  return out;
}

describe.skipIf(!LIVE)('D9 permission parity — LIVE bootstrap via the production createTenantTransaction', () => {
  let db!: Db;
  const tenantsToClean: string[] = [];
  const usersToClean: string[] = [];

  /** Full `roles`/`role_permissions` dump of the WHOLE database, keyed for stable comparison. */
  const dumpAuthorizationState = async (): Promise<string[]> =>
    withSystem(db, async (tx) => {
      const roleRows = await tx
        .select({
          id: roles.id,
          tenantId: roles.tenantId,
          scope: roles.scope,
          code: roles.code,
          name: roles.name,
          description: roles.description,
          isSystem: roles.isSystem,
        })
        .from(roles)
        .execute();
      const permRows = await tx
        .select({ roleId: rolePermissions.roleId, permission: rolePermissions.permission })
        .from(rolePermissions)
        .execute();
      const roleLines = roleRows
        .map(
          (r) =>
            `role|${r.id}|${r.tenantId ?? '-'}|${r.scope}|${r.code}|${r.name}|${r.description ?? '-'}|${r.isSystem}`,
        )
        .sort();
      const permLines = permRows.map((p) => `perm|${p.roleId}|${p.permission}`).sort();
      return [...roleLines, ...permLines];
    });

  const provision = async (slug: string, name: string): Promise<string> => {
    const userId = randomUUID();
    await withSystem(db, async (tx) => {
      await tx.insert(users).values({ id: userId, email: `${slug}@d9.invalid`, status: 'active' });
    });
    usersToClean.push(userId);
    const created = await withSystem(db, (tx) =>
      createTenantTransaction(tx, { userId }, { slug, name, requestId: randomUUID() }),
    );
    tenantsToClean.push(created.tenantId);
    return created.tenantId;
  };

  let baselineState: string[] = [];
  let tenantA = '';
  let tenantB = '';

  beforeAll(async () => {
    db = createDb({ url: process.env.DATABASE_URL_MIGRATOR!, max: 2 }).db;
    // BEFORE provisioning: capture every existing authorization row so the
    // "existing tenants unchanged" claim is a before/after diff, not an assertion.
    baselineState = await dumpAuthorizationState();
    const stamp = Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
    tenantA = await provision(`d9a-${stamp}`, 'D9 Tenant A');
    tenantB = await provision(`d9b-${stamp}`, 'D9 Tenant B');
  }, 60_000);

  afterAll(async () => {
    if (!db || tenantsToClean.length === 0) return;
    // Privileged-path cleanup, FK order: children → parents.
    await withSystem(db, async (tx) => {
      for (const tenantId of tenantsToClean) {
        const mrows = await tx
          .select({ id: memberships.id })
          .from(memberships)
          .where(eq(memberships.tenantId, tenantId))
          .execute();
        const memberIds = mrows.map((m) => m.id);
        const roleRows = await tx
          .select({ id: roles.id, code: roles.code })
          .from(roles)
          .where(eq(roles.tenantId, tenantId))
          .execute();
        const roleIds = roleRows.map((r) => r.id);
        if (memberIds.length > 0) {
          await tx.delete(membershipRoles).where(inArray(membershipRoles.membershipId, memberIds));
        }
        if (roleIds.length > 0) {
          await tx.delete(rolePermissions).where(inArray(rolePermissions.roleId, roleIds));
          await tx.delete(roles).where(inArray(roles.id, roleIds));
        }
        await tx.delete(memberships).where(inArray(memberships.id, memberIds));
        await tx.delete(outboxEvents).where(eq(outboxEvents.tenantId, tenantId));
        await tx.delete(auditLogs).where(eq(auditLogs.tenantId, tenantId));
        await tx.delete(tenants).where(eq(tenants.id, tenantId));
      }
      if (usersToClean.length > 0) {
        await tx.delete(users).where(inArray(users.id, usersToClean));
      }
    });
  }, 60_000);

  const snapshot = async (tenantId: string): Promise<Snapshot> =>
    withSystem(db, async (tx) => {
      const roleRows = (await tx
        .select({
          id: roles.id,
          code: roles.code,
          tenantId: roles.tenantId,
          scope: roles.scope,
          isSystem: roles.isSystem,
        })
        .from(roles)
        .where(eq(roles.tenantId, tenantId))
        .execute()) as RoleRow[];
      const permRows =
        roleRows.length > 0
          ? await tx
              .select({ roleId: rolePermissions.roleId, permission: rolePermissions.permission })
              .from(rolePermissions)
              .where(inArray(rolePermissions.roleId, roleRows.map((r) => r.id)))
              .execute()
          : [];
      return { roles: roleRows, perRole: byRole(permRows) };
    });

  const templateByCode = new Map(tenantTemplates.map((t) => [t.code, t]));

  it('role set: BOTH fresh tenants bootstrap exactly the seven tenant roles incl. cashier', async () => {
    for (const tenantId of [tenantA, tenantB]) {
      const snap = await snapshot(tenantId);
      const codes = snap.roles.map((r) => r.code).sort();
      expect(codes).toEqual(EXPECTED_TENANT_ROLE_CODES);
      for (const role of snap.roles) {
        expect(role.scope).toBe('tenant');
        expect(role.tenantId).toBe(tenantId);
        expect(role.isSystem).toBe(true);
      }
      // cashier is created but deliberately UNASSIGNED (no membership holds it yet).
      const cashier = snap.roles.find((r) => r.code === 'cashier');
      expect(cashier, 'cashier role must exist on a fresh tenant').toBeDefined();
    }
  });

  it('cashier: exists and holds EXACTLY the three §20.5 permissions (never fees.receipts.reissue)', async () => {
    const expected = ['fees.payments.collect', 'fees.payments.read', 'fees.receipts.read'];
    for (const tenantId of [tenantA, tenantB]) {
      const snap = await snapshot(tenantId);
      const cashier = snap.roles.find((r) => r.code === 'cashier')!;
      const actual = [...(snap.perRole.get(cashier.id) ?? [])].sort();
      expect(actual, `cashier permissions for tenant ${tenantId}`).toEqual(expected);
      expect(actual).not.toContain('fees.receipts.reissue');
    }
  });

  it('permission set: per-role role_permissions EXACTLY equal the ROLE_TEMPLATES', async () => {
    for (const tenantId of [tenantA, tenantB]) {
      const snap = await snapshot(tenantId);
      for (const role of snap.roles) {
        const template = templateByCode.get(role.code);
        expect(template, `template for ${role.code}`).toBeDefined();
        expect([...(snap.perRole.get(role.id) ?? [])].sort()).toEqual([...template!.permissions].sort());
      }
      expect(snap.roles.length).toBe(tenantTemplates.length);
    }
  });

  it('permission set: the fresh-tenant union equals the authoritative tenant permission set EXACTLY', async () => {
    for (const tenantId of [tenantA, tenantB]) {
      const snap = await snapshot(tenantId);
      const actual = new Set([...snap.perRole.values()].flat());
      const missing = new Set([...EXPECTED_TENANT_PERMISSIONS].filter((p) => !actual.has(p)));
      const extra = new Set([...actual].filter((p) => !EXPECTED_TENANT_PERMISSIONS.has(p)));
      const invalid = [...actual].filter((p) => !catSet.has(p) || p.startsWith('platform.'));
      // Duplicates are only meaningful per role — the same permission legitimately
      // appears under many roles. `role_permissions_pk` already forbids them.
      const duplicates: string[] = [];
      for (const [roleId, perms] of snap.perRole) {
        if (new Set(perms).size !== perms.length) duplicates.push(roleId);
      }
      if (missing.size || extra.size || invalid.length || duplicates.length) {
        throw new Error(
          parityReport(missing, extra, duplicates, invalid) +
            `  expected count: ${EXPECTED_TENANT_PERMISSIONS.size}\n  actual count:   ${actual.size}\n`,
        );
      }
      expect(actual.size).toBe(112);
    }
  });

  it('25 fees.*: EVERY Phase 7 finance permission is individually present on a fresh tenant', async () => {
    expect(FEES).toHaveLength(25);
    // Guard against the expected set itself drifting away from the catalog.
    expect(new Set(FEES)).toEqual(
      new Set(PERMISSION_CATALOG.filter((p) => p.startsWith('fees.'))),
    );
    for (const tenantId of [tenantA, tenantB]) {
      const snap = await snapshot(tenantId);
      const actual = new Set([...snap.perRole.values()].flat());
      const missing = FEES.filter((p) => !actual.has(p));
      if (missing.length > 0) {
        throw new Error(
          'Fresh tenant permission parity FAILED\n' + diff('missing fees.*', missing),
        );
      }
      for (const p of FEES) expect(actual.has(p), `expected permission ${p}`).toBe(true);
      // Including the refund namespace explicitly, per the Phase 7 contract.
      for (const p of ['fees.refunds.request', 'fees.refunds.read', 'fees.refunds.approve', 'fees.refunds.process']) {
        expect(actual.has(p), `refund permission ${p}`).toBe(true);
      }
    }
  });

  it('§20.5 matrix: no role outside {school_owner, accountant, cashier} holds a collection permission', async () => {
    const collectionRoles = ['school_owner', 'accountant', 'cashier'].sort();
    const holdersOf = (permission: string, snap: Snapshot): string[] =>
      snap.roles
        .filter((r) => (snap.perRole.get(r.id) ?? []).includes(permission))
        .map((r) => r.code)
        .sort();

    for (const tenantId of [tenantA, tenantB]) {
      const snap = await snapshot(tenantId);
      for (const p of ['fees.payments.read', 'fees.payments.collect', 'fees.receipts.read']) {
        expect(holdersOf(p, snap), `holders of ${p}`).toEqual(collectionRoles);
      }
      // Roles with NO finance write authority never receive one.
      for (const code of ['teacher', 'parent', 'student']) {
        const role = snap.roles.find((r) => r.code === code)!;
        const perms = snap.perRole.get(role.id) ?? [];
        expect(perms.filter((p) => p.startsWith('fees.')), `${code} finance grants`).toEqual(
          code === 'teacher' ? [] : ['fees.portal.read'],
        );
      }
      // Read-mostly leadership: EXACTLY one finance permission, and it is a read.
      const principal = snap.roles.find((r) => r.code === 'principal')!;
      expect([...(snap.perRole.get(principal.id) ?? [])].filter((p) => p.startsWith('fees.'))).toEqual([
        'fees.reports.read',
      ]);
      // The owner is the only role that holds the authoring capability.
      expect(holdersOf('fees.structures.manage', snap)).toEqual(['school_owner']);
      expect(holdersOf('fees.assignments.manage', snap)).toEqual(['school_owner']);
      expect(holdersOf('fees.portal.read', snap)).toEqual(['parent', 'school_owner', 'student']);
      expect(holdersOf('fees.receipts.reissue', snap)).toEqual(['accountant', 'school_owner']);
    }
  });

  it('cross-tenant: Tenant A and Tenant B share NO role row identity and no permission row leaks', async () => {
    const [snapA, snapB] = [await snapshot(tenantA), await snapshot(tenantB)];
    const idsA = new Set(snapA.roles.map((r) => r.id));
    const idsB = new Set(snapB.roles.map((r) => r.id));
    for (const id of idsA) expect(idsB.has(id), `role ${id} shared across tenants`).toBe(false);
    for (const id of idsB) expect(idsA.has(id), `role ${id} shared across tenants`).toBe(false);
    // Every permission row hangs off a role, and every role is tenant-bound.
    for (const r of snapA.roles) expect(r.tenantId).toBe(tenantA);
    for (const r of snapB.roles) expect(r.tenantId).toBe(tenantB);
    // The two tenants nevertheless receive IDENTICAL capability by code.
    for (const t of tenantTemplates) {
      const a = snapA.perRole.get(snapA.roles.find((r) => r.code === t.code)!.id) ?? [];
      const b = snapB.perRole.get(snapB.roles.find((r) => r.code === t.code)!.id) ?? [];
      expect([...a].sort()).toEqual([...b].sort());
    }
  });

  it('existing tenants: every authorization row that existed before this suite is byte-identical after', async () => {
    const afterState = await dumpAuthorizationState();
    const afterSet = new Set(afterState);
    const lostOrChanged = baselineState.filter((line) => !afterSet.has(line));
    expect(
      lostOrChanged,
      `pre-existing authorization rows changed/removed:\n${lostOrChanged.join('\n')}`,
    ).toEqual([]);
    // And no NEW row was written for a tenant that is not one of ours.
    const ours = new Set(tenantsToClean);
    const added = afterState.filter((line) => !baselineState.includes(line));
    const foreignAdds = added.filter((line) => {
      const roleTenant = line.startsWith('role|') ? (line.split('|')[2] ?? '-') : null;
      if (roleTenant !== null) return !ours.has(roleTenant);
      // permission rows belong to a role; resolve the role's tenant.
      const roleId = line.split('|')[1] ?? '';
      const roleLine = afterState.find((l) => l.startsWith(`role|${roleId}|`));
      const t = roleLine ? (roleLine.split('|')[2] ?? '-') : '';
      return !ours.has(t);
    });
    expect(foreignAdds, `rows added to pre-existing tenants:\n${foreignAdds.join('\n')}`).toEqual([]);
    expect(added.length).toBeGreaterThan(0);
  });

  it('existing-tenant fixture: a legacy (pre-Phase-7) tenant configuration is left untouched', async () => {
    // A tenant provisioned BEFORE the fix looks like this: six roles, the
    // 87-permission union, no cashier and no fees.*. It must be inert to the fix.
    const legacyTenant = randomUUID();
    const legacyUser = randomUUID();
    await withSystem(db, async (tx) => {
      await tx.insert(users).values({ id: legacyUser, email: `legacy-${legacyTenant}@d9.invalid`, status: 'active' });
      await tx.insert(tenants).values({ id: legacyTenant, slug: `legacy-${legacyTenant.slice(0, 8)}`, name: 'Legacy Tenant' });
      const legacyRoleIds: string[] = [];
      for (const template of tenantTemplates.filter((t) => t.code !== 'cashier')) {
        const [row] = await tx
          .insert(roles)
          .values({
            tenantId: legacyTenant,
            scope: 'tenant',
            code: template.code,
            name: template.name,
            description: template.description,
            isSystem: true,
          })
          .returning({ id: roles.id });
        legacyRoleIds.push(row!.id);
        const legacyPerms = template.permissions.filter((p) => !p.startsWith('fees.'));
        for (const permission of legacyPerms) {
          await tx.insert(rolePermissions).values({ roleId: row!.id, permission });
        }
      }
      expect(legacyRoleIds).toHaveLength(6);
    });

    const readLegacy = async (): Promise<string[]> =>
      withSystem(db, async (tx) => {
        const ids = (
          await tx.select({ id: roles.id }).from(roles).where(eq(roles.tenantId, legacyTenant)).execute()
        ).map((r) => r.id);
        const perms = await tx
          .select({ roleId: rolePermissions.roleId, permission: rolePermissions.permission })
          .from(rolePermissions)
          .where(inArray(rolePermissions.roleId, ids))
          .execute();
        return perms.map((p) => `${p.roleId}|${p.permission}`).sort();
      });

    const before = await readLegacy();
    // A pre-Phase-8 tenant: 6 roles (no cashier), 150 permission ROWS whose
    // unique union is the documented legacy 87 — zero `fees.*`.
    expect(before.length).toBe(150);
    expect(new Set(before.map((l) => l.split('|')[1])).size).toBe(87);
    expect(before.some((l) => l.split('|')[1]!.startsWith('fees.'))).toBe(false);

    // Provision ANOTHER fresh tenant through production after the legacy fixture exists.
    const stamp = Date.now().toString(36);
    await provision(`d9c-${stamp}`, 'D9 Tenant C');

    expect(await readLegacy()).toEqual(before);

    await withSystem(db, async (tx) => {
      await tx.delete(rolePermissions).where(
        inArray(
          rolePermissions.roleId,
          (await tx.select({ id: roles.id }).from(roles).where(eq(roles.tenantId, legacyTenant)).execute()).map(
            (r) => r.id,
          ),
        ),
      );
      await tx.delete(roles).where(eq(roles.tenantId, legacyTenant));
      await tx.delete(tenants).where(eq(tenants.id, legacyTenant));
      await tx.delete(users).where(eq(users.id, legacyUser));
    });
  }, 60_000);
});
