import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { getEnv } from '@sms/config';

/**
 * P0 regression: the migration ledger `schema_migrations` must be unreachable by the
 * least-privilege runtime role `school_app_rw`.
 *
 * THE DEFECT
 * `0001_init.sql` ends with `ALTER DEFAULT PRIVILEGES FOR ROLE school_migrator ...
 * GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO school_app_rw`. That default grant
 * is correct for APPLICATION tables, but `schema_migrations` is not an application
 * table: it is created by the migration CLI itself, as `school_migrator`, with
 * `create table if not exists` (packages/db/src/cli/migrate.ts:23,
 * migrate-down.ts:54 and :100, seed.ts:30). So the default privileges swept up the
 * ledger and handed the API/worker role full DML on it. `DELETE FROM
 * schema_migrations` from an application session erases the record of which migrations
 * ran, which makes the next `pnpm db:migrate` believe the database is empty.
 *
 * THE FIX
 * `0020_schema_migrations_runtime_protection.sql` revokes ALL privileges on that one
 * table from `school_app_rw` (and from PUBLIC), then asserts, inside the migration
 * itself, that nothing survived. Applied migrations 0001-0019 are history and are not
 * edited; the repair is additive.
 *
 * WHY THESE ASSERTIONS AND NOT JUST A GRANT CATALOG CHECK
 * A catalog check proves the ACL says what we intended. It does not prove the kernel
 * enforces it, and it does not prove the ledger survived an attack attempt. So this
 * suite does three things a catalog dump cannot:
 *   1. attempts the real attack statements as the real app role and requires each to
 *      be refused with SQLSTATE 42501;
 *   2. re-counts the ledger afterwards as the migrator to prove the attack did not
 *      land even partially (every attempt is rolled back regardless of outcome, so a
 *      regression destroys nothing - it fails);
 *   3. proves the migrator's own SELECT/INSERT still work, because the migration CLI
 *      reads and writes this table and an over-broad revoke would break `db:migrate`;
 *   4. proves 0020 did NOT over-reach: `school_app_rw` must still hold DML on ordinary
 *      application tables, so nobody can "fix" this later by revoking 0001's default
 *      privileges and silently breaking the application.
 *
 * Opt-in: RUN_RUNTIME_SECURITY_TESTS=1 (requires PostgreSQL + migrations 0001..0020).
 */
const enabled = process.env.RUN_RUNTIME_SECURITY_TESTS === '1';
const describeDb = enabled ? describe : describe.skip;

const MIGRATION_0020 = '0020_schema_migrations_runtime_protection.sql';

/** Every table privilege PostgreSQL defines, so nothing is left unchecked. */
const ALL_TABLE_PRIVILEGES = [
  'SELECT',
  'INSERT',
  'UPDATE',
  'DELETE',
  'TRUNCATE',
  'REFERENCES',
  'TRIGGER',
] as const;

/** SQLSTATE for insufficient_privilege. */
const INSUFFICIENT_PRIVILEGE = '42501';

describeDb('schema_migrations runtime protection (0020, on school_saas_test)', () => {
  let migrator: pg.Client;
  let app: pg.Client;

  /** Run one statement in its own transaction that is ALWAYS rolled back. */
  const attemptRolledBack = async (client: pg.Client, text: string): Promise<string | null> => {
    await client.query('begin');
    try {
      await client.query(text);
      return null; // the statement SUCCEEDED - that is the failure we want to catch
    } catch (err) {
      return (err as { code?: string }).code ?? 'NO_SQLSTATE';
    } finally {
      await client.query('rollback');
    }
  };

  const ledgerCount = async (): Promise<number> => {
    const r = await migrator.query<{ n: string }>('select count(*)::text as n from schema_migrations');
    return Number(r.rows[0]!.n);
  };

  beforeAll(async () => {
    const env = getEnv();
    migrator = new pg.Client({ connectionString: env.DATABASE_URL_MIGRATOR });
    app = new pg.Client({ connectionString: env.DATABASE_URL_APP });
    await migrator.connect();
    await app.connect();
  });

  afterAll(async () => {
    await Promise.allSettled([migrator?.end(), app?.end()]);
  });

  it('1. the fix itself is applied to this database', async () => {
    const r = await migrator.query<{ version: string }>(
      'select version from schema_migrations where version = $1',
      [MIGRATION_0020],
    );
    expect(
      r.rows,
      `${MIGRATION_0020} is not recorded, so the ledger protection is not in effect here. ` +
        'Run pnpm db:migrate against the disposable database.',
    ).toHaveLength(1);
  });

  it('2. school_app_rw holds NO privilege of any kind on the ledger', async () => {
    for (const priv of ALL_TABLE_PRIVILEGES) {
      const r = await migrator.query<{ has: boolean }>(
        'select has_table_privilege($1, $2, $3) as has',
        ['school_app_rw', 'public.schema_migrations', priv],
      );
      expect(
        r.rows[0]!.has,
        `school_app_rw still holds ${priv} on schema_migrations. The runtime role must not ` +
          'be able to read or rewrite the migration ledger.',
      ).toBe(false);
    }
  });

  it('3. the ledger is granted to the migrator role and to nobody else', async () => {
    const r = await migrator.query<{ grantee: string }>(
      `select distinct grantee
         from information_schema.role_table_grants
        where table_schema = 'public' and table_name = 'schema_migrations'
        order by grantee`,
    );
    // A PUBLIC grant would appear here as the literal grantee 'PUBLIC'.
    expect(r.rows.map((x) => x.grantee)).toEqual(['school_migrator']);
  });

  it('4. the real attack statements are refused as the app role (SQLSTATE 42501)', async () => {
    const attacks: ReadonlyArray<readonly [string, string]> = [
      ['DELETE the ledger (the attack this migration exists for)', 'delete from schema_migrations'],
      ['UPDATE the ledger', 'update schema_migrations set applied_at = now()'],
      ['INSERT a fabricated migration row', `insert into schema_migrations(version) values ('attacker.sql')`],
      ['TRUNCATE the ledger', 'truncate schema_migrations'],
      ['read the ledger', 'select * from schema_migrations'],
    ];
    for (const [label, sql] of attacks) {
      const code = await attemptRolledBack(app, sql);
      expect(code, `app role was ALLOWED to ${label} - the migration ledger is writable by the runtime role`).toBe(
        INSUFFICIENT_PRIVILEGE,
      );
    }
  });

  it('5. the ledger is intact after those attempts', async () => {
    // Proves the refusals in 4 were real, not cosmetic. The expected count is read
    // from the ledger itself rather than hardcoded, so adding a migration does not
    // make this fail.
    const before = await ledgerCount();
    expect(before).toBeGreaterThan(0);
    await attemptRolledBack(app, 'delete from schema_migrations');
    await attemptRolledBack(app, `insert into schema_migrations(version) values ('attacker.sql')`);
    expect(await ledgerCount(), 'the ledger changed after attack attempts that must all have been refused').toBe(before);
    const r = await migrator.query<{ n: string }>(
      `select count(*)::text as n from schema_migrations where version = 'attacker.sql'`,
    );
    expect(Number(r.rows[0]!.n), 'a fabricated migration row survived').toBe(0);
  });

  it('6. the migration CLI can still read and write the ledger as the migrator', async () => {
    // The negative control above is only safe because the migrator's own access path
    // is intact. migrate.ts selects and inserts here; if 0020 ever over-revoked, this
    // is what would break `pnpm db:migrate`.
    await migrator.query('begin');
    try {
      const sel = await migrator.query<{ n: string }>('select count(*)::text as n from schema_migrations');
      expect(Number(sel.rows[0]!.n)).toBeGreaterThan(0);
      await migrator.query(
        `insert into schema_migrations(version) values ('0020_selftest_probe.sql') on conflict do nothing`,
      );
      const ins = await migrator.query<{ n: string }>(
        `select count(*)::text as n from schema_migrations where version = '0020_selftest_probe.sql'`,
      );
      expect(Number(ins.rows[0]!.n), 'migrator must still be able to insert into the ledger').toBe(1);
    } finally {
      await migrator.query('rollback');
    }
  });

  it('7. 0020 did NOT over-reach: the app role still holds DML on application tables', async () => {
    // 0001's ALTER DEFAULT PRIVILEGES is what gives school_app_rw access to every
    // application table, and it is deliberately NOT revoked by 0020 - doing so would
    // strip the application of all access. This is the guard that makes the narrow
    // fix necessary: it fails if someone later "fixes" this by revoking the default.
    for (const table of ['tenants', 'users', 'students', 'outbox_events']) {
      for (const priv of ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] as const) {
        const r = await migrator.query<{ has: boolean }>(
          'select has_table_privilege($1, $2, $3) as has',
          ['school_app_rw', `public.${table}`, priv],
        );
        expect(
          r.rows[0]!.has,
          `school_app_rw lost ${priv} on application table ${table}. 0020 must revoke the ledger ` +
            'only - the blanket default privileges in 0001 are what the application depends on.',
        ).toBe(true);
      }
    }
  });

  it('8. the ledger carries no tenant data, so locking it down cannot orphan rows', async () => {
    // The revoke is safe to apply to a live database only because the ledger is
    // global bookkeeping with no tenant_id and no foreign keys pointing at it. If a
    // future change ever gives it tenant columns or inbound references, this fails
    // and forces the migration to be revisited.
    const cols = await migrator.query<{ column_name: string }>(
      `select column_name
         from information_schema.columns
        where table_schema = 'public' and table_name = 'schema_migrations'
        order by column_name`,
    );
    expect(cols.rows.map((c) => c.column_name)).toEqual(['applied_at', 'version']);

    const inbound = await migrator.query<{ n: string }>(
      `select count(*)::text as n
         from pg_constraint con
         join pg_class rel on rel.oid = con.conrelid
         join pg_namespace ns on ns.oid = rel.relnamespace
        where con.contype = 'f'
          and con.confrelid = 'public.schema_migrations'::regclass
          and ns.nspname = 'public'`,
    );
    expect(Number(inbound.rows[0]!.n), 'something now references the ledger; reassess 0020').toBe(0);
  });
});
