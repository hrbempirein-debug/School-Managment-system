import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { getEnv } from '@sms/config';

/**
 * Phase 4.1 DB security + placement-integrity proofs, run against the REAL
 * roles + disposable test database (school_app_rw -> school_saas_test). Requires migration
 * 0008 (acd_classes, sections, enrollments placement wiring + triggers).
 *
 * Section A (row-level security): acd_classes + sections are FORCE RLS; a bare
 * app_rw session sees nothing; a signed tenant context sees only its own rows;
 * cross-tenant inserts/composite-FK parents are rejected; the runtime role has
 * no DELETE path; the legacy forgeable GUCs grant nothing.
 *
 * Section B (placement integrity): unplaced (NULL/NULL) stays valid; placing
 * requires a LIVE, ACTIVE class whose year matches the enrollment year; a
 * section must belong to the class, be live and active and can never carry a
 * campus/year different from its class (composite-FK pinned); a placed student
 * must be active and (when campus-set) on the same campus as the class; a
 * non-active enrollment cannot be placed; roll_no uniqueness within a section
 * is enforced among ACTIVE placed enrollments; soft-delete guards refuse
 * deleting a class with live sections/enrollments and a section with live
 * enrollments.
 *
 * Opt-in: RUN_RUNTIME_SECURITY_TESTS=1 (requires PostgreSQL + migration 0008).
 */
const enabled = process.env.RUN_RUNTIME_SECURITY_TESTS === '1';
const describeDb = enabled ? describe : describe.skip;

const NEW_TABLES = ['acd_classes', 'sections'];

describeDb('Phase 4.1 RLS + placement integrity (classes/sections on school_saas_test)', () => {
  let migrator: pg.Client;
  let app: pg.Client;
  const uid: Record<string, string> = {};
  const slug = 'p4' + randomUUID().slice(0, 8);

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
    uid.campusA2 = randomUUID();
    uid.campusB = randomUUID();
    uid.yearA = randomUUID();
    uid.yearA2 = randomUUID();
    uid.yearB = randomUUID();
    uid.studentA = randomUUID();
    uid.studentA2 = randomUUID();
    uid.studentInactive = randomUUID();
    uid.studentW = randomUUID();
    uid.enrollA = randomUUID();
    uid.enrollA2 = randomUUID();
    uid.enrollInactive = randomUUID();
    uid.enrollW = randomUUID();
    uid.classA1 = randomUUID();
    uid.classA2 = randomUUID();
    uid.classInactive = randomUUID();
    uid.classOtherYear = randomUUID();
    uid.classEmpty = randomUUID();
    uid.classEnrollOnly = randomUUID();
    uid.classDeleted = randomUUID();
    uid.classB = randomUUID();
    uid.sectionA1 = randomUUID();
    uid.sectionA1B = randomUUID();
    uid.sectionA2 = randomUUID();
    uid.sectionInactive = randomUUID();
    uid.sectionEmpty = randomUUID();

    await migrator.query('begin');
    await migrator.query(
      `insert into tenants (id, slug, name) values
         ('${uid.tenantA}', '${slug}-a', 'Placement A'),
         ('${uid.tenantB}', '${slug}-b', 'Placement B')`,
    );
    await migrator.query(
      `insert into users (id, email) values
         ('${uid.userA}', 'p4-a-${slug}@example.com'),
         ('${uid.userB}', 'p4-b-${slug}@example.com')`,
    );
    await migrator.query(
      `insert into memberships (id, tenant_id, user_id, status) values
         ('${randomUUID()}', '${uid.tenantA}', '${uid.userA}', 'active'),
         ('${randomUUID()}', '${uid.tenantB}', '${uid.userB}', 'active')`,
    );
    await migrator.query(
      `insert into campuses (id, tenant_id, code, name, status) values
         ('${uid.campusA}', '${uid.tenantA}', 'ca-${slug}', 'Campus A', 'active'),
         ('${uid.campusA2}', '${uid.tenantA}', 'ca2-${slug}', 'Campus A2', 'active'),
         ('${uid.campusB}', '${uid.tenantB}', 'cb-${slug}', 'Campus B', 'active')`,
    );
    await migrator.query(
      `insert into academic_years (id, tenant_id, code, name, starts_on, ends_on, status) values
         ('${uid.yearA}', '${uid.tenantA}', 'ya-${slug}', 'AY 2026', '2026-01-01', '2026-12-31', 'draft'),
         ('${uid.yearA2}', '${uid.tenantA}', 'ya2-${slug}', 'AY 2027', '2027-01-01', '2027-12-31', 'draft'),
         ('${uid.yearB}', '${uid.tenantB}', 'yb-${slug}', 'AY 2026 B', '2026-01-01', '2026-12-31', 'draft')`,
    );
    // Students: A + A2 active on campusA, Inactive is an applicant on campusA.
    await migrator.query(
      `insert into students (id, tenant_id, student_no, first_name, last_name, primary_campus_id, status) values
         ('${uid.studentA}', '${uid.tenantA}', 'p4a-${slug}', 'Alice', 'A', '${uid.campusA}', 'active'),
         ('${uid.studentA2}', '${uid.tenantA}', 'p4a2-${slug}', 'Abel', 'A2', '${uid.campusA}', 'active'),
         ('${uid.studentInactive}', '${uid.tenantA}', 'p4x-${slug}', 'Axl', 'X', '${uid.campusA}', 'applicant'),
         ('${uid.studentW}', '${uid.tenantA}', 'p4w-${slug}', 'Wendy', 'W', '${uid.campusA}', 'active')`,
    );
    // Unplaced active enrollments (student A/A2/W -> year A, studentInactive -> year A).
    await migrator.query(
      `insert into enrollments (id, tenant_id, student_id, academic_year_id, status) values
         ('${uid.enrollA}', '${uid.tenantA}', '${uid.studentA}', '${uid.yearA}', 'active'),
         ('${uid.enrollA2}', '${uid.tenantA}', '${uid.studentA2}', '${uid.yearA}', 'active'),
         ('${uid.enrollInactive}', '${uid.tenantA}', '${uid.studentInactive}', '${uid.yearA}', 'active'),
         ('${uid.enrollW}', '${uid.tenantA}', '${uid.studentW}', '${uid.yearA}', 'active')`,
    );
    // Classes: A1/A2 live on campusA; Inactive on campusA; OtherYear on yearA2;
    // Empty live class (soft-delete positive control); Deleted (soft-deleted);
    // B on tenantB.
    await migrator.query(
      `insert into acd_classes (id, tenant_id, campus_id, academic_year_id, code, name, status) values
         ('${uid.classA1}', '${uid.tenantA}', '${uid.campusA}', '${uid.yearA}', 'c1-${slug}', 'Class One', 'active'),
         ('${uid.classA2}', '${uid.tenantA}', '${uid.campusA}', '${uid.yearA}', 'c2-${slug}', 'Class Two', 'active'),
         ('${uid.classInactive}', '${uid.tenantA}', '${uid.campusA}', '${uid.yearA}', 'ci-${slug}', 'Class Inactive', 'inactive'),
         ('${uid.classOtherYear}', '${uid.tenantA}', '${uid.campusA}', '${uid.yearA2}', 'cy-${slug}', 'Other Year', 'active'),
         ('${uid.classEmpty}', '${uid.tenantA}', '${uid.campusA}', '${uid.yearA}', 'ce-${slug}', 'Empty', 'active'),
         ('${uid.classEnrollOnly}', '${uid.tenantA}', '${uid.campusA}', '${uid.yearA}', 'cn-${slug}', 'Enroll Only', 'active'),
         ('${uid.classDeleted}', '${uid.tenantA}', '${uid.campusA}', '${uid.yearA}', 'cd-${slug}', 'Deleted', 'active'),
         ('${uid.classB}', '${uid.tenantB}', '${uid.campusB}', '${uid.yearB}', 'cb-${slug}', 'Class B', 'active')`,
    );
    await migrator.query(
      `update acd_classes set deleted_at = now() where id = '${uid.classDeleted}'`,
    );
    // Sections: A1 belongs to classA1 (campusA/yearA); A1B second section of
    // classA1; A2 belongs to classA2; Inactive inactive section of classA1;
    // Empty live section of classEmpty.
    await migrator.query(
      `insert into sections (id, tenant_id, class_id, campus_id, academic_year_id, code, status) values
         ('${uid.sectionA1}', '${uid.tenantA}', '${uid.classA1}', '${uid.campusA}', '${uid.yearA}', 'A-${slug}', 'active'),
         ('${uid.sectionA1B}', '${uid.tenantA}', '${uid.classA1}', '${uid.campusA}', '${uid.yearA}', 'B-${slug}', 'active'),
         ('${uid.sectionA2}', '${uid.tenantA}', '${uid.classA2}', '${uid.campusA}', '${uid.yearA}', 'A-${slug}', 'active'),
         ('${uid.sectionInactive}', '${uid.tenantA}', '${uid.classA1}', '${uid.campusA}', '${uid.yearA}', 'I-${slug}', 'inactive'),
         ('${uid.sectionEmpty}', '${uid.tenantA}', '${uid.classEmpty}', '${uid.campusA}', '${uid.yearA}', 'E-${slug}', 'active')`,
    );
    // Give classB a live section (needs a tenantB section id).
    uid.sectionB = randomUUID();
    await migrator.query(
      `insert into sections (id, tenant_id, class_id, campus_id, academic_year_id, code, status)
       values ('${uid.sectionB}', '${uid.tenantB}', '${uid.classB}', '${uid.campusB}', '${uid.yearB}', 'A-${slug}', 'active')`,
    );
    await migrator.query('commit');
  });

  afterAll(async () => {
    try {
      await migrator.query('begin');
      const tenantIds = `'${uid.tenantA}','${uid.tenantB}'`;
      await migrator.query(
        `delete from enrollments where tenant_id in (${tenantIds})`,
      );
      await migrator.query(`delete from sections where tenant_id in (${tenantIds})`);
      await migrator.query(`delete from acd_classes where tenant_id in (${tenantIds})`);
      await migrator.query(`delete from students where tenant_id in (${tenantIds})`);
      await migrator.query(`delete from academic_years where tenant_id in (${tenantIds})`);
      await migrator.query(`delete from campuses where tenant_id in (${tenantIds})`);
      await migrator.query(`delete from memberships where tenant_id in (${tenantIds})`);
      await migrator.query(`delete from users where id in ('${uid.userA}','${uid.userB}')`);
      await migrator.query(`delete from outbox_events where tenant_id in (${tenantIds})`);
      await migrator.query(`delete from tenants where id in (${tenantIds})`);
      await migrator.query('commit');
    } finally {
      await migrator.end();
      await app.end();
    }
  });

  describe('A. row-level security boundary', () => {
    it('1. RLS is enabled AND forced on acd_classes and sections', async () => {
      const res = await migrator.query<{ tbl: string; rls: boolean; force: boolean }>(
        `
        select c.relname tbl, c.relrowsecurity rls, c.relforcerowsecurity force
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname = ANY($1)
        order by c.relname`,
        [NEW_TABLES],
      );
      expect(res.rows).toHaveLength(NEW_TABLES.length);
      for (const row of res.rows) {
        expect(row.rls).toBe(true);
        expect(row.force).toBe(true);
      }
    });

    it('2. school_app_rw holds DML grants but sees zero rows without a context', async () => {
      const g = await migQ<{ s: boolean; i: boolean; u: boolean; d: boolean }>(`
        select has_table_privilege('school_app_rw', 'acd_classes', 'SELECT') s,
               has_table_privilege('school_app_rw', 'acd_classes', 'INSERT') i,
               has_table_privilege('school_app_rw', 'acd_classes', 'UPDATE') u,
               has_table_privilege('school_app_rw', 'acd_classes', 'DELETE') d`);
      expect(g[0]).toEqual({ s: true, i: true, u: true, d: true });
      for (const t of NEW_TABLES) {
        const r = await appQ<{ n: number }>(`select count(*)::int n from "${t}"`);
        expect(Number(r[0]!.n), t).toBe(0);
      }
    });

    it('3. tenant A context sees its own rows, never tenant B', async () => {
      await tenantA(async () => {
        for (const t of NEW_TABLES) {
          const own = (await appQ<{ n: number }>(
            `select count(*)::int n from "${t}" where tenant_id = '${uid.tenantA}'`,
          ))[0]!.n;
          const foreign = (await appQ<{ n: number }>(
            `select count(*)::int n from "${t}" where tenant_id = '${uid.tenantB}'`,
          ))[0]!.n;
          expect(Number(own), t).toBeGreaterThan(0);
          expect(Number(foreign), t).toBe(0);
        }
      });
    });

    it('4. cross-tenant INSERT is rejected on both new tables (RLS WITH CHECK)', async () => {
      await tenantA(async () => {
        await rejectCode(
          () =>
            app.query(
              `insert into acd_classes (id, tenant_id, campus_id, academic_year_id, code, name, status)
               values ('${randomUUID()}', '${uid.tenantB}', '${uid.campusB}', '${uid.yearB}', 'x-${slug}', 'X', 'active')`,
            ),
          '42501',
        );
        // sections has a BEFORE INSERT trigger (lifecycle validate) whose parent
        // lookup runs through the invoking role's RLS, so a foreign class is not
        // found and surfaces as 23503 first — either way the row is never written
        // (same pattern as academic_terms in school-domain.test.ts).
        await rejectCode(
          () =>
            app.query(
              `insert into sections (id, tenant_id, class_id, campus_id, academic_year_id, code, status)
               values ('${randomUUID()}', '${uid.tenantB}', '${uid.classB}', '${uid.campusB}', '${uid.yearB}', 'X-${slug}', 'active')`,
            ),
          '23503',
        );
      });
    });

    it('5. cross-tenant composite-FK parents are rejected', async () => {
      await tenantA(async () => {
        await rejectCode(
          () =>
            app.query(
              `insert into acd_classes (id, tenant_id, campus_id, academic_year_id, code, name, status)
               values ('${randomUUID()}', '${uid.tenantA}', '${uid.campusB}', '${uid.yearB}', 'xfk-${slug}', 'X', 'active')`,
            ),
          '23503',
        );
        await rejectCode(
          () =>
            app.query(
              `insert into sections (id, tenant_id, class_id, campus_id, academic_year_id, code, status)
               values ('${randomUUID()}', '${uid.tenantA}', '${uid.classA1}', '${uid.campusB}', '${uid.yearA}', 'xfk-${slug}', 'active')`,
            ),
          '23503',
        );
      });
    });

    it('6. the runtime role has no DELETE path (privileged-only policy)', async () => {
      await tenantA(async () => {
        for (const t of NEW_TABLES) {
          const del = await app.query(`delete from "${t}" where tenant_id = '${uid.tenantA}'`);
          expect(del.rowCount, t).toBe(0);
        }
      });
    });

    it('7. legacy forgeable GUCs grant nothing on the new tables', async () => {
      await app.query('begin');
      await app.query(`select set_config('app.platform_access', 'on', true)`);
      await app.query(`select set_config('app.current_tenant', '${uid.tenantA}', true)`);
      await app.query(`select set_config('app.current_user', '${uid.userA}', true)`);
      const r = await appQ<{ n: number }>(`select count(*)::int n from acd_classes`);
      await app.query('rollback');
      expect(Number(r[0]!.n)).toBe(0);
    });

    it('8. nested-query isolation: tenant B sections invisible via a tenant-A lookup', async () => {
      await tenantA(async () => {
        const ofB = await appQ<{ n: number }>(
          `select count(*)::int n from sections where class_id = '${uid.classB}'`,
        );
        expect(Number(ofB[0]!.n)).toBe(0);
        const ofA = await appQ<{ n: number }>(
          `select count(*)::int n from sections where class_id = '${uid.classA1}'`,
        );
        expect(Number(ofA[0]!.n)).toBeGreaterThan(0);
      });
    });
  });

  describe('B. placement integrity', () => {
    it('9. unplaced (NULL/NULL) enrollments stay valid', async () => {
      await tenantA(async () => {
        await app.query(
          `update enrollments set class_id = null, section_id = null where id = '${uid.enrollA}'`,
        );
        const unplaced = await appQ<{ n: number }>(
          `select count(*)::int n from enrollments
           where id = '${uid.enrollA}' and class_id is null and section_id is null`,
        );
        expect(Number(unplaced[0]!.n)).toBe(1);
      });
    });

    it('10. a valid placement into an active class+section succeeds', async () => {
      await tenantA(async () => {
        const ins = await app.query(
          `update enrollments set class_id = '${uid.classA1}', section_id = '${uid.sectionA1}', roll_no = 'RN-${slug}'
           where id = '${uid.enrollA}'`,
        );
        expect(ins.rowCount).toBe(1);
        const placed = await appQ<{ n: number }>(
          `select count(*)::int n from enrollments
           where id = '${uid.enrollA}' and class_id = '${uid.classA1}' and section_id = '${uid.sectionA1}'`,
        );
        expect(Number(placed[0]!.n)).toBe(1);
      });
    });

    it('11. placing into a soft-deleted class is refused (class not found)', async () => {
      await tenantA(async () => {
        await rejectCode(
          () =>
            app.query(
              `update enrollments set class_id = '${uid.classDeleted}', section_id = null
               where id = '${uid.enrollA2}'`,
            ),
          '23503',
          /class not found for enrollment/,
        );
      });
    });

    it('12. placing into an inactive class is refused', async () => {
      await tenantA(async () => {
        await rejectCode(
          () =>
            app.query(
              `update enrollments set class_id = '${uid.classInactive}', section_id = null
               where id = '${uid.enrollA2}'`,
            ),
          '55000',
          /class is not active/,
        );
      });
    });

    it('13. class year must equal the enrollment year', async () => {
      await tenantA(async () => {
        await rejectCode(
          () =>
            app.query(
              `update enrollments set class_id = '${uid.classOtherYear}', section_id = null
               where id = '${uid.enrollA2}'`,
            ),
          '55000',
          /class academic year mismatch/,
        );
      });
    });

    it('14. a section without a class is refused', async () => {
      await tenantA(async () => {
        await rejectCode(
          () =>
            app.query(
              `update enrollments set class_id = null, section_id = '${uid.sectionA1}'
               where id = '${uid.enrollA2}'`,
            ),
          '55000',
          /section requires a class/,
        );
      });
    });

    it('15. a cross-tenant placement target is refused (RLS-filtered lookup)', async () => {
      await tenantA(async () => {
        await rejectCode(
          () =>
            app.query(
              `update enrollments set class_id = '${uid.classB}', section_id = null
               where id = '${uid.enrollA2}'`,
            ),
          '23503',
          /class not found for enrollment/,
        );
      });
    });

    it('16. a section belonging to a different class is refused', async () => {
      await tenantA(async () => {
        await rejectCode(
          () =>
            app.query(
              `update enrollments set class_id = '${uid.classA1}', section_id = '${uid.sectionA2}'
               where id = '${uid.enrollA2}'`,
            ),
          '55000',
          /section belongs to a different class/,
        );
      });
    });

    it('17. an inactive section is refused', async () => {
      await tenantA(async () => {
        await rejectCode(
          () =>
            app.query(
              `update enrollments set class_id = '${uid.classA1}', section_id = '${uid.sectionInactive}'
               where id = '${uid.enrollA2}'`,
            ),
          '55000',
          /section is not active/,
        );
      });
    });

    it('18. a non-active student cannot be placed', async () => {
      await tenantA(async () => {
        await rejectCode(
          () =>
            app.query(
              `update enrollments set class_id = '${uid.classA1}', section_id = '${uid.sectionA1}'
               where id = '${uid.enrollInactive}'`,
            ),
          '55000',
          /cannot place into a non-active student/,
        );
      });
    });

    it('19. a non-active enrollment cannot be placed', async () => {
      await tenantA(async () => {
        await app.query(
          `update enrollments set status = 'withdrawn' where id = '${uid.enrollW}'`,
        );
        await rejectCode(
          () =>
            app.query(
              `update enrollments set class_id = '${uid.classA1}', section_id = '${uid.sectionA1}'
               where id = '${uid.enrollW}'`,
            ),
          '55000',
          /cannot place into a non-active enrollment/,
        );
      });
    });

    it('20. sections can never carry a campus/year different from their class', async () => {
      await tenantA(async () => {
        await rejectCode(
          () =>
            app.query(
              `insert into sections (id, tenant_id, class_id, campus_id, academic_year_id, code, status)
               values ('${randomUUID()}', '${uid.tenantA}', '${uid.classA1}', '${uid.campusA2}', '${uid.yearA}', 'drift-${slug}', 'active')`,
            ),
          '23503',
        );
        await rejectCode(
          () =>
            app.query(
              `insert into sections (id, tenant_id, class_id, campus_id, academic_year_id, code, status)
               values ('${randomUUID()}', '${uid.tenantA}', '${uid.classA1}', '${uid.campusA}', '${uid.yearA2}', 'drift2-${slug}', 'active')`,
            ),
          '23503',
        );
      });
    });

    it('21. sections may only be created under a LIVE class', async () => {
      await tenantA(async () => {
        await rejectCode(
          () =>
            app.query(
              `insert into sections (id, tenant_id, class_id, campus_id, academic_year_id, code, status)
               values ('${randomUUID()}', '${uid.tenantA}', '${uid.classDeleted}', '${uid.campusA}', '${uid.yearA}', 'dele-${slug}', 'active')`,
            ),
          '23503',
          /class not found for section/,
        );
      });
    });

    it('22. assigning a duplicate roll_no within a section is refused; cross-section reuse is fine', async () => {
      await tenantA(async () => {
        const dup = `RN-${slug}`;
        // Place enrollA in sectionA1 with the roll first (the harness rolls back
        // per test, so this must happen in the same transaction).
        await app.query(
          `update enrollments set class_id = '${uid.classA1}', section_id = '${uid.sectionA1}', roll_no = '${dup}'
           where id = '${uid.enrollA}'`,
        );
        // enrollA2 (active, unplaced) takes the same roll in the same section.
        await rejectCode(
          () =>
            app.query(
              `update enrollments set class_id = '${uid.classA1}', section_id = '${uid.sectionA1}', roll_no = '${dup}'
               where id = '${uid.enrollA2}'`,
            ),
          '23505',
        );
        // Same roll in a different section of the same class is allowed.
        const ok = await app.query(
          `update enrollments set class_id = '${uid.classA1}', section_id = '${uid.sectionA1B}', roll_no = '${dup}'
           where id = '${uid.enrollA2}'`,
        );
        expect(ok.rowCount).toBe(1);
      });
    });

    it('23. class code is unique within (tenant, campus, year) for live rows only', async () => {
      await tenantA(async () => {
        await rejectCode(
          () =>
            app.query(
              `insert into acd_classes (id, tenant_id, campus_id, academic_year_id, code, name)
               values ('${randomUUID()}', '${uid.tenantA}', '${uid.campusA}', '${uid.yearA}', 'c1-${slug}', 'Dup')`,
            ),
          '23505',
          /acd_classes_tenant_code_uq/,
        );
        // The same code in a different campus scopes fine.
        const ok = await app.query(
          `insert into acd_classes (id, tenant_id, campus_id, academic_year_id, code, name)
           values ('${randomUUID()}', '${uid.tenantA}', '${uid.campusA2}', '${uid.yearA}', 'c1-${slug}', 'Other Campus')`,
        );
        expect(ok.rowCount).toBe(1);
      });
    });

    it('24. section code is unique within its class; same code in another class is fine', async () => {
      await tenantA(async () => {
        await rejectCode(
          () =>
            app.query(
              `insert into sections (id, tenant_id, class_id, campus_id, academic_year_id, code)
               values ('${randomUUID()}', '${uid.tenantA}', '${uid.classA1}', '${uid.campusA}', '${uid.yearA}', 'A-${slug}')`,
            ),
          '23505',
          /sections_tenant_class_code_uq/,
        );
        // Code B exists in classA1; reusing it in classA2 is allowed.
        const ok = await app.query(
          `insert into sections (id, tenant_id, class_id, campus_id, academic_year_id, code)
           values ('${randomUUID()}', '${uid.tenantA}', '${uid.classA2}', '${uid.campusA}', '${uid.yearA}', 'B-${slug}')`,
        );
        expect(ok.rowCount).toBe(1);
      });
    });

    it('25. a class with live sections cannot be soft-deleted', async () => {
      await tenantA(async () => {
        await rejectCode(
          () =>
            app.query(
              `update acd_classes set deleted_at = now() where id = '${uid.classA1}'`,
            ),
          '55000',
          /cannot delete class with live sections/,
        );
      });
    });

    it('26. a class with live enrollments cannot be soft-deleted (no sections)', async () => {
      await tenantA(async () => {
        // Place enrollA into a class that has NO sections (class-only placement).
        await app.query(
          `update enrollments set class_id = '${uid.classEnrollOnly}', section_id = null
           where id = '${uid.enrollA}'`,
        );
        await rejectCode(
          () =>
            app.query(
              `update acd_classes set deleted_at = now() where id = '${uid.classEnrollOnly}'`,
            ),
          '55000',
          /cannot delete class with live enrollments/,
        );
      });
    });

    it('27. a section with live enrollments cannot be soft-deleted', async () => {
      await tenantA(async () => {
        // Place enrollA into sectionA1 first (per-test rollback means the
        // placement from another test is not visible here).
        await app.query(
          `update enrollments set class_id = '${uid.classA1}', section_id = '${uid.sectionA1}'
           where id = '${uid.enrollA}'`,
        );
        await rejectCode(
          () =>
            app.query(
              `update sections set deleted_at = now() where id = '${uid.sectionA1}'`,
            ),
          '55000',
          /cannot delete section with live enrollments/,
        );
      });
    });

    it('28. empty classes and sections CAN be soft-deleted, and codes can be reused', async () => {
      await tenantA(async () => {
        // sectionEmpty is the only live section of classEmpty: remove it first,
        // then the class itself becomes empty and deletable.
        const sec = await app.query(
          `update sections set deleted_at = now() where id = '${uid.sectionEmpty}'`,
        );
        expect(sec.rowCount).toBe(1);
        const cls = await app.query(
          `update acd_classes set deleted_at = now() where id = '${uid.classEmpty}'`,
        );
        expect(cls.rowCount).toBe(1);
        const reuse = await app.query(
          `insert into acd_classes (id, tenant_id, campus_id, academic_year_id, code, name)
           values ('${randomUUID()}', '${uid.tenantA}', '${uid.campusA}', '${uid.yearA}', 'ce-${slug}', 'Reused')`,
        );
        expect(reuse.rowCount).toBe(1);
      });
    });
  });
});