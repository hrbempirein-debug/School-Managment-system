import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { getEnv } from '@sms/config';

/**
 * Phase 3.3 enrollment + promotion lifecycle DB integrity + concurrency proofs,
 * run against the REAL roles and REAL disposable test database (school_app_rw -> school_saas_test).
 * Requires migrations 0001..0006.
 *
 * Proves the constraint layer the API lifecycle depends on:
 *   A. guarded-transition single-winner: two concurrent applicant->active flips
 *      yield exactly one winner and the loser sees zero rows (READ COMMITTED
 *      re-evaluation), so the API's enroll/transfer/graduate actions are race-safe
 *      even before business logic checks anything.
 *   B. enrollments_student_year_uq is a LIVE-row-only unique guard: a second live
 *      enrollment for (student, year) is 23505, while a soft-deleted history row
 *      does NOT collide, so a student can be re-enrolled after an un-enrollment.
 *   C. promotion_items_batch_student_uq forbids the same student twice in one batch
 *      but allows the student across different batches.
 *   D. CHECK bounds: enrollment status, promotion batch status, promotion item
 *      status, and promotion_batches_distinct_years_ck reject out-of-set values.
 *   E. composite tenant-aware FKs reject foreign-tenant parents for enrollments,
 *      promotion batches (from/to years) and promotion items (batch, student, years).
 *
 * Opt-in: RUN_RUNTIME_SECURITY_TESTS=1 (requires PostgreSQL + migrations 0001..0006).
 */
const enabled = process.env.RUN_RUNTIME_SECURITY_TESTS === '1';
const describeDb = enabled ? describe : describe.skip;

describeDb('enrollment lifecycle: guarded transitions + unique/CHECK/composite-FK proofs (school_saas_test)', () => {
  let migrator: pg.Client;
  let app: pg.Client;
  const uid: Record<string, string> = {};
  const slug = 'el' + randomUUID().slice(0, 8);

  const appQ = <T extends pg.QueryResultRow = pg.QueryResultRow>(
    sqlText: string,
  ): Promise<T[]> => app.query<T>(sqlText).then((r) => r.rows);
  const migQ = <T extends pg.QueryResultRow = pg.QueryResultRow>(
    sqlText: string,
  ): Promise<T[]> => migrator.query<T>(sqlText).then((r) => r.rows);

  /** App-role error occurs inside a rolled-back savepoint so the session stays usable. */
  const rejectCode = async (
    fn: () => Promise<unknown>,
    code: string,
    constraint?: string,
  ): Promise<void> => {
    await app.query('savepoint sp');
    const caught = await fn().catch((err: pg.DatabaseError) => err);
    await app.query('rollback to savepoint sp');
    expect(caught).toBeInstanceOf(Error);
    expect((caught as pg.DatabaseError).code).toBe(code);
    if (constraint) expect((caught as pg.DatabaseError).constraint).toBe(constraint);
  };

  /** Run under a signed tenant-A context inside a rolled-back transaction. */
  async function tenantA<T>(fn: () => Promise<T>): Promise<T> {
    const tkt = (await appQ(
      `select app_ctx_mint('tenant', '${uid.userA}', '${uid.tenantA}') t`,
    ))[0]!.t as string;
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

    uid.userA = randomUUID();
    uid.userB = randomUUID();
    uid.tenantA = randomUUID();
    uid.tenantB = randomUUID();
    uid.campusA = randomUUID();
    uid.campusB = randomUUID();
    uid.yearA = randomUUID();
    uid.yearA2 = randomUUID();
    uid.yearB = randomUUID();
    uid.studentA = randomUUID(); // applicant
    uid.studentB = randomUUID(); // active
    uid.studentC = randomUUID(); // applicant
    uid.studentForeign = randomUUID(); // tenant B -> used for composite-FK rejection
    uid.enrollAB = randomUUID(); // studentB enrolled in yearA (active)

    await migrator.query('begin');
    await migrator.query(
      `insert into tenants (id, slug, name) values
         ('${uid.tenantA}', '${slug}-a', 'Lifecycle A'),
         ('${uid.tenantB}', '${slug}-b', 'Lifecycle B')`,
    );
    await migrator.query(
      `insert into users (id, email) values
         ('${uid.userA}', 'el-a-${slug}@example.com'),
         ('${uid.userB}', 'el-b-${slug}@example.com')`,
    );
    await migrator.query(
      `insert into memberships (id, tenant_id, user_id, status) values
         ('${randomUUID()}', '${uid.tenantA}', '${uid.userA}', 'active'),
         ('${randomUUID()}', '${uid.tenantB}', '${uid.userB}', 'active')`,
    );
    await migrator.query(
      `insert into campuses (id, tenant_id, code, name, status) values
         ('${uid.campusA}', '${uid.tenantA}', 'el-ca-${slug}', 'Campus A', 'active'),
         ('${uid.campusB}', '${uid.tenantB}', 'el-cb-${slug}', 'Campus B', 'active')`,
    );
    await migrator.query(
      `insert into academic_years (id, tenant_id, code, name, starts_on, ends_on, status) values
         ('${uid.yearA}', '${uid.tenantA}', 'el-ya-${slug}', 'AY 2026 A', '2026-01-01', '2026-12-31', 'active'),
         ('${uid.yearA2}', '${uid.tenantA}', 'el-ya2-${slug}', 'AY 2027 A', '2027-01-01', '2027-12-31', 'draft'),
         ('${uid.yearB}', '${uid.tenantB}', 'el-yb-${slug}', 'AY 2026 B', '2026-01-01', '2026-12-31', 'active')`,
    );
    await migrator.query(
      `insert into students (id, tenant_id, student_no, first_name, last_name, status, primary_campus_id) values
         ('${uid.studentA}', '${uid.tenantA}', 'el-sa-${slug}', 'Alice', 'Alpha', 'applicant', '${uid.campusA}'),
         ('${uid.studentB}', '${uid.tenantA}', 'el-sb-${slug}', 'Bob', 'Beta', 'active', '${uid.campusA}'),
         ('${uid.studentC}', '${uid.tenantA}', 'el-sc-${slug}', 'Carol', 'Gamma', 'applicant', '${uid.campusA}')`,
    );
    await migrator.query(
      `insert into students (id, tenant_id, student_no, first_name, last_name, status, primary_campus_id) values
         ('${uid.studentForeign}', '${uid.tenantB}', 'el-sf-${slug}', 'Zoe', 'Zeta', 'active', '${uid.campusB}')`,
    );
    await migrator.query(
      `insert into enrollments (id, tenant_id, student_id, academic_year_id, status) values
         ('${uid.enrollAB}', '${uid.tenantA}', '${uid.studentB}', '${uid.yearA}', 'active')`,
    );
    await migrator.query('commit');
  });

  afterAll(async () => {
    try {
      await migrator.query('begin');
      const tenantIds = `'${uid.tenantA}','${uid.tenantB}'`;
      await migrator.query(`delete from promotion_items where tenant_id in (${tenantIds})`);
      await migrator.query(`delete from promotion_batches where tenant_id in (${tenantIds})`);
      await migrator.query(`delete from transfers where tenant_id in (${tenantIds})`);
      await migrator.query(`delete from enrollments where tenant_id in (${tenantIds})`);
      await migrator.query(`delete from students where tenant_id in (${tenantIds})`);
      await migrator.query(`delete from academic_years where tenant_id in (${tenantIds})`);
      await migrator.query(`delete from campuses where tenant_id in (${tenantIds})`);
      await migrator.query(`delete from memberships where tenant_id in (${tenantIds})`);
      await migrator.query(`delete from users where id in ('${uid.userA}','${uid.userB}')`);
      await migrator.query(`delete from tenants where id in (${tenantIds})`);
      await migrator.query('commit');
    } finally {
      await migrator.end();
      await app.end();
    }
  });

  describe('A. guarded transitions are single-winner under concurrency', () => {
    it('1. two concurrent applicant->active flips produce exactly one winner (READ COMMITTED re-evaluation)', async () => {
      const tkt = (await appQ(
        `select app_ctx_mint('tenant', '${uid.userA}', '${uid.tenantA}') t`,
      ))[0]!.t as string;
      const c1 = new pg.Client({ connectionString: getEnv().DATABASE_URL_APP });
      const c2 = new pg.Client({ connectionString: getEnv().DATABASE_URL_APP });
      const wins: Array<string> = [];
      await c1.connect();
      await c2.connect();
      try {
        await c1.query('begin');
        await c2.query('begin');
        await c1.query(`set local app.rls = '${tkt}'`);
        await c2.query(`set local app.rls = '${tkt}'`);
        const guarded =
          `update students set status = 'active' ` +
          `where tenant_id = '${uid.tenantA}' and id = '${uid.studentC}' and status = 'applicant' ` +
          `returning id`;
        const p1 = c1.query<{ id: string }>(guarded).then((r) => {
          wins.push('c1');
          return r;
        });
        const p2 = c2.query<{ id: string }>(guarded).then((r) => {
          wins.push('c2');
          return r;
        });
        // WHICH update wins the row lock is nondeterministic; fire both, let the
        // first lock-holder return, and COMMIT it BEFORE awaiting the loser so the
        // loser's blocked UPDATE can re-evaluate the predicate on the new
        // (now-'active') row version and match nothing.
        const winnerIndex = await Promise.race([
          p1.then(() => 0 as const),
          p2.then(() => 1 as const),
        ]);
        const winner = [c1, c2][winnerIndex]!;
        const loser = [c1, c2][1 - winnerIndex]!;
        const winnerP = [p1, p2][winnerIndex]!;
        const loserP = [p1, p2][1 - winnerIndex]!;
        await winner.query('commit');
        const [w, l] = [await winnerP, await loserP];
        await loser.query('commit');
        expect(w.rowCount! + l.rowCount!).toBe(1);
        expect(wins.length).toBe(2);
      } finally {
        await Promise.all([c1.end(), c2.end()]);
      }
      const status = (await migQ<{ s: string }>(
        `select status s from students where id = '${uid.studentC}'`,
      ))[0]!.s;
      expect(status).toBe('active');

      // The very same predicate now matches zero rows even for a single session.
      await tenantA(async () => {
        const r = await app.query(
          `update students set status = 'active' where id = '${uid.studentC}' and status = 'applicant' returning id`,
        );
        expect(r.rowCount).toBe(0);
      });

      await migQ(
        `update students set status = 'applicant' where id = '${uid.studentC}'`,
      );
    }, 30_000);

    it('2. transfer and graduate guards only match ACTIVE rows (applicant cannot skip stages)', async () => {
      await tenantA(async () => {
        const transferApplicant = await app.query(
          `update students set status = 'transferred'
           where tenant_id = '${uid.tenantA}' and id = '${uid.studentA}' and status = 'active' returning id`,
        );
        expect(transferApplicant.rowCount).toBe(0);

        const gradeApplicant = await app.query(
          `update students set status = 'graduated'
           where tenant_id = '${uid.tenantA}' and id = '${uid.studentA}' and status = 'active' returning id`,
        );
        expect(gradeApplicant.rowCount).toBe(0);

        expect((await appQ<{ s: string }>(
          `select status s from students where id = '${uid.studentA}'`,
        ))[0]!.s).toBe('applicant');
      });
    });
  });

  describe('B. enrollment uniqueness is live-row-only', () => {
    it('3. a second live enrollment for (student, academic_year) is 23505 enrollments_student_year_uq', async () => {
      await tenantA(async () => {
        await rejectCode(
          () =>
            app.query(
              `insert into enrollments (id, tenant_id, student_id, academic_year_id, status)
               values ('${randomUUID()}', '${uid.tenantA}', '${uid.studentB}', '${uid.yearA}', 'active')`,
            ),
          '23505',
          'enrollments_student_year_uq',
        );
      });
    });

    it('4. the same (student, year) is allowed across DIFFERENT academic years', async () => {
      await tenantA(async () => {
        const r = await app.query<{ id: string }>(
          `insert into enrollments (id, tenant_id, student_id, academic_year_id, status)
           values ('${randomUUID()}', '${uid.tenantA}', '${uid.studentB}', '${uid.yearA2}', 'active')
           returning id`,
        );
        expect(r.rowCount).toBe(1);
      });
    });

    it('5. soft-deleting an enrollment releases the key so a live re-enroll succeeds (0006-style forward-only)', async () => {
      await tenantA(async () => {
        await app.query(
          `update enrollments set deleted_at = now()
           where tenant_id = '${uid.tenantA}' and id = '${uid.enrollAB}'`,
        );
        const re = await app.query<{ id: string }>(
          `insert into enrollments (id, tenant_id, student_id, academic_year_id, status)
           values ('${randomUUID()}', '${uid.tenantA}', '${uid.studentB}', '${uid.yearA}', 'active')
           returning id`,
        );
        expect(re.rowCount).toBe(1);
      });
    });
  });

  describe('C. promotion item uniqueness', () => {
    it('6. a student may appear in ONE batch (promotion_items_batch_student_uq) but across many batches', async () => {
      await tenantA(async () => {
        const batch1 = randomUUID();
        const batch2 = randomUUID();
        await app.query(
          `insert into promotion_batches (id, tenant_id, from_academic_year_id, to_academic_year_id, status)
           values ('${batch1}', '${uid.tenantA}', '${uid.yearA}', '${uid.yearA2}', 'draft'),
                  ('${batch2}', '${uid.tenantA}', '${uid.yearA}', '${uid.yearA2}', 'draft')`,
        );
        const r = await app.query<{ id: string }>(
          `insert into promotion_items (id, tenant_id, batch_id, student_id, from_academic_year_id, to_academic_year_id, status)
           values ('${randomUUID()}', '${uid.tenantA}', '${batch1}', '${uid.studentB}', '${uid.yearA}', '${uid.yearA2}', 'pending')`,
        );
        expect(r.rowCount).toBe(1);

        await rejectCode(
          () =>
            app.query(
              `insert into promotion_items (id, tenant_id, batch_id, student_id, from_academic_year_id, to_academic_year_id, status)
               values ('${randomUUID()}', '${uid.tenantA}', '${batch1}', '${uid.studentB}', '${uid.yearA}', '${uid.yearA2}', 'pending')`,
            ),
          '23505',
          'promotion_items_batch_student_uq',
        );

        // Same student in a DIFFERENT batch is fine.
        const other = await app.query<{ id: string }>(
          `insert into promotion_items (id, tenant_id, batch_id, student_id, from_academic_year_id, to_academic_year_id, status)
           values ('${randomUUID()}', '${uid.tenantA}', '${batch2}', '${uid.studentB}', '${uid.yearA}', '${uid.yearA2}', 'pending')`,
        );
        expect(other.rowCount).toBe(1);
      });
    });
  });

  describe('D. CHECK bounds + distinct-year rule', () => {
    it('7. invalid status values and same from/to year are rejected as 23514', async () => {
      await tenantA(async () => {
        await rejectCode(
          () =>
            app.query(
              `insert into enrollments (id, tenant_id, student_id, academic_year_id, status)
               values ('${randomUUID()}', '${uid.tenantA}', '${uid.studentB}', '${uid.yearA2}', 'flunked')`,
            ),
          '23514',
          'enrollments_status_ck',
        );
        const batch = randomUUID();
        await rejectCode(
          () =>
            app.query(
              `insert into promotion_batches (id, tenant_id, from_academic_year_id, to_academic_year_id, status)
               values ('${batch}', '${uid.tenantA}', '${uid.yearA}', '${uid.yearA}', 'draft')`,
            ),
          '23514',
          'promotion_batches_distinct_years_ck',
        );
        await app.query(
          `insert into promotion_batches (id, tenant_id, from_academic_year_id, to_academic_year_id, status)
           values ('${batch}', '${uid.tenantA}', '${uid.yearA}', '${uid.yearA2}', 'completed')`,
        );
        await rejectCode(
          () =>
            app.query(
              `insert into promotion_items (id, tenant_id, batch_id, student_id, from_academic_year_id, to_academic_year_id, status)
               values ('${randomUUID()}', '${uid.tenantA}', '${batch}', '${uid.studentB}', '${uid.yearA}', '${uid.yearA2}', 'queued')`,
            ),
          '23514',
          'promotion_items_status_ck',
        );
      });
    });
  });

  describe('E. composite tenant-aware FKs', () => {
    it('8. enrollments/batches/items reject foreign-tenant parents', async () => {
      await tenantA(async () => {
        await rejectCode(
          () =>
            app.query(
              `insert into enrollments (id, tenant_id, student_id, academic_year_id)
               values ('${randomUUID()}', '${uid.tenantA}', '${uid.studentB}', '${uid.yearB}')`,
            ),
          '23503',
        );
        await rejectCode(
          () =>
            app.query(
              `insert into promotion_batches (id, tenant_id, from_academic_year_id, to_academic_year_id)
               values ('${randomUUID()}', '${uid.tenantA}', '${uid.yearA}', '${uid.yearB}')`,
            ),
          '23503',
        );
        const batch = randomUUID();
        await app.query(
          `insert into promotion_batches (id, tenant_id, from_academic_year_id, to_academic_year_id, status)
           values ('${batch}', '${uid.tenantA}', '${uid.yearA}', '${uid.yearA2}', 'draft')`,
        );
        // foreign-tenant student on an otherwise-valid batch
        await rejectCode(
          () =>
            app.query(
              `insert into promotion_items (id, tenant_id, batch_id, student_id, from_academic_year_id, to_academic_year_id)
               values ('${randomUUID()}', '${uid.tenantA}', '${batch}', '${uid.studentForeign}', '${uid.yearA}', '${uid.yearA2}')`,
            ),
          '23503',
        );
      });
    });
  });
});