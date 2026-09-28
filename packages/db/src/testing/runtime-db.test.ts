import { describe, it, expect } from 'vitest';
import pg from 'pg';
import { getEnv } from '@sms/config';
import {
  assertDisposableTestDatabase,
  databaseNameOf,
  isDisposableTestDatabaseName,
  resolveRuntimeDatabaseUrls,
  withDatabase,
} from './runtime-db.js';

/**
 * F-05 — proof that the runtime-security suites are structurally prevented from
 * touching a real environment.
 *
 * The first half is a pure unit test of the policy: the name rule, the refusal of
 * the known real databases, and the URL derivation. The second half is the test
 * that actually matters operationally: it connects through the SAME `getEnv()`
 * the suites use and asserts the database it landed on is disposable and is not
 * `school_saas_dev`.
 *
 * Before this finding, every one of these suites ran against `school_saas_dev`.
 */
describe('F-05 disposable test database policy', () => {
  describe('name rule', () => {
    it('accepts names that opt in to being disposable', () => {
      expect(isDisposableTestDatabaseName('school_saas_test')).toBe(true);
      expect(isDisposableTestDatabaseName('sms_ci_test')).toBe(true);
      expect(isDisposableTestDatabaseName('test_scratch')).toBe(true);
    });

    it('refuses every other name, defaulting to "no"', () => {
      expect(isDisposableTestDatabaseName('school_saas_dev')).toBe(false);
      expect(isDisposableTestDatabaseName('school_saas')).toBe(false);
      expect(isDisposableTestDatabaseName('sms_ephemeral')).toBe(false);
      expect(isDisposableTestDatabaseName('postgres')).toBe(false);
      expect(isDisposableTestDatabaseName('')).toBe(false);
      // A suffix anywhere but the end is not an opt-in.
      expect(isDisposableTestDatabaseName('sms_test_old')).toBe(false);
    });
  });

  describe('assertDisposableTestDatabase', () => {
    it('passes through a disposable name', () => {
      expect(assertDisposableTestDatabase('school_saas_test')).toBe('school_saas_test');
    });

    it('names school_saas_dev specifically, because that is the finding', () => {
      expect(() => assertDisposableTestDatabase('school_saas_dev')).toThrow(/school_saas_dev/);
      expect(() => assertDisposableTestDatabase('school_saas_dev')).toThrow(/DISPOSABLE/);
    });

    it('refuses the maintenance databases outright', () => {
      expect(() => assertDisposableTestDatabase('postgres')).toThrow(/DISPOSABLE/);
      expect(() => assertDisposableTestDatabase('template1')).toThrow(/DISPOSABLE/);
    });

    it('refuses an unrecognised name with the actionable message', () => {
      expect(() => assertDisposableTestDatabase('sms_ephemeral')).toThrow(/_test/);
    });
  });

  describe('URL handling', () => {
    it('extracts the database name', () => {
      expect(databaseNameOf('postgresql://u:p@localhost:5432/school_saas_dev')).toBe(
        'school_saas_dev',
      );
      expect(databaseNameOf('postgresql://u:p@localhost:5432/school_saas_test?sslmode=require')).toBe(
        'school_saas_test',
      );
      expect(databaseNameOf('postgresql://u:p@localhost:5432')).toBe('');
    });

    it('swaps only the database, keeping scheme, credentials and host', () => {
      const swapped = withDatabase(
        'postgresql://school_migrator:secret@127.0.0.1:5433/school_saas_dev',
        'school_saas_test',
      );
      expect(swapped).toBe('postgresql://school_migrator:secret@127.0.0.1:5433/school_saas_test');
      expect(databaseNameOf(swapped)).toBe('school_saas_test');
    });
  });

  describe('resolveRuntimeDatabaseUrls', () => {
    const MIGRATOR = 'postgresql://school_migrator:secret@127.0.0.1:5432/school_saas_dev';

    it('points both roles at the disposable database', () => {
      const urls = resolveRuntimeDatabaseUrls({
        DATABASE_URL_TEST: 'postgresql://school_app_rw:secret@127.0.0.1:5432/school_saas_test',
        DATABASE_URL_MIGRATOR: MIGRATOR,
      });
      expect(urls.database).toBe('school_saas_test');
      expect(databaseNameOf(urls.appUrl)).toBe('school_saas_test');
      // The DDL role keeps its own credentials; only the database changes.
      expect(databaseNameOf(urls.migratorUrl)).toBe('school_saas_test');
      expect(urls.migratorUrl).toContain('school_migrator');
    });

    it('REFUSES a DATABASE_URL_TEST aimed at the development database', () => {
      expect(() =>
        resolveRuntimeDatabaseUrls({
          DATABASE_URL_TEST: 'postgresql://school_app_rw:secret@127.0.0.1:5432/school_saas_dev',
          DATABASE_URL_MIGRATOR: MIGRATOR,
        }),
      ).toThrow(/school_saas_dev/);
    });

    it('REFUSES a DATABASE_URL_TEST aimed at production', () => {
      expect(() =>
        resolveRuntimeDatabaseUrls({
          DATABASE_URL_TEST: 'postgresql://school_app_rw:secret@db/school_saas_prod',
          DATABASE_URL_MIGRATOR: MIGRATOR,
        }),
      ).toThrow(/DISPOSABLE/);
    });

    it('refuses to guess when DATABASE_URL_TEST is absent, rather than using the app URL', () => {
      expect(() =>
        resolveRuntimeDatabaseUrls({
          DATABASE_URL_APP: 'postgresql://school_app_rw:secret@127.0.0.1:5432/school_saas_dev',
          DATABASE_URL_MIGRATOR: MIGRATOR,
        }),
      ).toThrow(/DATABASE_URL_TEST is required/);
    });
  });

  /**
   * The live assertion. This is the one that would have caught the finding: it asks
   * the running suite, through the same accessor the fixtures use, which database
   * it is actually on.
   */
  const enabled = process.env.RUN_RUNTIME_SECURITY_TESTS === '1';
  const describeDb = enabled ? describe : describe.skip;

  describeDb('the database the suites actually connect to', () => {
    it('is disposable and is not the development database', async () => {
      const env = getEnv();
      const name = databaseNameOf(env.DATABASE_URL_APP);
      expect(name).not.toBe('school_saas_dev');
      expect(() => assertDisposableTestDatabase(name)).not.toThrow();

      const client = new pg.Client({ connectionString: env.DATABASE_URL_APP });
      await client.connect();
      try {
        const current = await client.query<{ db: string; user: string }>(
          'select current_database() as db, current_user as "user"',
        );
        expect(current.rows[0]?.db).toBe(name);
        // Still the unprivileged runtime role: the suites must not have escalated
        // themselves to make the isolation work.
        expect(current.rows[0]?.user).toBe('school_app_rw');
      } finally {
        await client.end();
      }
    });

    it('has the Phase 6 migration applied, so it is not an empty shell', async () => {
      const client = new pg.Client({ connectionString: getEnv().DATABASE_URL_MIGRATOR });
      await client.connect();
      try {
        const applied = await client.query<{ version: string }>(
          'select version from schema_migrations order by version',
        );
        const versions = applied.rows.map((r) => r.version);
        expect(versions).toContain('0015_exams_results.sql');
        expect(versions).toContain('0016_phase6_result_integrity_fixes.sql');
      } finally {
        await client.end();
      }
    });
  });
});
