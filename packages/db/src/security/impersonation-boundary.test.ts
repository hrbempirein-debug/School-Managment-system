import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { getEnv } from '@sms/config';

/**
 * Phase 2A residual-risk boundary test: can an untrusted holder of the shared
 * school_app_rw credential legally obtain a VALID signed context ticket for another
 * real user/tenant combination (impersonation), rather than forging one?
 *
 * This deliberately does NOT test ticket forgery — the HMAC is trusted. It tests whether
 * app_ctx_mint() has any trustworthy caller identity to distinguish "X is a real member"
 * from "the caller is authenticated as X".
 *
 * Opt-in: RUN_RUNTIME_SECURITY_TESTS=1 (real PG 18 + migrations 0001+0002 on school_saas_dev).
 * No production code is modified; nothing is committed.
 */
const enabled = process.env.RUN_RUNTIME_SECURITY_TESTS === '1';
const describeDb = enabled ? describe : describe.skip;

describeDb('Phase 2A residual: impersonation via shared runtime credential', () => {
  let migrator: pg.Client;
  let app: pg.Client;
  const id: Record<string, string> = {};
  const slug = 'imp' + randomUUID().slice(0, 8);
  let platRole: string;

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

    // Fresh random fixtures via the admin (migrator) bootstrap path — no invented IDs,
    // no secrets touched. A, B are real users; A is a "normal application" member of T1;
    // B is a real member of T1 (the impersonation target) AND a platform-assigned user;
    // C is a real user who is NOT a member of T1 and has no platform assignment (serves
    // as the doppelganger-free counter-case for claim-scoped reads).
    id.userA = randomUUID();
    id.userB = randomUUID();
    id.userC = randomUUID();
    id.tenantA = randomUUID();
    id.tenantB = randomUUID(); // foreign tenant where nobody is a member
    platRole = randomUUID();

    await migrator.query('begin');
    await migrator.query(
      `insert into tenants (id, slug, name) values
         ('${id.tenantA}', '${slug}', 'Imp A'), ('${id.tenantB}', '${slug}-b', 'Imp B')`,
    );
    await migrator.query(
      `insert into users (id, email) values
         ('${id.userA}', 'imp-a-${slug}@example.com'),
         ('${id.userB}', 'imp-b-${slug}@example.com'),
         ('${id.userC}', 'imp-c-${slug}@example.com')`,
    );
    await migrator.query(
      `insert into user_profiles (user_id, full_name) values
         ('${id.userA}', 'User A'), ('${id.userB}', 'User B'), ('${id.userC}', 'User C')`,
    );
    await migrator.query(
      `insert into memberships (id, tenant_id, user_id, status) values
         ('${randomUUID()}', '${id.tenantA}', '${id.userA}', 'active'),
         ('${randomUUID()}', '${id.tenantA}', '${id.userB}', 'active')`,
    );
    await migrator.query(
      `insert into roles (id, scope, code, name, is_system) values
         ('${platRole}', 'platform', 'imp_pl_${slug}', 'Imp Platform', true)`,
    );
    await migrator.query(
      `insert into platform_role_assignments (user_id, role_id) values ('${id.userB}', '${platRole}')`,
    );
    await migrator.query('commit');
  });

  afterAll(async () => {
    try {
      await migrator.query('begin');
      await migrator.query(`delete from platform_role_assignments where user_id in ('${id.userA}','${id.userB}','${id.userC}')`);
      await migrator.query(`delete from roles where id = '${platRole}'`);
      await migrator.query(`delete from memberships where tenant_id in ('${id.tenantA}','${id.tenantB}')`);
      await migrator.query(`delete from user_profiles where user_id in ('${id.userA}','${id.userB}','${id.userC}')`);
      await migrator.query(`delete from users where id in ('${id.userA}','${id.userB}','${id.userC}')`);
      await migrator.query(`delete from tenants where id in ('${id.tenantA}','${id.tenantB}')`);
      await migrator.query('commit');
    } finally {
      await migrator.end();
      await app.end();
    }
  });

  it('1. mint signature + grants (trusted function, EXECUTE granted to the shared credential holder)', async () => {
    const m = await migQ<{ signature: string; definer: boolean; owner: string; acl: boolean }>(
      `select p.oid::regprocedure::text signature, p.prosecdef definer, p.proowner::regrole owner,
              has_function_privilege('school_app_rw', p.oid, 'EXECUTE') acl
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'app_ctx_mint'`,
    );
    expect(m).toHaveLength(1);
    expect(m[0]!.signature).toBe('app_ctx_mint(text,uuid,uuid)');
    expect(m[0]!.definer).toBe(true);
    expect(m[0]!.owner).toBe('school_migrator');
    expect(m[0]!.acl).toBe(true); // school_app_rw may CALL it directly
  });

  it('2. mint body contains no caller identity signal (no session_user / current_user binding)', async () => {
    const d = await migQ<{ has_session_user: number; has_current_user_ref: number }>(
      `select position('session_user' in pg_get_functiondef(p.oid)) has_session_user,
              position('current_user' in pg_get_functiondef(p.oid)) has_current_user_ref
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'app_ctx_mint'`,
    );
    expect(d[0]!.has_session_user).toBe(0);
    expect(d[0]!.has_current_user_ref).toBe(0);
  });

  it('3. legitimate application context: a self-scoped tenant ticket for User A works', async () => {
    await app.query('begin');
    const tkt = (await appQ(
      `select app_ctx_mint('tenant', '${id.userA}', '${id.tenantA}') t`,
    ))[0]!.t as string;
    expect(tkt).toBeTruthy();
    const autoSetGuc = (await appQ(`select current_setting('app.rls', true) g`))[0]!.g;
    expect(autoSetGuc).toBe(tkt); // mint ALSO installs it as the transaction-local GUC
    const ownProfiles = (await appQ(`select count(*)::int n from user_profiles`))[0]!.n;
    expect(Number(ownProfiles)).toBe(1); // only A's profile visible
    await app.query('rollback');
  });

  it('4. cross-user mint: the shared-credential holder mints a VALID ticket for real User B@T1', async () => {
    await app.query('begin');
    const tkt = (await appQ(
      `select app_ctx_mint('tenant', '${id.userB}', '${id.tenantA}') t`,
    ))[0]!.t as string;
    expect(tkt).toBeTruthy();
    const guc = (await appQ(`select current_setting('app.rls', true) g`))[0]!.g;
    expect(guc).toBe(tkt);
    // The ticket's claims now resolve to B: B's profile is the only visible one, C's is hidden.
    const profiles = await appQ<{ user_id: string }>(`select user_id from user_profiles`);
    expect(profiles.map((r) => r.user_id).sort()).toEqual([id.userB]);
    const bVisible = (await appQ(`select count(*)::int n from users where id='${id.userB}'`))[0]!.n;
    expect(Number(bVisible)).toBe(1);
    await app.query('rollback');
  });

  it('5. counter-cases stay closed: non-member tenant, non-assigned user, invalid scope', async () => {
    await app.query('begin');
    const foreign = (await appQ(
      `select app_ctx_mint('tenant', '${id.userB}', '${id.tenantB}') t`,
    ))[0]!.t as string | null;
    expect(foreign).toBeNull(); // B is not a member of the foreign tenant
    const notAssigned = (await appQ(
      `select app_ctx_mint('platform', '${id.userA}', null) t`,
    ))[0]!.t as string | null;
    expect(notAssigned).toBeNull(); // A has no platform assignment
    const badScope = (await appQ(`select app_ctx_mint('system', '${id.userA}', null) t`))[0]!.t as string | null;
    expect(badScope).toBeNull();
    await app.query('rollback');
  });

  it('6. cross-user platform mint: a VALID platform ticket for the real platform-assigned User B', async () => {
    await app.query('begin');
    const tkt = (await appQ(
      `select app_ctx_mint('platform', '${id.userB}', null) t`,
    ))[0]!.t as string;
    expect(tkt).toBeTruthy();
    const assigns = (await appQ(
      `select count(*)::int n from platform_role_assignments`,
    ))[0]!.n;
    expect(Number(assigns)).toBe(1); // platform claim is honored for B
    await app.query('rollback');
  });

  it('7. the mint call is stateless about who is calling (F/G evidence)', async () => {
    await app.query('begin');
    const caller = (await appQ(
      `select session_user s, current_user c`,
    ))[0] as { s: string; c: string };
    expect(caller.s).toBe('school_app_rw');
    expect(caller.c).toBe('school_app_rw');
    // Same call as test 4 while the invoking session is demonstrably school_app_rw:
    const tkt = (await appQ(
      `select app_ctx_mint('tenant', '${id.userB}', '${id.tenantA}') t`,
    ))[0]!.t as string | null;
    expect(tkt).toBeTruthy();
    await app.query('rollback');
  });

  it('8. direct legacy-GUC forgery remains blocked (policies ignore them)', async () => {
    await app.query('begin');
    await app.query(`select set_config('app.current_user', '${id.userB}', true)`);
    await app.query(`select set_config('app.current_tenant', '${id.tenantA}', true)`);
    await app.query(`select set_config('app.platform_access', 'on', true)`);
    await app.query(`select set_config('app.system_access', 'on', true)`);
    const users = (await appQ(`select count(*)::int n from users`))[0]!.n;
    const assigns = (await appQ(`select count(*)::int n from platform_role_assignments`))[0]!.n;
    const proflies = (await appQ(`select count(*)::int n from user_profiles`))[0]!.n;
    await app.query('rollback');
    expect(Number(users)).toBe(0);
    expect(Number(assigns)).toBe(0);
    expect(Number(proflies)).toBe(0);
  });

  it('9. the mint secret stays out of reach (ticket cannot be forged offline)', async () => {
    const canRevoke = (await appQ(
      `select has_table_privilege('school_app_rw', 'app_rls_secrets', 'SELECT') p`,
    ))[0]!.p;
    expect(canRevoke).toBe(false);
    // Explicit REVOKE ALL: even a bare SELECT is denied (not just RLS-filtered to 0 rows).
    await expect(app.query(`select * from app_rls_secrets`)).rejects.toThrow(/permission denied/);
  });
});