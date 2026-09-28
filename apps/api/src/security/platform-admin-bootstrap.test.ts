import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { createDb, users, userProfiles, authIdentities, roles, rolePermissions, platformRoleAssignments, auditLogs } from '@sms/db';
import { verifyPassword } from '@sms/auth';
import { PERMISSION_CATALOG, ROLE_TEMPLATES } from '@sms/permissions';
import { resolveRuntimeDatabaseUrls } from '@sms/db/src/testing/runtime-db.js';
import {
  bootstrapPlatformAdmin,
  bootstrapPlatformAdminFromEnv,
  normalizeCredentials,
  formatBootstrapReport,
  PLATFORM_ADMIN_ROLE_CODE,
} from '../cli/bootstrap-platform-admin.js';

/**
 * The platform-administrator bootstrap, against a real disposable database.
 *
 * The properties under test are the ones an operator cannot see in a code review of
 * the happy path:
 *
 *   1. it REFUSES rather than inventing an account when credentials are absent;
 *   2. it is IDEMPOTENT - a second run converges and, critically, does NOT rotate the
 *      password of the account it finds;
 *   3. it grants the permissions the `platform_admin` TEMPLATE declares, resolved from
 *      `@sms/permissions` rather than restated here;
 *   4. it writes an audit record and never writes the password or its hash anywhere;
 *   5. it leaves the database untouched when it refuses.
 *
 * Opt-in with RUN_RUNTIME_SECURITY_TESTS=1, and it uses DATABASE_URL_TEST (the
 * disposable database), never the development or production one.
 */

const enabled = process.env.RUN_RUNTIME_SECURITY_TESTS === '1';
const describeDb = enabled ? describe : describe.skip;

const PASSWORD = 'bootstrap-admin-password-1';

describeDb('platform administrator bootstrap (real DB)', () => {
  const slug = randomUUID().slice(0, 8);
  const email = `bootstrap-admin-${slug}@example.com`;
  const otherEmail = `bootstrap-admin-2-${slug}@example.com`;
  let url: string;
  let db: ReturnType<typeof createDb>['db'];
  let pool: ReturnType<typeof createDb>['pool'];
  /** Tenant count before any bootstrap call, so "creates no tenant" is a real
   * before/after comparison rather than an assumption. */
  let tenantsBefore = 0;

  beforeAll(async () => {
    // The bootstrap writes PLATFORM-scope rows with no RLS ticket, which is precisely
    // the work the runtime role must never do. So this suite needs the MIGRATOR
    // credentials aimed at the disposable database - not `DATABASE_URL_TEST`, which is
    // the app role and is (correctly) refused by RLS here.
    //
    // `resolveRuntimeDatabaseUrls` also asserts the target is a disposable `_test`
    // database and refuses to fall back to the development URL.
    const urls = resolveRuntimeDatabaseUrls();
    url = urls.migratorUrl;
    const created = createDb({ url });
    db = created.db;
    pool = created.pool;
    tenantsBefore = (await pool.query(`select count(*)::int as n from tenants`)).rows[0].n;
  });

  /** True when the shared `platform_admin` role already exists. Suites run serially
   * against one disposable database and other suites provision this role too, so the
   * bootstrap's role action is observed rather than assumed. */
  const platformAdminRoleExists = async (): Promise<boolean> => {
    const r = await pool.query(`select 1 from roles where scope = 'platform' and code = $1`, [
      PLATFORM_ADMIN_ROLE_CODE,
    ]);
    return r.rowCount === 1;
  };

  afterAll(async () => {
    if (pool) await pool.end();
  });

  const countRows = async (table: string, where: string, value: string): Promise<number> => {
    const res = await pool.query(`select count(*)::int as n from ${table} where ${where} = $1`, [value]);
    return res.rows[0]?.n ?? 0;
  };

  // ------------------------------------------------------------- 1. refusal
  describe('refuses rather than inventing an account', () => {
    it('rejects a missing email, naming the variable and no value', () => {
      expect(() => normalizeCredentials({ password: PASSWORD })).toThrow(/PLATFORM_ADMIN_EMAIL is not set/);
    });

    it('rejects a missing password, naming the variable and no value', () => {
      expect(() => normalizeCredentials({ email })).toThrow(/PLATFORM_ADMIN_PASSWORD is not set/);
    });

    it('rejects a password below the configured 12-character floor', () => {
      expect(() => normalizeCredentials({ email, password: 'short' })).toThrow(/at least 12 characters/);
    });

    it('rejects a malformed email', () => {
      expect(() => normalizeCredentials({ email: 'not-an-email', password: PASSWORD })).toThrow(
        /not a valid email/,
      );
    });

    it('normalizes the address the way the login lookup keys on it', () => {
      expect(normalizeCredentials({ email: '  MiXeD@Example.COM ', password: PASSWORD }).email).toBe(
        'mixed@example.com',
      );
    });

    it('never echoes a supplied secret in the error text', () => {
      let message = '';
      try {
        normalizeCredentials({ email, password: 'tooshort-secret-value' });
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      expect(message).not.toContain('tooshort-secret-value');
    });

    it('refuses without a migrator URL, and writes nothing', async () => {
      await expect(
        bootstrapPlatformAdminFromEnv({ PLATFORM_ADMIN_EMAIL: email, PLATFORM_ADMIN_PASSWORD: PASSWORD }),
      ).rejects.toThrow(/DATABASE_URL_MIGRATOR is not set/);
      expect(await countRows('users', 'email', email)).toBe(0);
    });
  });

  // ------------------------------------------------------------ 2. creation
  describe('creates a usable, audited, all-or-nothing administrator', () => {
    it('creates the user, profile, password identity, role, permissions and assignment', async () => {
      const roleExisted = await platformAdminRoleExists();
      const result = await bootstrapPlatformAdmin(url, { email, password: PASSWORD });

      expect(result.email).toBe(email);
      expect(result.actions).toContain('user_created');
      // Observed, not assumed: another suite may already have provisioned the shared
      // platform_admin role in this disposable database.
      expect(result.actions).toContain(roleExisted ? 'role_exists' : 'role_created');
      expect(result.actions).toContain('assigned');
      expect(result.passwordUntouched).toBe(false);
      expect(await platformAdminRoleExists()).toBe(true);

      expect(await countRows('users', 'email', email)).toBe(1);
      expect(await countRows('user_profiles', 'user_id', result.userId)).toBe(1);

      // The identity must be reachable by the LOGIN path: provider 'password' and a
      // provider_key equal to the normalized address.
      const identity = await pool.query(
        `select provider, provider_key, password_hash from auth_identities where user_id = $1`,
        [result.userId],
      );
      expect(identity.rows[0].provider).toBe('password');
      expect(identity.rows[0].provider_key).toBe(email);
      // And the stored hash must actually verify the supplied password.
      expect(await verifyPassword(identity.rows[0].password_hash, PASSWORD)).toBe(true);

      const assignment = await pool.query(
        `select 1 from platform_role_assignments where user_id = $1 and role_id = $2`,
        [result.userId, result.roleId],
      );
      expect(assignment.rowCount).toBe(1);
    });

    it('grants exactly the platform_admin TEMPLATE permissions, resolved not restated', async () => {
      const template = ROLE_TEMPLATES.find((t) => t.code === PLATFORM_ADMIN_ROLE_CODE)!;
      const role = await pool.query(`select id from roles where scope = 'platform' and code = $1`, [
        PLATFORM_ADMIN_ROLE_CODE,
      ]);
      const roleId = role.rows[0].id as string;

      const granted = await pool.query(`select permission from role_permissions where role_id = $1`, [
        roleId,
      ]);
      const have = granted.rows.map((r) => r.permission as string).sort();
      expect(have).toEqual([...template.permissions].sort());

      // And the template itself may not contain a non-platform permission, which would
      // mean the bootstrap had granted cross-scope reach.
      for (const p of have) {
        expect(PERMISSION_CATALOG).toContain(p);
        expect(p.startsWith('platform.')).toBe(true);
      }
    });

    it('writes one system-actor audit record and stores no secret in it', async () => {
      const user = await pool.query(`select id from users where email = $1`, [email]);
      const userId = user.rows[0].id as string;

      const audit = await pool.query(
        `select scope, actor_type, action, resource_id, new_value from audit_logs where action = $1`,
        ['platform.admin_bootstrap'],
      );
      const mine = audit.rows.filter((r) => r.resource_id === userId);
      expect(mine.length).toBeGreaterThanOrEqual(1);
      expect(mine[0].scope).toBe('platform');
      // A system action, not a user impersonating one.
      expect(mine[0].actor_type).toBe('system');

      const serialized = JSON.stringify(mine);
      expect(serialized).not.toContain(PASSWORD);
      // The Argon2 hash must not be in the audit trail either.
      const hash = await pool.query(`select password_hash from auth_identities where user_id = $1`, [
        userId,
      ]);
      expect(serialized).not.toContain(hash.rows[0].password_hash as string);
    });

    it('prints no secret material in its operator report', async () => {
      const result = await bootstrapPlatformAdmin(url, { email: otherEmail, password: PASSWORD });
      const report = formatBootstrapReport(result);
      expect(report).not.toContain(PASSWORD);
      expect(report).toContain(otherEmail);
    });
  });

  // ---------------------------------------------------------- 3. idempotency
  describe('is idempotent and never rotates a live credential', () => {
    it('a second run converges without creating a duplicate', async () => {
      const before = {
        users: await countRows('users', 'email', email),
        assignments: await countRows('platform_role_assignments', 'user_id', (
          await pool.query(`select id from users where email = $1`, [email])
        ).rows[0].id),
      };

      const result = await bootstrapPlatformAdmin(url, { email, password: 'a-completely-different-password' });

      expect(result.actions).toContain('user_exists');
      expect(result.actions).toContain('already_assigned');
      expect(result.actions).not.toContain('user_created');
      // The decisive assertion: an existing account's password is NOT reset, even
      // though a different password was supplied.
      expect(result.passwordUntouched).toBe(true);

      expect(await countRows('users', 'email', email)).toBe(before.users);
      const userId = (await pool.query(`select id from users where email = $1`, [email])).rows[0].id;
      expect(await countRows('platform_role_assignments', 'user_id', userId)).toBe(before.assignments);

      const identity = await pool.query(`select password_hash from auth_identities where user_id = $1`, [
        userId,
      ]);
      expect(await verifyPassword(identity.rows[0].password_hash, PASSWORD)).toBe(true);
      expect(await verifyPassword(identity.rows[0].password_hash, 'a-completely-different-password')).toBe(
        false,
      );
    });

    it('re-adding a missing permission converges instead of failing on a duplicate', async () => {
      const role = await pool.query(`select id from roles where scope = 'platform' and code = $1`, [
        PLATFORM_ADMIN_ROLE_CODE,
      ]);
      const roleId = role.rows[0].id as string;

      // Simulate drift: the role loses a permission the template declares.
      await pool.query(`delete from role_permissions where role_id = $1 and permission = $2`, [
        roleId,
        'platform.audit.read',
      ]);

      const result = await bootstrapPlatformAdmin(url, { email, password: PASSWORD });
      expect(result.actions).toContain('permissions_added');

      const granted = await pool.query(`select permission from role_permissions where role_id = $1`, [
        roleId,
      ]);
      expect(granted.rows.map((r) => r.permission)).toContain('platform.audit.read');
    });
  });

  // ------------------------------------------------------------- 4. no-op-ness
  describe('stays out of the way', () => {
    it('does not create a tenant, a tenant role, or a tenant membership', async () => {
      // The bootstrap is platform-scope only. If it ever started creating tenant rows
      // or memberships it would be inventing fixture data, which is exactly what
      // db:seed refuses to do.
      const userId = (await pool.query(`select id from users where email = $1`, [email])).rows[0].id;
      const tenantScoped = await pool.query(
        `select
           (select count(*)::int from memberships where user_id = $1) as memberships,
           (select count(*)::int from membership_roles mr
              join memberships m on m.id = mr.membership_id
             where m.user_id = $1) as membership_roles`,
        [userId],
      );
      expect(tenantScoped.rows[0].memberships).toBe(0);
      expect(tenantScoped.rows[0].membership_roles).toBe(0);

      // And it never created a tenant of its own.
      const tenants = await pool.query(`select count(*)::int as n from tenants`);
      expect(tenants.rows[0].n).toBe(tenantsBefore);
    });

    it('is not reachable from the seed command', async () => {
      // db:seed is contractually a no-op that must never create users or roles. This
      // pins that the bootstrap did not quietly become part of it.
      const seed = await import('@sms/db/src/cli/seed.js');
      const state = await seed.inspectSeedState(url);
      expect(state.migrated).toBe(true);
      expect(state.reason).toMatch(/Nothing was created or modified/);
    });
  });

  // ------------------------------------------------------------------ 5. types
  it('exposes the schema objects it relies on (guards the import list)', () => {
    expect(users).toBeDefined();
    expect(userProfiles).toBeDefined();
    expect(authIdentities).toBeDefined();
    expect(roles).toBeDefined();
    expect(rolePermissions).toBeDefined();
    expect(platformRoleAssignments).toBeDefined();
    expect(auditLogs).toBeDefined();
  });
});
