import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { getEnv } from '@sms/config';

/**
 * Phase 4.4 DB security proofs for migration 0013 (student portal identity),
 * run against the REAL roles + disposable test database (school_app_rw -> school_saas_test).
 *
 * Section A (linkage constraints): students.user_id is nullable; the composite
 * tenant-aware FK pins a link to a membership of the SAME tenant; the
 * SECURITY INVOKER trigger `trg_students_user_link_validate_biu` demands an
 * ACTIVE membership — a no-membership, suspended, or cross-tenant target is a
 * 55000 domain conflict (student_link_requires_membership), never a raw FK/RLS
 * error that could be probed for user existence.
 *
 * Section B (one-live-student-per-user): the partial unique index
 * students_tenant_user_uq allows exactly one LIVE student per (tenant, user);
 * the same user may link distinct students across different tenants, soft-deleted
 * history keeps its link, and a new live student may claim the identity.
 *
 * Section C (RLS + runtime role): inside a signed tenant context the runtime role
 * can only link students of its own tenant, and even there a foreign membership
 * target is rejected as 55000 (the membership lookup runs under the invoking
 * role's RLS and is therefore tenant-local).
 *
 * Opt-in: RUN_RUNTIME_SECURITY_TESTS=1 (requires migrations 0013 applied).
 */
const enabled = process.env.RUN_RUNTIME_SECURITY_TESTS === '1';
const describeDb = enabled ? describe : describe.skip;

describeDb('Phase 4.4 student portal identity on school_saas_test', () => {
  let migrator: pg.Client;
  let app: pg.Client;
  const uid: Record<string, string> = {};
  const slug = 'p44' + randomUUID().slice(0, 8);

  const appQ = <T extends pg.QueryResultRow = pg.QueryResultRow>(
    sqlText: string,
  ): Promise<T[]> => app.query<T>(sqlText).then((r) => r.rows);
  const migQ = <T extends pg.QueryResultRow = pg.QueryResultRow>(
    sqlText: string,
  ): Promise<T[]> => migrator.query<T>(sqlText).then((r) => r.rows);

  const rejectCode = async (
    fn: () => Promise<unknown>,
    code: string,
    pattern?: RegExp,
  ): Promise<void> => {
    await app.query('savepoint sp');
    const caught = await fn().catch((err: pg.DatabaseError) => err);
    await app.query('rollback to savepoint sp');
    expect(caught).toBeInstanceOf(Error);
    expect((caught as pg.DatabaseError).code).toBe(code);
    if (pattern) expect((caught as Error).message).toMatch(pattern);
  };

  async function tenantCtx<T>(userRaw: string, tenantRaw: string, fn: () => Promise<T>): Promise<T> {
    const tkt = (await appQ(`select app_ctx_mint('tenant', '${userRaw}', '${tenantRaw}') t`))[0]!
      .t as string;
    await app.query('begin');
    await app.query(`set local app.rls = '${tkt}'`);
    try {
      return await fn();
    } finally {
      await app.query('rollback').catch(() => {});
    }
  }

  beforeAll(async () => {
    const env = getEnv();
    migrator = new pg.Client({ connectionString: env.DATABASE_URL_MIGRATOR });
    app = new pg.Client({ connectionString: env.DATABASE_URL_APP });
    await migrator.connect();
    await app.connect();

    uid.tenantA = randomUUID();
    uid.tenantB = randomUUID();
    uid.userA = randomUUID();
    uid.userB = randomUUID();
    uid.userBoth = randomUUID();
    uid.userNone = randomUUID();
    uid.userSuspendedA = randomUUID();
    uid.studentA1 = randomUUID();
    uid.studentA2 = randomUUID();
    uid.studentAOld = randomUUID();
    uid.studentB1 = randomUUID();

    await migQ(`insert into tenants (id, slug, name) values
      ('${uid.tenantA}', '${slug}-a', 'Portal A'),
      ('${uid.tenantB}', '${slug}-b', 'Portal B')`);
    await migQ(`insert into users (id, email) values
      ('${uid.userA}', '${slug}-a@example.com'),
      ('${uid.userB}', '${slug}-b@example.com'),
      ('${uid.userBoth}', '${slug}-both@example.com'),
      ('${uid.userNone}', '${slug}-none@example.com'),
      ('${uid.userSuspendedA}', '${slug}-sus@example.com')`);
    await migQ(`insert into memberships (id, tenant_id, user_id, status) values
      ('${randomUUID()}', '${uid.tenantA}', '${uid.userA}', 'active'),
      ('${randomUUID()}', '${uid.tenantB}', '${uid.userB}', 'active'),
      ('${randomUUID()}', '${uid.tenantA}', '${uid.userBoth}', 'active'),
      ('${randomUUID()}', '${uid.tenantB}', '${uid.userBoth}', 'active'),
      ('${randomUUID()}', '${uid.tenantA}', '${uid.userSuspendedA}', 'suspended')`);
    // Seed one student per tenant to host later link tests (no links yet).
    await migQ(`insert into students (id, tenant_id, student_no, first_name, last_name, status) values
      ('${uid.studentA1}', '${uid.tenantA}', '${slug}-a1', 'A', 'One', 'active'),
      ('${uid.studentA2}', '${uid.tenantA}', '${slug}-a2', 'A', 'Two', 'active'),
      ('${uid.studentB1}', '${uid.tenantB}', '${slug}-b1', 'B', 'One', 'active')`);
  });

  afterAll(async () => {
    try {
      const ids = [
        uid.userA,
        uid.userB,
        uid.userBoth,
        uid.userNone,
        uid.userSuspendedA,
      ].map((x) => `'${x}'`);
      await migQ(`delete from students where tenant_id in ('${uid.tenantA}', '${uid.tenantB}')`);
      await migQ(
        `delete from memberships where tenant_id in ('${uid.tenantA}', '${uid.tenantB}') or user_id in (${ids.join(', ')})`,
      );
      await migQ(`delete from users where id in (${ids.join(', ')})`);
      await migQ(`delete from tenants where id in ('${uid.tenantA}', '${uid.tenantB}')`);
    } finally {
      await migrator.end();
      await app.end();
    }
  });

  describe('A. linkage constraints (migration 0013)', () => {
    it('students.user_id exists, is nullable, and defaults NULL', async () => {
      const cols = await appQ(
        `select column_name, is_nullable from information_schema.columns
         where table_name = 'students' and column_name = 'user_id'`,
      );
      expect(cols).toHaveLength(1);
      expect(cols[0]!.is_nullable).toBe('YES');
      const r = await migQ(
        `insert into students (id, tenant_id, student_no, first_name, last_name, status)
         values ('${randomUUID()}', '${uid.tenantA}', '${slug}-nulldef', 'N', 'Null', 'active')
         returning user_id`,
      );
      expect(r[0]!.user_id).toBeNull();
    });

    it('a user with NO membership in the tenant cannot be linked (55000 domain conflict)', async () => {
      await tenantCtx(uid.userA!, uid.tenantA!, () =>
        rejectCode(
          () =>
            appQ(`update students set user_id = '${uid.userNone}' where id = '${uid.studentA1}'`),
          '55000',
          /active membership/,
        ),
      );
    });

    it('a SUSPENDED membership cannot be linked (55000)', async () => {
      await tenantCtx(uid.userA!, uid.tenantA!, () =>
        rejectCode(
          () =>
            appQ(
              `update students set user_id = '${uid.userSuspendedA}' where id = '${uid.studentA1}'`,
            ),
          '55000',
          /active membership/,
        ),
      );
    });

    it('a membership of a DIFFERENT tenant cannot be linked in this tenant (55000, never 23503/23514)', async () => {
      // userB is active in tenantB only. Inside the tenantA context RLS hides the
      // tenantB membership; the composite FK would reject a cross-tenant pair but
      // the SECURITY INVOKER trigger fires first with a non-probeable 55000.
      await tenantCtx(uid.userA!, uid.tenantA!, () =>
        rejectCode(
          () =>
            appQ(`update students set user_id = '${uid.userB}' where id = '${uid.studentA1}'`),
          '55000',
          /active membership/,
        ),
      );
      // The privileged executor sees all rows: (tenantA, userB) simply does not
      // exist as a membership, so even migrator cannot forge a cross-tenant link.
      await expect(
        migQ(`update students set user_id = '${uid.userB}' where id = '${uid.studentA1}'`),
      ).rejects.toMatchObject({ code: '55000' });
    });

    it('an ACTIVE membership in this tenant links cleanly, and NULL clears it', async () => {
      await tenantCtx(uid.userA!, uid.tenantA!, async () => {
        await appQ(`update students set user_id = '${uid.userA}' where id = '${uid.studentA1}'`);
        const linked = await appQ(
          `select user_id from students where id = '${uid.studentA1}'`,
        );
        expect(linked[0]!.user_id).toBe(uid.userA);
        await appQ(`update students set user_id = null where id = '${uid.studentA1}'`);
        const cleared = await appQ(
          `select user_id from students where id = '${uid.studentA1}'`,
        );
        expect(cleared[0]!.user_id).toBeNull();
      });
    });
  });

  describe('B. one live student per portal user per tenant', () => {
    it('a second LIVE student for the same (tenant, user) is the partial-unique 23505', async () => {
      await migQ(`update students set user_id = '${uid.userBoth}' where id = '${uid.studentA1}'`);
      await expect(
        migQ(`update students set user_id = '${uid.userBoth}' where id = '${uid.studentA2}'`),
      ).rejects.toMatchObject({ code: '23505' });
    });

    it('the same user can link students in DIFFERENT tenants', async () => {
      // studentA1 already carries userBoth in tenantA; tenantB is independent.
      await migQ(`update students set user_id = '${uid.userBoth}' where id = '${uid.studentB1}'`);
      const r = await migQ(
        `select tenant_id, user_id from students where id in ('${uid.studentA1}', '${uid.studentB1}')`,
      );
      expect(r).toHaveLength(2);
      r.forEach((row) => expect(row.user_id).toBe(uid.userBoth));
      expect(new Set(r.map((row) => row.tenant_id))).toEqual(new Set([uid.tenantA, uid.tenantB]));
    });

    it('a soft-deleted student keeps its link; a new live student may claim the identity', async () => {
      const oldStudent = randomUUID();
      await migQ(`insert into students (id, tenant_id, student_no, first_name, last_name, status, user_id)
        values ('${oldStudent}', '${uid.tenantA}', '${slug}-old', 'Old', 'Profile', 'alumni', '${uid.userA}')`);
      // Soft-delete the old profile (alumni + deleted_at) — historical link kept.
      await migQ(`update students set deleted_at = now() where id = '${oldStudent}'`);
      // A new live student may now claim the same tenant user.
      const fresh = randomUUID();
      await migQ(`insert into students (id, tenant_id, student_no, first_name, last_name, status, user_id)
        values ('${fresh}', '${uid.tenantA}', '${slug}-fresh', 'New', 'Profile', 'active', '${uid.userA}')`);
      const r = await migQ(
        `select count(*)::int n from students where tenant_id = '${uid.tenantA}' and user_id = '${uid.userA}' and deleted_at is null`,
      );
      expect(r[0]!.n).toBe(1);
    });
  });

  describe('C. RLS + runtime role', () => {
    it('the runtime role cannot update a student of another tenant (RLS)', async () => {
      await tenantCtx(uid.userA!, uid.tenantA!, async () => {
        const upd = await appQ(
          `update students set first_name = 'X' where id = '${uid.studentB1}' returning id`,
        );
        expect(upd).toHaveLength(0);
      });
    });

    it('even an active SINGLE-tenant membership is not visible across tenants (portal erasure)', async () => {
      // userBoth is ACTIVE in BOTH tenants, but inside the tenantA context the
      // link is legal; prove the mirror: inside tenantB context, userA (tenantA
      // only) is 55000, so no instance can link a user who is not active THERE.
      await tenantCtx(uid.userB!, uid.tenantB!, () =>
        rejectCode(
          () =>
            appQ(`update students set user_id = '${uid.userA}' where id = '${uid.studentB1}'`),
          '55000',
          /active membership/,
        ),
      );
    });
  });
});