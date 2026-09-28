import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { getEnv } from '@sms/config';

/**
 * Phase 2B.1 regression tests for the two DB security preconditions, run against the REAL
 * roles and REAL disposable test database (school_app_rw -> school_saas_test). Requires migration 0003.
 *
 * auth_tokens: now FORCE RLS and self-visible/writable only (mirrors auth_identities_own),
 * with the privileged executor escape for pre-auth token creation and maintenance. These
 * tests prove bare app_rw sessions see/write nothing, forged legacy GUCs buy nothing, owned
 * account-context is the narrow app_rw path, and the privileged executor retains access.
 *
 * idempotency_keys: WITH CHECK now matches USING, enabling tenant-scoped writes while the
 * tenant_id equals the current signed tenant context. These tests prove tenant-scoped
 * insert/update paths work for the own tenant, cross-tenant writes are rejected, existing
 * account/platform (NULL tenant) and privileged behavior is unchanged.
 *
 * Opt-in: RUN_RUNTIME_SECURITY_TESTS=1 (requires PostgreSQL + migrations 0001+0002+0003).
 */
const enabled = process.env.RUN_RUNTIME_SECURITY_TESTS === '1';
const describeDb = enabled ? describe : describe.skip;

describeDb('token & idempotency scope (auth_tokens / idempotency_keys on school_saas_test)', () => {
  let migrator: pg.Client;
  let app: pg.Client;
  const uid: Record<string, string> = {};
  const slug = 'tk' + randomUUID().slice(0, 8);

  const appQ = <T extends pg.QueryResultRow = pg.QueryResultRow>(
    sqlText: string,
  ): Promise<T[]> => app.query<T>(sqlText).then((r) => r.rows);
  const migQ = <T extends pg.QueryResultRow = pg.QueryResultRow>(
    sqlText: string,
  ): Promise<T[]> => migrator.query<T>(sqlText).then((r) => r.rows);

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
         ('${uid.tenantA}', '${slug}', 'Token A'),
         ('${uid.tenantB}', '${slug}-b', 'Token B')`,
    );
    await migrator.query(
      `insert into users (id, email) values
         ('${uid.userA}', 'token-a-${slug}@example.com'),
         ('${uid.userB}', 'token-b-${slug}@example.com')`,
    );
    await migrator.query(
      `insert into memberships (id, tenant_id, user_id, status) values
         ('${randomUUID()}', '${uid.tenantA}', '${uid.userA}', 'active')`,
    );
    await migrator.query(
      `insert into roles (id, scope, code, name, is_system) values
         ('${uid.platRole}', 'platform', 'tpk_${slug}', 'Token Platform', true)`,
    );
    await migrator.query(
      `insert into platform_role_assignments (user_id, role_id) values
         ('${uid.userB}', '${uid.platRole}')`,
    );
    await migrator.query(
      `insert into auth_tokens (user_id, token_type, token_hash, expires_at) values
         ('${uid.userA}', 'password_reset', 'hash-tsa-${slug}', now() + interval '1 hour'),
         ('${uid.userB}', 'password_reset', 'hash-tsb-${slug}', now() + interval '1 hour')`,
    );
    await migrator.query(
      `insert into idempotency_keys (tenant_id, key, expires_at) values
         ('${uid.tenantA}', 'ik-${slug}-ta', now() + interval '1 hour'),
         ('${uid.tenantB}', 'ik-${slug}-tb', now() + interval '1 hour'),
         (null, 'ik-${slug}-acct', now() + interval '1 hour')`,
    );
    await migrator.query('commit');
  });

  afterAll(async () => {
    try {
      await migrator.query('begin');
      await migrator.query(`delete from idempotency_keys where key like 'ik-${slug}%'`);
      await migrator.query(`delete from auth_tokens where token_hash like 'hash-ts_-${slug}'`);
      await migrator.query(
        `delete from platform_role_assignments where user_id in ('${uid.userA}','${uid.userB}')`,
      );
      await migrator.query(`delete from roles where id = '${uid.platRole}'`);
      await migrator.query(
        `delete from memberships where tenant_id in ('${uid.tenantA}','${uid.tenantB}')`,
      );
      await migrator.query(`delete from users where id in ('${uid.userA}','${uid.userB}')`);
      await migrator.query(`delete from tenants where id in ('${uid.tenantA}','${uid.tenantB}')`);
      await migrator.query('commit');
    } finally {
      await migrator.end();
      await app.end();
    }
  });

  describe('auth_tokens row-level security', () => {
    it('1. RLS is enabled on auth_tokens', async () => {
      const r = await migQ<{ rls_on: boolean }>(`
        select c.relrowsecurity rls_on
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname = 'auth_tokens'`);
      expect(r[0]!.rls_on).toBe(true);
    });

    it('2. RLS is FORCED on auth_tokens (owner does not bypass)', async () => {
      const r = await migQ<{ force: boolean }>(`
        select c.relforcerowsecurity force
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname = 'auth_tokens'`);
      expect(r[0]!.force).toBe(true);
    });

    it('3. school_app_rw is not a superuser', async () => {
      const r = await migQ(`select rolname from pg_roles where rolname = 'school_app_rw' and rolsuper`);
      expect(r).toHaveLength(0);
    });

    it('4. school_app_rw cannot BYPASSRLS', async () => {
      const r = await migQ(`select rolname from pg_roles where rolname = 'school_app_rw' and rolbypassrls`);
      expect(r).toHaveLength(0);
    });

    it('5. unauth_app_rw session reads zero auth_tokens rows despite DML grants', async () => {
      const grants = await migQ<{ s: boolean; i: boolean; u: boolean; d: boolean }>(`
        select has_table_privilege('school_app_rw', 'auth_tokens', 'SELECT') s,
               has_table_privilege('school_app_rw', 'auth_tokens', 'INSERT') i,
               has_table_privilege('school_app_rw', 'auth_tokens', 'UPDATE') u,
               has_table_privilege('school_app_rw', 'auth_tokens', 'DELETE') d`);
      expect(grants[0]).toEqual({ s: true, i: true, u: true, d: true });
      const r = await appQ(`select count(*)::int n from auth_tokens`);
      expect(Number(r[0]!.n)).toBe(0);
    });

    it('6. account context sees ONLY the owning user\'s token', async () => {
      const tkt = (await appQ(`select app_ctx_mint('account', '${uid.userA}', null) t`))[0]!.t as string;
      await app.query('begin');
      await app.query(`set local app.rls = '${tkt}'`);
      const all = (await appQ(`select count(*)::int n from auth_tokens`))[0]!.n;
      const other = (await appQ<{ n: number }>(
        `select count(*)::int n from auth_tokens where user_id = '${uid.userB}'`,
      ))[0]!.n;
      await app.query('rollback');
      expect(Number(all)).toBe(1);
      expect(Number(other)).toBe(0);
    });

    it('7. account context cannot modify or mint another user\'s token', async () => {
      const tkt = (await appQ(`select app_ctx_mint('account', '${uid.userA}', null) t`))[0]!.t as string;
      await app.query('begin');
      await app.query(`set local app.rls = '${tkt}'`);
      const upd = await app.query(
        `update auth_tokens set consumed_at = now() where user_id = '${uid.userB}'`,
      );
      const del = await app.query(`delete from auth_tokens where user_id = '${uid.userB}'`);
      expect(upd.rowCount).toBe(0);
      expect(del.rowCount).toBe(0);
      await expect(
        app.query(
          `insert into auth_tokens (user_id, token_type, token_hash, expires_at)
           values ('${uid.userB}', 'password_reset', 'hash-owned-${slug}', now() + interval '1 hour')`,
        ),
      ).rejects.toThrow(/row-level security/);
      await app.query('rollback');
    });

    it('8. legacy forgeable GUCs still buy nothing against auth_tokens', async () => {
      await app.query('begin');
      await app.query(`select set_config('app.platform_access', 'on', true)`);
      await app.query(`select set_config('app.current_tenant', '${uid.tenantA}', true)`);
      await app.query(`select set_config('app.current_user', '${uid.userA}', true)`);
      const r = await appQ(`select count(*)::int n from auth_tokens`);
      await app.query('rollback');
      expect(Number(r[0]!.n)).toBe(0);
    });

    it('9. privileged executor retains narrow craft/cleanup path; app_rw has none', async () => {
      const migAll = await migQ(`select count(*)::int n from auth_tokens`);
      expect(Number(migAll[0]!.n)).toBe(2);
      await migrator.query('begin');
      const upd = await migrator.query(
        `update auth_tokens set consumed_at = now() where user_id = '${uid.userB}'`,
      );
      expect(upd.rowCount).toBe(1);
      await migrator.query('rollback');
      expect(Number((await appQ(`select app_privileged()::int p`))[0]!.p)).toBe(0);
    });
  });

  describe('idempotency_keys scope', () => {
    it('10. auth_tokens carries exactly one policy; idempotency_keys exactly one', async () => {
      const r = await migQ<{ tbl: string; n: number }>(`
        select c.relname tbl, count(p.oid)::int n
        from pg_class c
        join pg_namespace ns on ns.oid = c.relnamespace
        left join pg_policy p on p.polrelid = c.oid
        where ns.nspname = 'public' and c.relname in ('auth_tokens', 'idempotency_keys')
        group by c.relname order by c.relname`);
      expect(r).toHaveLength(2);
      for (const row of r) expect(Number(row.n)).toBe(1);
    });

    it('11. tenant-scoped insert allowed under matching tenant context (regression fix)', async () => {
      const tkt = (await appQ(
        `select app_ctx_mint('tenant', '${uid.userA}', '${uid.tenantA}') t`,
      ))[0]!.t as string;
      await app.query('begin');
      await app.query(`set local app.rls = '${tkt}'`);
      const ins = await app.query(
        `insert into idempotency_keys (tenant_id, key, expires_at)
         values ('${uid.tenantA}', 'ik-${slug}-ta2', now() + interval '1 hour')`,
      );
      await app.query('rollback');
      expect(ins.rowCount).toBe(1);
    });

    it('12. tenant-scoped insert rejected for a foreign tenant (no cross-tenant write)', async () => {
      const tkt = (await appQ(
        `select app_ctx_mint('tenant', '${uid.userA}', '${uid.tenantA}') t`,
      ))[0]!.t as string;
      await app.query('begin');
      await app.query(`set local app.rls = '${tkt}'`);
      await expect(
        app.query(
          `insert into idempotency_keys (tenant_id, key, expires_at)
           values ('${uid.tenantB}', 'ik-${slug}-cross', now() + interval '1 hour')`,
        ),
      ).rejects.toThrow(/row-level security/);
      await app.query('rollback');
    });

    it('13. account scope still writes NULL-tenant rows (backward-compatible)', async () => {
      const tkt = (await appQ(`select app_ctx_mint('account', '${uid.userA}', null) t`))[0]!.t as string;
      await app.query('begin');
      await app.query(`set local app.rls = '${tkt}'`);
      const ins = await app.query(
        `insert into idempotency_keys (tenant_id, key, expires_at)
         values (null, 'ik-${slug}-acct2', now() + interval '1 hour')`,
      );
      await app.query('rollback');
      expect(ins.rowCount).toBe(1);
    });

    it('14. platform scope still writes NULL-tenant rows (backward-compatible)', async () => {
      const tkt = (await appQ(`select app_ctx_mint('platform', '${uid.userB}', null) t`))[0]!.t as string;
      await app.query('begin');
      await app.query(`set local app.rls = '${tkt}'`);
      const ins = await app.query(
        `insert into idempotency_keys (tenant_id, key, expires_at)
         values (null, 'ik-${slug}-plat', now() + interval '1 hour')`,
      );
      await app.query('rollback');
      expect(ins.rowCount).toBe(1);
    });

    it('15. tenant-scoped update cannot rewrite tenant_id to a foreign tenant', async () => {
      const tkt = (await appQ(
        `select app_ctx_mint('tenant', '${uid.userA}', '${uid.tenantA}') t`,
      ))[0]!.t as string;
      await app.query('begin');
      await app.query(`set local app.rls = '${tkt}'`);
      await expect(
        app.query(
          `update idempotency_keys set tenant_id = '${uid.tenantB}' where key = 'ik-${slug}-ta'`,
        ),
      ).rejects.toThrow(/row-level security/);
      await app.query('rollback');
    });

    it('16. cross-tenant read of idempotency keys remains blocked', async () => {
      const tkt = (await appQ(
        `select app_ctx_mint('tenant', '${uid.userA}', '${uid.tenantA}') t`,
      ))[0]!.t as string;
      await app.query('begin');
      await app.query(`set local app.rls = '${tkt}'`);
      const other = (await appQ<{ n: number }>(
        `select count(*)::int n from idempotency_keys where tenant_id = '${uid.tenantB}'`,
      ))[0]!.n;
      const own = (await appQ<{ n: number }>(
        `select count(*)::int n from idempotency_keys where tenant_id = '${uid.tenantA}'`,
      ))[0]!.n;
      await app.query('rollback');
      expect(Number(other)).toBe(0);
      expect(Number(own)).toBe(1);
    });

    it('17. privileged executor keeps a full idempotency path (any tenant / phasing)', async () => {
      await migrator.query('begin');
      const ins = await migrator.query(
        `insert into idempotency_keys (tenant_id, key, expires_at)
         values ('${uid.tenantB}', 'ik-${slug}-pv', now() + interval '1 hour')`,
      );
      const migAll = await migQ(`select count(*)::int n from idempotency_keys where key like 'ik-${slug}%'`);
      const appNone = await appQ(`select count(*)::int n from idempotency_keys where key like 'ik-${slug}%'`);
      await migrator.query('rollback');
      expect(ins.rowCount).toBe(1);
      expect(Number(migAll[0]!.n)).toBe(4);
      expect(Number(appNone[0]!.n)).toBe(0);
    });
  });
});