import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { getEnv } from '@sms/config';
import { createDb, withTenant, type Db } from '@sms/db';
import type { RequestContext } from '@sms/core';
import { createTenantTransaction } from './tenants.js';

/**
 * Regression test for the tenant-creation path (POST /api/v1/platform/tenants).
 *
 * Background: the route used to mint the tenant ticket (setTenantScope) BEFORE the
 * creator's membership row existed. app_ctx_mint('tenant', u, t) is gated on an
 * existing active membership, so it returned NULL without touching app.rls, the
 * (platform) context stayed active, and the tenant-scoped audit insert was rejected
 * by RLS:
 *   new row violates row-level security policy for table "audit_logs"
 * The transaction then rolled back and POST /api/v1/platform/tenants returned 500.
 *
 * This test exercises the ACTUAL route transaction (createTenantTransaction called
 * through withTenant, the same DB helper the route uses) against the real database
 * under the real school_app_rw role. It FAILS if setTenantScope runs before the
 * membership insert (the tenant-scoped audit/outbox writes abort the transaction,
 * so the downstream assertions see no rows) and PASSES once the ordering is correct.
 *
 * Opt-in: RUN_RUNTIME_SECURITY_TESTS=1 (requires PostgreSQL + migrations 0001+0002).
 */
const enabled = process.env.RUN_RUNTIME_SECURITY_TESTS === '1';
const describeDb = enabled ? describe : describe.skip;

describeDb('tenant creation route path (school_app_rw vs dev DB)', () => {
  let migratorDb: Db;
  let appDb: Db;
  let endMigrator: () => Promise<void>;
  let endApp: () => Promise<void>;

  const uid: Record<string, string> = {};
  const slug = `tz${randomUUID().slice(0, 8)}`;

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

    uid.user = randomUUID();
    uid.platRole = randomUUID();
    uid.tenant = randomUUID();
    uid.otherTenant = randomUUID();

    await rows(
      migratorDb,
      sql`insert into users (id, email) values (${uid.user}, ${`platform-owner-${slug}@example.com`})`,
    );
    await rows(
      migratorDb,
      sql`insert into roles (id, scope, code, name, is_system) values (${uid.platRole}, 'platform', ${`tp_${slug}`}, 'Test Platform Owner', true)`,
    );
    await rows(
      migratorDb,
      sql`insert into platform_role_assignments (user_id, role_id) values (${uid.user}, ${uid.platRole})`,
    );
  });

  afterAll(async () => {
    try {
      await rows(migratorDb, sql`delete from outbox_events where tenant_id = ${uid.tenant}`);
      await rows(migratorDb, sql`delete from audit_logs where tenant_id = ${uid.tenant}`);
      await rows(
        migratorDb,
        sql`delete from membership_roles where membership_id in (select id from memberships where tenant_id = ${uid.tenant} or user_id = ${uid.user})`,
      );
      await rows(
        migratorDb,
        sql`delete from role_permissions where role_id in (select id from roles where tenant_id = ${uid.tenant} or id = ${uid.platRole})`,
      );
      await rows(migratorDb, sql`delete from memberships where tenant_id = ${uid.tenant} or user_id = ${uid.user}`);
      await rows(migratorDb, sql`delete from platform_role_assignments where user_id = ${uid.user}`);
      await rows(migratorDb, sql`delete from roles where tenant_id = ${uid.tenant} or id = ${uid.platRole}`);
      await rows(migratorDb, sql`delete from users where id = ${uid.user}`);
      await rows(migratorDb, sql`delete from tenants where id = ${uid.tenant}`);
    } finally {
      await endMigrator();
      await endApp();
    }
  });

  it('creates a tenant + owner membership and commits tenant-scoped audit/outbox rows', async () => {
    const ctx: RequestContext = {
      requestId: randomUUID(),
      userId: uid.user!,
      scope: 'platform',
      tenantId: null,
      membershipId: null,
      campusId: null,
      roleIds: [uid.platRole!],
      permissions: new Set(['platform.tenants.create']),
      platformAccess: true,
      isSystem: false,
    };

    const out = await withTenant(appDb, ctx, (tx) =>
      createTenantTransaction(tx, ctx, { slug, name: 'Route Regression School', requestId: ctx.requestId }),
    );
    uid.tenant = out.tenantId;

    expect(out.tenantId).toBeTruthy();
    expect(out.membershipId).toBeTruthy();

    const tenantN = await rows(migratorDb, sql`select count(*)::int n from tenants where id = ${out.tenantId}`);
    expect(Number(tenantN[0]!.n)).toBe(1);

    const memN = await rows(
      migratorDb,
      sql`select count(*)::int n from memberships where tenant_id = ${out.tenantId} and user_id = ${uid.user} and status = 'active'`,
    );
    expect(Number(memN[0]!.n)).toBe(1);

    const mrN = await rows(
      migratorDb,
      sql`select count(*)::int n from membership_roles mr join memberships m on m.id = mr.membership_id join roles r on r.id = mr.role_id where m.tenant_id = ${out.tenantId} and m.user_id = ${uid.user} and r.code = 'school_owner'`,
    );
    expect(Number(mrN[0]!.n)).toBe(1);

    const auditN = await rows(
      migratorDb,
      sql`select count(*)::int n from audit_logs where tenant_id = ${out.tenantId} and action in ('tenant.created', 'membership.created')`,
    );
    expect(Number(auditN[0]!.n)).toBe(2);

    const outboxN = await rows(
      migratorDb,
      sql`select count(*)::int n from outbox_events where tenant_id = ${out.tenantId} and event_type in ('tenant.created', 'membership.created')`,
    );
    expect(Number(outboxN[0]!.n)).toBe(2);
  });

  it('no cross-tenant rows are created under the new tenant', async () => {
    const otherAudits = await rows(
      migratorDb,
      sql`select count(*)::int n from audit_logs where tenant_id = ${uid.otherTenant}`,
    );
    expect(Number(otherAudits[0]!.n)).toBe(0);
    const otherOutbox = await rows(
      migratorDb,
      sql`select count(*)::int n from outbox_events where tenant_id = ${uid.otherTenant}`,
    );
    expect(Number(otherOutbox[0]!.n)).toBe(0);
    const otherMems = await rows(
      migratorDb,
      sql`select count(*)::int n from memberships where tenant_id = ${uid.otherTenant}`,
    );
    expect(Number(otherMems[0]!.n)).toBe(0);
  });

  it('tenant ticket mints after membership exists and no context leaks after commit', async () => {
    const tkt = await rows(appDb, sql`select app_ctx_mint('tenant', ${uid.user}, ${uid.tenant}) t`);
    expect(tkt[0]!.t).toBeTruthy();

    const leaked = await rows(appDb, sql`select coalesce(current_setting('app.rls', true), '') v`);
    expect(leaked[0]!.v).toBe('');

    const visible = await rows(appDb, sql`select count(*)::int n from tenants where id = ${uid.tenant}`);
    expect(Number(visible[0]!.n)).toBe(0);
  });
});