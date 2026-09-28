import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { getEnv } from '@sms/config';

/**
 * RLS trust-boundary regression tests, run against the REAL roles and REAL disposable test database
 * (school_app_rw -> school_saas_test). These verify the Phase-2A fix: RLS may no longer be
 * forged through transaction-local GUCs; only signed context tickets minted by
 * app_ctx_mint() (validation-gated) and the privileged executor role can establish context.
 *
 * Opt-in: RUN_RUNTIME_SECURITY_TESTS=1 (requires PostgreSQL + migrations 0001+0002 applied).
 */
const enabled = process.env.RUN_RUNTIME_SECURITY_TESTS === '1';
const describeDb = enabled ? describe : describe.skip;

const SCOPED_TABLES = [
  'tenants',
  'users',
  'user_profiles',
  'auth_identities',
  'auth_sessions',
  'memberships',
  'auth_tokens',
  'roles',
  'role_permissions',
  'membership_roles',
  'platform_role_assignments',
  'audit_logs',
  'outbox_events',
  'idempotency_keys',
];

describeDb('RLS trust boundary (school_app_rw vs school_saas_test)', () => {
  let migrator: pg.Client;
  let app: pg.Client;
  const uid: Record<string, string> = {};
  const slug = 'tr' + randomUUID().slice(0, 8);

  const appQ = <T extends pg.QueryResultRow = pg.QueryResultRow>(
    sqlText: string,
  ): Promise<T[]> => app.query<T>(sqlText).then((r) => r.rows);
  const migQ = <T extends pg.QueryResultRow = pg.QueryResultRow>(
    sqlText: string,
    params?: unknown[],
  ): Promise<T[]> => migrator.query<T>(sqlText, params as never[]).then((r) => r.rows);

  beforeAll(async () => {
    const env = getEnv();
    migrator = new pg.Client({ connectionString: env.DATABASE_URL_MIGRATOR });
    app = new pg.Client({ connectionString: env.DATABASE_URL_APP });
    await migrator.connect();
    await app.connect();

    uid.userA = randomUUID();
    uid.userB = randomUUID();
    uid.tenantA = randomUUID();
    uid.tenantB = randomUUID();
    uid.platRole = randomUUID();

    await migrator.query('begin');
    await migrator.query(
      `insert into tenants (id, slug, name) values
         ('${uid.tenantA}', '${slug}', 'Trust A'),
         ('${uid.tenantB}', '${slug}-b', 'Trust B')`,
    );
    await migrator.query(
      `insert into users (id, email) values
         ('${uid.userA}', 'trust-a-${slug}@example.com'),
         ('${uid.userB}', 'trust-b-${slug}@example.com')`,
    );
    await migrator.query(
      `insert into memberships (id, tenant_id, user_id, status) values
         ('${randomUUID()}', '${uid.tenantA}', '${uid.userA}', 'active')`,
    );
    await migrator.query(
      `insert into roles (id, scope, code, name, is_system) values
         ('${uid.platRole}', 'platform', 'tp_${slug}', 'Trust Platform', true)`,
    );
    await migrator.query(
      `insert into platform_role_assignments (user_id, role_id) values
         ('${uid.userA}', '${uid.platRole}')`,
    );
    await migrator.query(
      `insert into auth_identities (user_id, provider, provider_key, password_hash) values
         ('${uid.userA}', 'password', 'trust-a-${slug}@example.com', 'pbkdf2$dummy')`,
    );
    await migrator.query('commit');
  });

  afterAll(async () => {
    try {
      await migrator.query('begin');
      await migrator.query(`delete from outbox_events where event_type = 'trust.event'`);
      await migrator.query(`delete from platform_role_assignments where user_id in ('${uid.userA}','${uid.userB}')`);
      await migrator.query(`delete from auth_identities where user_id in ('${uid.userA}','${uid.userB}')`);
      await migrator.query(`delete from memberships where tenant_id in ('${uid.tenantA}','${uid.tenantB}')`);
      await migrator.query(`delete from roles where id = '${uid.platRole}'`);
      await migrator.query(`delete from users where id in ('${uid.userA}','${uid.userB}')`);
      await migrator.query(`delete from tenants where id in ('${uid.tenantA}','${uid.tenantB}')`);
      await migrator.query('commit');
    } finally {
      await migrator.end();
      await app.end();
    }
  });

  it('1. unauthenticated app_rw session sees nothing across scoped tables', async () => {
    for (const t of SCOPED_TABLES) {
      const r2 = await appQ(`select count(*)::int n from ${t}`);
      expect(Number(r2[0]!.n)).toBe(0);
    }
  });

  it('2. forging legacy GUCs grants nothing (platform_access / current_tenant / current_user)', async () => {
    await app.query('begin');
    await app.query(`select set_config('app.platform_access', 'on', true)`);
    await app.query(`select set_config('app.current_tenant', '${uid.tenantA}', true)`);
    await app.query(`select set_config('app.current_user', '${uid.userA}', true)`);
    const tenants = await appQ(`select count(*)::int n from tenants`);
    const mems = await appQ(`select count(*)::int n from memberships`);
    const assigns = await appQ(`select count(*)::int n from platform_role_assignments`);
    const audits = await appQ(`select count(*)::int n from audit_logs`);
    await app.query('rollback');
    expect(Number(tenants[0]!.n)).toBe(0);
    expect(Number(mems[0]!.n)).toBe(0);
    expect(Number(assigns[0]!.n)).toBe(0);
    expect(Number(audits[0]!.n)).toBe(0);
  });

  it('3. school_app_rw cannot SET ROLE to the privileged migrator role', async () => {
    await expect(app.query('set role school_migrator')).rejects.toThrow(/permission denied/);
  });

  it('4. app_privileged() is false for app_rw and true for migrator', async () => {
    expect(Number((await appQ(`select app_privileged()::int p`))[0]!.p)).toBe(0);
    expect(Number((await migQ(`select app_privileged()::int p`))[0]!.p)).toBe(1);
  });

  it('5. context tickets mint only for real active memberships / platform assignments', async () => {
    const valid = await appQ<{ t: string | null }>(
      `select app_ctx_mint('tenant', '${uid.userA}', '${uid.tenantA}') t`,
    );
    expect(valid[0]!.t).toBeTruthy();

    const crossTenant = await appQ<{ t: string | null }>(
      `select app_ctx_mint('tenant', '${uid.userA}', '${uid.tenantB}') t`,
    );
    expect(crossTenant[0]!.t).toBeNull();

    const noUser = await appQ<{ t: string | null }>(`select app_ctx_mint('tenant', null, null) t`);
    expect(noUser[0]!.t).toBeNull();

    const platOk = await appQ<{ t: string | null }>(
      `select app_ctx_mint('platform', '${uid.userA}', null) t`,
    );
    expect(platOk[0]!.t).toBeTruthy();
    const platNo = await appQ<{ t: string | null }>(
      `select app_ctx_mint('platform', '${uid.userB}', null) t`,
    );
    expect(platNo[0]!.t).toBeNull();
    const badScope = await appQ<{ t: string | null }>(`select app_ctx_mint('system', null, null) t`);
    expect(badScope[0]!.t).toBeNull();
  });

  it('6. a valid ticket scopes reads to the claimed tenant only (tenant A vs B)', async () => {
    const tkt = (await appQ(`select app_ctx_mint('tenant', '${uid.userA}', '${uid.tenantA}') t`))[0]!.t as string;
    await app.query('begin');
    await app.query(`set local app.rls = '${tkt}'`);
    const own = (await appQ(`select count(*)::int n from memberships where tenant_id='${uid.tenantA}'`))[0]!.n;
    const other = (await appQ(`select count(*)::int n from memberships where tenant_id='${uid.tenantB}'`))[0]!.n;
    const tenantB = (await appQ(`select count(*)::int n from tenants where id='${uid.tenantB}'`))[0]!.n;
    await app.query('rollback');
    expect(Number(own)).toBe(1);
    expect(Number(other)).toBe(0);
    expect(Number(tenantB)).toBe(0);
  });

  it('7. tampered/forged tickets are rejected (0 rows, no crash)', async () => {
    const tkt = (await appQ(`select app_ctx_mint('account', '${uid.userA}', null) t`))[0]!.t as string;
    await app.query('begin');
    await app.query(`set local app.rls = '${tkt}x'`);
    const tampered = (await appQ(`select count(*)::int n from users`))[0]!.n;
    await app.query('rollback');
    expect(Number(tampered)).toBe(0);

    await app.query('begin');
    await app.query(`set local app.rls = 'garbage'`);
    const garbage = (await appQ(`select count(*)::int n from users`))[0]!.n;
    await app.query('rollback');
    expect(Number(garbage)).toBe(0);
  });

  it('8. platform data is invisible to non-platform users, visible with a platform ticket', async () => {
    // Scoped to this suite's own users: platform_role_assignments is a GLOBAL
    // table, so an unscoped count also counts every other suite's leftovers and
    // asserts nothing about the boundary.
    const own = `user_id in ('${uid.userA}','${uid.userB}')`;
    const platNo = await appQ(`select count(*)::int n from platform_role_assignments where ${own}`);
    expect(Number(platNo[0]!.n)).toBe(0);

    const tkt = (await appQ(`select app_ctx_mint('platform', '${uid.userA}', null) t`))[0]!.t as string;
    await app.query('begin');
    await app.query(`set local app.rls = '${tkt}'`);
    const visible = (await appQ(`select count(*)::int n from platform_role_assignments where ${own}`))[0]!.n;
    await app.query('rollback');
    expect(Number(visible)).toBe(1);
  });

  it('9. credentials: app_rw cannot read raw identities; definer lookup is the narrow path', async () => {
    const raw = (await appQ(`select count(*)::int n from auth_identities`))[0]!.n;
    expect(Number(raw)).toBe(0);
    const lookup = await appQ<{ user_id: string; password_hash: string }>(
      `select user_id, password_hash from app_auth_login_lookup('password', 'trust-a-${slug}@example.com')`,
    );
    expect(lookup).toHaveLength(1);
    expect(lookup[0]!.user_id).toBe(uid.userA);
    expect(lookup[0]!.password_hash).toBe('pbkdf2$dummy');
  });

  it('10. app_rw cannot overwrite another user\'s credentials (no account takeover)', async () => {
    const res = await app.query(
      `update auth_identities set password_hash = 'owned' where user_id = '${uid.userA}'`,
    );
    expect(res.rowCount).toBe(0);
    const lookup = await appQ<{ user_id: string; password_hash: string }>(
      `select user_id, password_hash from app_auth_login_lookup('password', 'trust-a-${slug}@example.com')`,
    );
    expect(lookup[0]!.password_hash).toBe('pbkdf2$dummy');
  });

  it('11. every scoped table is RLS+FOCE and no policy trusts legacy GUCs', async () => {
    const rels = await migQ<{ tablename: string; rls: boolean; force: boolean }>(
      `select c.relname tablename, c.relrowsecurity rls, c.relforcerowsecurity force
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relname = any($1::text[])`,
      [SCOPED_TABLES],
    );
    expect(rels.map((r) => r.tablename).sort()).toEqual([...SCOPED_TABLES].sort());
    for (const r of rels) {
      expect(r.rls).toBe(true);
      expect(r.force).toBe(true);
    }
    const tainted = await migQ<{ tablename: string }>(
      `select distinct c.relname tablename
       from pg_policy p
       join pg_class c on c.oid = p.polrelid
       join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public'
         and (pg_get_expr(p.polqual, p.polrelid) ilike '%platform_access%'
              or pg_get_expr(p.polqual, p.polrelid) ilike '%system_access%'
              or pg_get_expr(p.polqual, p.polrelid) ilike '%app.current_tenant%'
              or pg_get_expr(p.polqual, p.polrelid) ilike '%app.current_user%'
              or pg_get_expr(p.polwithcheck, p.polrelid) ilike '%platform_access%'
              or pg_get_expr(p.polwithcheck, p.polrelid) ilike '%system_access%'
              or pg_get_expr(p.polwithcheck, p.polrelid) ilike '%app.current_tenant%'
              or pg_get_expr(p.polwithcheck, p.polrelid) ilike '%app.current_user%')`,
    );
    expect(tainted).toEqual([]);
  });

  it('12. privileged executor (migrator) reads cross-tenant system rows; app_rw cannot', async () => {
    await migrator.query(`delete from outbox_events where event_type = 'trust.event'`);
    await migrator.query(
      `insert into outbox_events (tenant_id, event_type, aggregate_type, aggregate_id, payload)
       values ('${uid.tenantA}', 'trust.event', 'trust', 'trust', '{"probe":true}')`,
    );
    const sysRead = await appQ(`select count(*)::int n from outbox_events where event_type = 'trust.event'`);
    expect(Number(sysRead[0]!.n)).toBe(0);
    const migRead = await migQ(`select count(*)::int n from outbox_events where event_type = 'trust.event'`);
    expect(Number(migRead[0]!.n)).toBe(1);
  });
});