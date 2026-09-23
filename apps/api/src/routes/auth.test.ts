import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { getEnv } from '@sms/config';
import { createDb, type Db } from '@sms/db';
import { registerUser } from '@sms/auth';

/**
 * Regression test for the self-registration path (POST /api/v1/auth/register).
 *
 * Background: registerUser inserted the new user with INSERT ... RETURNING before
 * minting the account-scope ticket. RLS applies the SELECT policy to rows returned
 * by RETURNING, and with no context active at insert time the new row was invisible
 * to school_app_rw, so the insert was rejected:
 *   new row violates row-level security policy for table "users"
 * The fix supplies the id explicitly (uuid generated in app code, same pattern as
 * auth_sessions) so no post-insert read-back is needed.
 *
 * This test exercises the ACTUAL service function against the real database under
 * the real school_app_rw role and verifies the user, profile, identity, audit and
 * outbox rows all land. It is red on the old `returning({ id })` implementation.
 *
 * Opt-in: RUN_RUNTIME_SECURITY_TESTS=1 (requires PostgreSQL + migrations 0001+0002).
 */
const enabled = process.env.RUN_RUNTIME_SECURITY_TESTS === '1';
const describeDb = enabled ? describe : describe.skip;

describeDb('register user route path (school_app_rw vs dev DB)', () => {
  let migratorDb: Db;
  let appDb: Db;
  let endMigrator: () => Promise<void>;
  let endApp: () => Promise<void>;

  let registeredId: string | null = null;
  const email = `register-${randomUUID().slice(0, 8)}@example.com`;

  const rows = async (db: Db, q: ReturnType<typeof sql>): Promise<Record<string, unknown>[]> =>
    (await db.execute(q)).rows;

  beforeAll(async () => {
    const env = getEnv();
    const mig = createDb({ url: env.DATABASE_URL_MIGRATOR });
    const app = createDb({ url: env.DATABASE_URL_APP });
    migratorDb = mig.db;
    appDb = app.db;
    endMigrator = () => mig.pool.end();
    endApp = () => app.pool.end();
  });

  afterAll(async () => {
    try {
      if (registeredId) {
        await rows(migratorDb, sql`delete from audit_logs where actor_user_id = ${registeredId}`);
        await rows(migratorDb, sql`delete from outbox_events where aggregate_id = ${registeredId}`);
        await rows(migratorDb, sql`delete from auth_identities where user_id = ${registeredId}`);
        await rows(migratorDb, sql`delete from user_profiles where user_id = ${registeredId}`);
        await rows(migratorDb, sql`delete from users where id = ${registeredId}`);
      }
    } finally {
      await endMigrator();
      await endApp();
    }
  });

  it('registers a user through the app role without an RLS violation', async () => {
    const out = await registerUser(appDb, {
      email,
      password: 'RegisterTest-Pass-2026!',
      fullName: 'Register Regression',
      requestId: randomUUID(),
    });

    expect(out.userId).toBeTruthy();
    registeredId = out.userId;

    const userN = await rows(migratorDb, sql`select count(*)::int n from users where id = ${registeredId}`);
    expect(Number(userN[0]!.n)).toBe(1);
  });

  it('lands the user/profile/identity/audit/outbox rows with correct shape', async () => {
    const prof = await rows(migratorDb, sql`select full_name from user_profiles where user_id = ${registeredId}`);
    expect(prof[0]!.full_name).toBe('Register Regression');

    const ident = await rows(
      migratorDb,
      sql`select provider, provider_key, password_hash from auth_identities where user_id = ${registeredId}`,
    );
    expect(ident[0]!.provider).toBe('password');
    expect(ident[0]!.provider_key).toBe(email);
    expect(String(ident[0]!.password_hash)).toMatch(/^\$argon2id\$/);

    const auditN = await rows(
      migratorDb,
      sql`select count(*)::int n from audit_logs where actor_user_id = ${registeredId} and action = 'user.created'`,
    );
    expect(Number(auditN[0]!.n)).toBe(1);

    const outboxN = await rows(
      migratorDb,
      sql`select count(*)::int n from outbox_events where aggregate_id = ${registeredId} and event_type = 'user.created'`,
    );
    expect(Number(outboxN[0]!.n)).toBe(1);
    const outboxTenant = await rows(
      migratorDb,
      sql`select tenant_id from outbox_events where aggregate_id = ${registeredId} and event_type = 'user.created'`,
    );
    expect(outboxTenant[0]!.tenant_id).toBeNull();
  });
});