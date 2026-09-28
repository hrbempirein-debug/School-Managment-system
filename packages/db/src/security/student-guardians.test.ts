import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { getEnv } from '@sms/config';

/**
 * Phase 3.2 student↔guardian soft-unlink DB security+integrity proofs, run
 * against the REAL roles and REAL disposable test database (school_app_rw -> school_saas_test).
 * Requires migrations 0005 + 0006.
 *
 * 0006 makes the relationship soft-deletable: `student_guardians.deleted_at` is
 * added and the inline full `UNIQUE (tenant_id, student_id, guardian_id,
 * relation)` constraint is replaced by a PARTIAL unique index scoped to
 * `deleted_at IS NULL`. Consequences proven here:
 *
 *   A. RLS stays intact on the bridge table (bare session sees nothing; a signed
 *      tenant context sees only its own rows; cross-tenant INSERT and the runtime
 *      DELETE path remain blocked).
 *   B. The partial unique index rejects a second ACTIVE (student, guardian,
 *      relation) link (canonical >23505> guardrail), but a soft-unlinked row is
 *      released: the SAME key can be re-linked afterwards (the forward-only fix
 *      0005's full constraint made impossible).
 *   C. Soft unlink is an UPDATE (deleted_at), never a hard DELETE; unlinked rows
 *      are invisible to the app-shaped "live links" query and still readable by
 *      the privileged executor, preserving historical audit.
 *   D. Cross-tenant links remain impossible (composite tenant-aware FK).
 *
 * Opt-in: RUN_RUNTIME_SECURITY_TESTS=1 (requires PostgreSQL + migrations 0001..0006).
 */
const enabled = process.env.RUN_RUNTIME_SECURITY_TESTS === '1';
const describeDb = enabled ? describe : describe.skip;

describeDb('student_guardians soft-unlink (0006) + RLS (school_saas_test)', () => {
  let migrator: pg.Client;
  let app: pg.Client;
  const uid: Record<string, string> = {};
  const slug = 'sg' + randomUUID().slice(0, 8);

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

  async function tenantA<T>(fn: () => Promise<T>): Promise<T> {
    const tkt = (await appQ(
      `select app_ctx_mint('tenant', '${uid.userA}', '${uid.tenantA}') t`,
    ))[0]!.t as string;
    await app.query('begin');
    await app.query(`set local app.rls = '${tkt}'`);
    try {
      const result = await fn();
      await app.query('commit');
      return result;
    } catch (err) {
      await app.query('rollback').catch(() => {});
      throw err;
    }
  }

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
    uid.campusA = randomUUID();
    uid.campusB = randomUUID();
    uid.studentA = randomUUID();
    uid.studentB = randomUUID();
    uid.guardianA = randomUUID();
    uid.guardianB = randomUUID();
    uid.relA = randomUUID();

    await migrator.query('begin');
    await migrator.query(
      `insert into tenants (id, slug, name) values
         ('${uid.tenantA}', '${slug}-a', 'Soft Unlink A'),
         ('${uid.tenantB}', '${slug}-b', 'Soft Unlink B')`,
    );
    await migrator.query(
      `insert into users (id, email) values
         ('${uid.userA}', 'sg-a-${slug}@example.com'),
         ('${uid.userB}', 'sg-b-${slug}@example.com')`,
    );
    await migrator.query(
      `insert into memberships (id, tenant_id, user_id, status) values
         ('${randomUUID()}', '${uid.tenantA}', '${uid.userA}', 'active'),
         ('${randomUUID()}', '${uid.tenantB}', '${uid.userB}', 'active')`,
    );
    await migrator.query(
      `insert into campuses (id, tenant_id, code, name, status) values
         ('${uid.campusA}', '${uid.tenantA}', 'sg-ca-${slug}', 'Campus A', 'active'),
         ('${uid.campusB}', '${uid.tenantB}', 'sg-cb-${slug}', 'Campus B', 'active')`,
    );
    await migrator.query(
      `insert into students (id, tenant_id, student_no, first_name, last_name, status, primary_campus_id) values
         ('${uid.studentA}', '${uid.tenantA}', 'sg-a-${slug}', 'Alice', 'Anderson', 'active', '${uid.campusA}'),
         ('${uid.studentB}', '${uid.tenantB}', 'sg-b-${slug}', 'Bob', 'Brown', 'active', '${uid.campusB}')`,
    );
    await migrator.query(
      `insert into guardians (id, tenant_id, first_name, last_name) values
         ('${uid.guardianA}', '${uid.tenantA}', 'Gina', 'Alt'),
         ('${uid.guardianB}', '${uid.tenantB}', 'Gary', 'Blue')`,
    );
    await migrator.query(
      `insert into student_guardians (id, tenant_id, student_id, guardian_id, relation, is_primary, can_pickup) values
         ('${uid.relA}', '${uid.tenantA}', '${uid.studentA}', '${uid.guardianA}', 'parent', true, true)`,
    );
    await migrator.query('commit');
  });

  afterAll(async () => {
    try {
      await migrator.query('begin');
      const tenantIds = `'${uid.tenantA}','${uid.tenantB}'`;
      await migrator.query(`delete from student_guardians where tenant_id in (${tenantIds})`);
      await migrator.query(`delete from guardians where tenant_id in (${tenantIds})`);
      await migrator.query(`delete from students where tenant_id in (${tenantIds})`);
      await migrator.query(`delete from memberships where tenant_id in (${tenantIds})`);
      await migrator.query(
        `delete from users where id in ('${uid.userA}','${uid.userB}')`,
      );
      await migrator.query(`delete from tenants where id in (${tenantIds})`);
      await migrator.query('commit');
    } finally {
      await migrator.end();
      await app.end();
    }
  });

  describe('A. schema imprint of 0006', () => {
    it('1. student_guardians has deleted_at and the relation unique index is partial (deleted_at IS NULL)', async () => {
      const cols = await migQ<{ name: string }>(`
        select column_name name from information_schema.columns
        where table_name = 'student_guardians' and column_name = 'deleted_at'`);
      expect(cols).toHaveLength(1);

      const idx = await migQ<{ name: string; def: string }>(`
        select i.relname name, pg_get_indexdef(i.oid) def
        from pg_index x join pg_class i on i.oid = x.indexrelid
        join pg_class t on t.oid = x.indrelid
        where t.relname = 'student_guardians' and i.relname = 'student_guardians_relation_uq'`);
      expect(idx).toHaveLength(1);
      expect(idx[0]!.def).toContain('CREATE UNIQUE INDEX');
      expect(idx[0]!.def).toContain('WHERE (deleted_at IS NULL)');
    });

    it('2. the per-side bridge indexes are present and partial', async () => {
      const idx = await migQ<{ name: string; def: string }>(`
        select i.relname name, pg_get_indexdef(i.oid) def
        from pg_index x join pg_class i on i.oid = x.indexrelid
        join pg_class t on t.oid = x.indrelid
        where t.relname = 'student_guardians' and i.relname in ('student_guardians_student_idx','student_guardians_guardian_idx')
        order by i.relname`);
      expect(idx).toHaveLength(2);
      for (const row of idx) {
        expect(row.def).toContain('INDEX');
        expect(row.def).toContain('WHERE (deleted_at IS NULL)');
      }
    });
  });

  describe('B. row-level security boundary (untouched by 0006)', () => {
    it('3. school_app_rw sees zero bridge rows without a signed context', async () => {
      const grants = await migQ<{ s: boolean }>(
        `select has_table_privilege('school_app_rw', 'student_guardians', 'SELECT') s`,
      );
      expect(grants[0]!.s).toBe(true);
      const r = await appQ<{ n: number }>(`select count(*)::int n from student_guardians`);
      expect(Number(r[0]!.n)).toBe(0);
    });

    it('4. a signed tenant A context sees its own link, never tenant B', async () => {
      await tenantA(async () => {
        const own = (
          await appQ<{ n: number }>(
            `select count(*)::int n from student_guardians where tenant_id = '${uid.tenantA}'`,
          )
        )[0]!.n;
        const foreign = (
          await appQ<{ n: number }>(
            `select count(*)::int n from student_guardians where tenant_id = '${uid.tenantB}'`,
          )
        )[0]!.n;
        expect(Number(own)).toBeGreaterThan(0);
        expect(Number(foreign)).toBe(0);
      });
    });

    it('5. cross-tenant link INSERT is rejected (42501 RLS)', async () => {
      await tenantA(async () => {
        await rejectCode(
          () =>
            app.query(
              `insert into student_guardians (id, tenant_id, student_id, guardian_id, relation)
               values ('${randomUUID()}', '${uid.tenantB}', '${uid.studentB}', '${uid.guardianB}', 'parent')`,
            ),
          '42501',
        );
      });
    });

    it('6. the runtime role still has no hard DELETE path on the bridge', async () => {
      await tenantA(async () => {
        const del = await app.query(
          `delete from student_guardians where tenant_id = '${uid.tenantA}'`,
        );
        expect(del.rowCount).toBe(0);
      });
    });

    it('7. cross-tenant composite FK: a foreign guardian cannot be linked to a local student', async () => {
      await tenantA(async () => {
        await rejectCode(
          () =>
            app.query(
              `insert into student_guardians (id, tenant_id, student_id, guardian_id, relation)
               values ('${randomUUID()}', '${uid.tenantA}', '${uid.studentA}', '${uid.guardianB}', 'parent')`,
            ),
          '23503',
        );
      });
    });
  });

  describe('C. soft unlink semantics (0006)', () => {
    it('8. a duplicate ACTIVE (student, guardian, relation) link is still rejected (23505)', async () => {
      await tenantA(async () => {
        await rejectCode(
          () =>
            app.query(
              `insert into student_guardians (id, tenant_id, student_id, guardian_id, relation)
               values ('${randomUUID()}', '${uid.tenantA}', '${uid.studentA}', '${uid.guardianA}', 'parent')`,
            ),
          '23505',
        );
      });
    });

    it('9. unlink is a soft UPDATE (deleted_at), not a hard DELETE; the row remains for audit', async () => {
      await tenantA(async () => {
        const upd = await app.query(
          `update student_guardians set deleted_at = now()
           where tenant_id = '${uid.tenantA}' and student_id = '${uid.studentA}' and guardian_id = '${uid.guardianA}'`,
        );
        expect(upd.rowCount).toBe(1);
      });

      // App-shaped live-link query no longer surfaces it.
      const live = await tenantA(async () => {
        const r = await appQ<{ n: number }>(`
          select count(*)::int n from student_guardians
          where tenant_id = '${uid.tenantA}' and student_id = '${uid.studentA}' and deleted_at is null`);
        return Number(r[0]!.n);
      });
      expect(live).toBe(0);

      // Privileged executor still sees the historical row (audit preserved).
      const history = await migQ<{ n: number; deleted: boolean }>(`
        select count(*)::int n, bool_and(deleted_at is not null) deleted
        from student_guardians where id = '${uid.relA}'`);
      expect(Number(history[0]!.n)).toBe(1);
      expect(history[0]!.deleted).toBe(true);
    });

    it('10. the SAME (student, guardian, relation) can be re-linked once the old row is soft-unlinked', async () => {
      const created = await tenantA(async () => {
        const ins = await app.query(
          `insert into student_guardians (id, tenant_id, student_id, guardian_id, relation, is_primary, can_pickup)
           values ('${randomUUID()}', '${uid.tenantA}', '${uid.studentA}', '${uid.guardianA}', 'parent', true, true)`,
        );
        return ins.rowCount;
      });
      expect(created).toBe(1);

      const live = await tenantA(async () => {
        const r = await appQ<{ n: number }>(`
          select count(*)::int n from student_guardians
          where tenant_id = '${uid.tenantA}' and student_id = '${uid.studentA}' and deleted_at is null`);
        return Number(r[0]!.n);
      });
      expect(live).toBe(1);
    });

    it('11. re-link again after the second unlink and assert two historical + one live row', async () => {
      await tenantA(async () => {
        await app.query(
          `update student_guardians set deleted_at = now()
           where tenant_id = '${uid.tenantA}' and student_id = '${uid.studentA}' and guardian_id = '${uid.guardianA}' and deleted_at is null`,
        );
        const ins = await app.query(
          `insert into student_guardians (id, tenant_id, student_id, guardian_id, relation)
           values ('${randomUUID()}', '${uid.tenantA}', '${uid.studentA}', '${uid.guardianA}', 'parent')`,
        );
        expect(ins.rowCount).toBe(1);
      });

      const history = await migQ<{ n: number; live: number }>(`
        select count(*)::int n,
               count(*) filter (where deleted_at is null)::int live
        from student_guardians
        where tenant_id = '${uid.tenantA}' and student_id = '${uid.studentA}' and guardian_id = '${uid.guardianA}'`);
      expect(Number(history[0]!.n)).toBeGreaterThanOrEqual(3);
      expect(Number(history[0]!.live)).toBe(1);
    });
  });
});