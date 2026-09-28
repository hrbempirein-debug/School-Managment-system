import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { getEnv } from '@sms/config';

/**
 * Phase 4.3 DB security + timetable/homework integrity proofs, run against the
 * REAL roles + disposable test database (school_app_rw -> school_saas_test). Requires
 * migrations 0011 (periods with gist exclusion, timetable_entries, homework,
 * homework_attachments, extended delete guards, RLS, permission backfill) and
 * the Phase 4.1/4.2 structure it builds on (0008/0009/0010).
 *
 * Section A (row-level security): all four new tables are FORCE RLS; a bare
 * app_rw session sees nothing; a signed tenant context sees only its own rows;
 * cross-tenant inserts are rejected by the WITH CHECK policy; the runtime role
 * has no hard DELETE path.
 *
 * Section B (periods): live period_no uniqueness per (tenant, campus); the gist
 * exclusion refuses overlapping time ranges within a tenant+campus while
 * allowing touching ranges and cross-tenant overlap; delete guard refuses a
 * period still referenced by live lessons.
 *
 * Section C (weekly grid): a section has one live lesson per (weekday, period)
 * (23505); a teacher can never be double-booked across sections on the same
 * weekday (55000 teacher_double_booked); lessons are refused when the subject is
 * not attached to the class or the row's teacher is not the assigned teacher
 * (55000), and cross-tenant parents fail the composite FKs (23503); soft-deleted
 * lessons free their slot; an assigned teacher cannot be unassigned while
 * scheduled (55000 assignment_has_schedule).
 *
 * Section D (homework + guards): only the assigned teacher can author (55000)
 * and only for an attached subject (55000); attachments are tenant-anchored
 * (cross-tenant attach -> 23503) and deduplicated (23505); section/period/class
 * delete guards refuse live references; the subject/class guards hold even after
 * privileged hard-delete of the intermediate link/assignment rows (orphan
 * proofing); a second tenant cannot see the first tenant's homework.
 *
 * Opt-in: RUN_RUNTIME_SECURITY_TESTS=1 (requires PostgreSQL + migrations 0008-0011).
 */
const enabled = process.env.RUN_RUNTIME_SECURITY_TESTS === '1';
const describeDb = enabled ? describe : describe.skip;

const NEW_TABLES = ['periods', 'timetable_entries', 'homework', 'homework_attachments'];

describeDb('Phase 4.3 RLS + timetable/homework integrity on school_saas_test', () => {
  let migrator: pg.Client;
  let app: pg.Client;
  const uid: Record<string, string> = {};
  const slug = 'p43' + randomUUID().slice(0, 8);

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
    const tkt = (await appQ(`select app_ctx_mint('tenant', '${uid.userA}', '${uid.tenantA}') t`))[
      0
    ]!.t as string;
    await app.query('begin');
    await app.query(`set local app.rls = '${tkt}'`);
    try {
      return await fn();
    } finally {
      await app.query('rollback').catch(() => {});
    }
  }

  async function tenantB<T>(fn: () => Promise<T>): Promise<T> {
    const tkt = (await appQ(`select app_ctx_mint('tenant', '${uid.userB}', '${uid.tenantB}') t`))[
      0
    ]!.t as string;
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
    uid.yearB = randomUUID();
    uid.levelA = randomUUID();
    uid.levelB = randomUUID();
    uid.teacherElig = randomUUID();
    uid.teacherTwo = randomUUID();
    uid.memberA = randomUUID();
    uid.memberB = randomUUID();
    uid.roleTeacherA = randomUUID();
    uid.roleTeacherB = randomUUID();
    uid.subjA = randomUUID();
    uid.subjA2 = randomUUID();
    uid.subjFree = randomUUID();
    uid.subjOrph = randomUUID();
    uid.subjB = randomUUID();
    uid.classA1 = randomUUID();
    uid.classA2 = randomUUID();
    uid.classOrph = randomUUID();
    uid.classB = randomUUID();
    uid.sectionA1 = randomUUID();
    uid.sectionA2 = randomUUID();
    uid.sectionOrph = randomUUID();
    uid.sectionB = randomUUID();
    uid.linkA = randomUUID();
    uid.linkA2 = randomUUID();
    uid.linkOrph = randomUUID();
    uid.linkB = randomUUID();
    uid.assignA = randomUUID();
    uid.assignA2 = randomUUID();
    uid.assignOrph = randomUUID();
    uid.periodA = randomUUID();
    uid.periodA2 = randomUUID();
    uid.periodB = randomUUID();
    uid.entryA = randomUUID();
    uid.entryOrph = randomUUID();
    uid.hwA = randomUUID();
    uid.hwOrph = randomUUID();
    uid.fileA = randomUUID();
    uid.fileB = randomUUID();
    uid.attachA = randomUUID();

    await migrator.query('begin');
    await migrator.query(
      `insert into tenants (id, slug, name) values
         ('${uid.tenantA}', '${slug}-a', 'Timetable A'),
         ('${uid.tenantB}', '${slug}-b', 'Timetable B')`,
    );
    await migrator.query(
      `insert into users (id, email) values
         ('${uid.userA}', 'p43-a-${slug}@example.com'),
         ('${uid.userB}', 'p43-b-${slug}@example.com'),
         ('${uid.teacherElig}', 'p43-te-${slug}@example.com'),
         ('${uid.teacherTwo}', 'p43-tt-${slug}@example.com')`,
    );
    await migrator.query(
      `insert into memberships (id, tenant_id, user_id, status) values
         ('${uid.memberA}', '${uid.tenantA}', '${uid.userA}', 'active'),
         ('${uid.memberB}', '${uid.tenantB}', '${uid.userB}', 'active'),
         ('${randomUUID()}', '${uid.tenantA}', '${uid.teacherElig}', 'active'),
         ('${randomUUID()}', '${uid.tenantA}', '${uid.teacherTwo}', 'active')`,
    );
    await migrator.query(
      `insert into user_profiles (user_id, full_name) values
         ('${uid.userA}', 'Caller A'), ('${uid.userB}', 'Caller B'),
         ('${uid.teacherElig}', 'Eligible Teacher'), ('${uid.teacherTwo}', 'Other Teacher')`,
    );
    await migrator.query(
      `insert into roles (id, tenant_id, scope, code, name, is_system) values
         ('${uid.roleTeacherA}', '${uid.tenantA}', 'tenant', 'teacher', 'Teacher', true),
         ('${uid.roleTeacherB}', '${uid.tenantB}', 'tenant', 'teacher', 'Teacher', true)`,
    );
    await migrator.query(
      `insert into membership_roles (membership_id, role_id) values
         ((select id from memberships where tenant_id = '${uid.tenantA}' and user_id = '${uid.teacherElig}'), '${uid.roleTeacherA}'),
         ((select id from memberships where tenant_id = '${uid.tenantA}' and user_id = '${uid.teacherTwo}'), '${uid.roleTeacherA}')`,
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
         ('${uid.yearB}', '${uid.tenantB}', 'yb-${slug}', 'AY 2026 B', '2026-01-01', '2026-12-31', 'draft')`,
    );
    await migrator.query(
      `insert into grade_levels (id, tenant_id, code, name, status) values
         ('${uid.levelA}', '${uid.tenantA}', 'gl-${slug}', 'Grade A', 'active'),
         ('${uid.levelB}', '${uid.tenantB}', 'gl-${slug}', 'Grade B', 'active')`,
    );
    await migrator.query(
      `insert into subjects (id, tenant_id, code, name, status) values
         ('${uid.subjA}', '${uid.tenantA}', 'sb-${slug}', 'Subject A', 'active'),
         ('${uid.subjA2}', '${uid.tenantA}', 'sb2-${slug}', 'Subject A2', 'active'),
         ('${uid.subjFree}', '${uid.tenantA}', 'sb3-${slug}', 'Unlinked Subject', 'active'),
         ('${uid.subjOrph}', '${uid.tenantA}', 'sb4-${slug}', 'Orphan Subject', 'active'),
         ('${uid.subjB}', '${uid.tenantB}', 'sb-${slug}', 'Subject B', 'active')`,
    );
    await migrator.query(
      `insert into acd_classes (id, tenant_id, campus_id, academic_year_id, grade_level_id, code, name, status) values
         ('${uid.classA1}', '${uid.tenantA}', '${uid.campusA}', '${uid.yearA}', '${uid.levelA}', 'c1-${slug}', 'Class One', 'active'),
         ('${uid.classA2}', '${uid.tenantA}', '${uid.campusA}', '${uid.yearA}', null, 'c2-${slug}', 'Class Two', 'active'),
         ('${uid.classOrph}', '${uid.tenantA}', '${uid.campusA}', '${uid.yearA}', null, 'co-${slug}', 'Class Orphan', 'active'),
         ('${uid.classB}', '${uid.tenantB}', '${uid.campusB}', '${uid.yearB}', null, 'cb-${slug}', 'Class B', 'active')`,
    );
    await migrator.query(
      `insert into sections (id, tenant_id, class_id, campus_id, academic_year_id, code, status) values
         ('${uid.sectionA1}', '${uid.tenantA}', '${uid.classA1}', '${uid.campusA}', '${uid.yearA}', 's1-${slug}', 'active'),
         ('${uid.sectionA2}', '${uid.tenantA}', '${uid.classA2}', '${uid.campusA}', '${uid.yearA}', 's2-${slug}', 'active'),
         ('${uid.sectionOrph}', '${uid.tenantA}', '${uid.classOrph}', '${uid.campusA}', '${uid.yearA}', 'so-${slug}', 'active'),
         ('${uid.sectionB}', '${uid.tenantB}', '${uid.classB}', '${uid.campusB}', '${uid.yearB}', 'sb-${slug}', 'active')`,
    );
    await migrator.query(
      `insert into class_subjects (id, tenant_id, class_id, subject_id, campus_id, academic_year_id) values
         ('${uid.linkA}', '${uid.tenantA}', '${uid.classA1}', '${uid.subjA}', '${uid.campusA}', '${uid.yearA}'),
         ('${uid.linkA2}', '${uid.tenantA}', '${uid.classA2}', '${uid.subjA2}', '${uid.campusA}', '${uid.yearA}'),
         ('${uid.linkOrph}', '${uid.tenantA}', '${uid.classOrph}', '${uid.subjOrph}', '${uid.campusA}', '${uid.yearA}'),
         ('${uid.linkB}', '${uid.tenantB}', '${uid.classB}', '${uid.subjB}', '${uid.campusB}', '${uid.yearB}')`,
    );
    await migrator.query(
      `insert into teacher_assignments (id, tenant_id, class_id, subject_id, teacher_user_id, campus_id, academic_year_id) values
         ('${uid.assignA}', '${uid.tenantA}', '${uid.classA1}', '${uid.subjA}', '${uid.teacherElig}', '${uid.campusA}', '${uid.yearA}'),
         ('${uid.assignA2}', '${uid.tenantA}', '${uid.classA2}', '${uid.subjA2}', '${uid.teacherElig}', '${uid.campusA}', '${uid.yearA}'),
         ('${uid.assignOrph}', '${uid.tenantA}', '${uid.classOrph}', '${uid.subjOrph}', '${uid.teacherElig}', '${uid.campusA}', '${uid.yearA}')`,
    );
    await migrator.query(
      `insert into periods (id, tenant_id, campus_id, name, period_no, start_time, end_time, status) values
         ('${uid.periodA}', '${uid.tenantA}', NULL, 'Period 1', 1, '08:00', '08:45', 'active'),
         ('${uid.periodA2}', '${uid.tenantA}', NULL, 'Period 2', 2, '08:45', '09:30', 'active'),
         ('${uid.periodB}', '${uid.tenantB}', NULL, 'Period 1 B', 1, '08:00', '08:45', 'active')`,
    );
    await migrator.query(
      `insert into timetable_entries (id, tenant_id, class_id, section_id, subject_id, teacher_user_id, period_id, campus_id, academic_year_id, weekday) values
         ('${uid.entryA}', '${uid.tenantA}', '${uid.classA1}', '${uid.sectionA1}', '${uid.subjA}', '${uid.teacherElig}', '${uid.periodA}', '${uid.campusA}', '${uid.yearA}', 1),
         ('${uid.entryOrph}', '${uid.tenantA}', '${uid.classOrph}', '${uid.sectionOrph}', '${uid.subjOrph}', '${uid.teacherElig}', '${uid.periodA2}', '${uid.campusA}', '${uid.yearA}', 1)`,
    );
    await migrator.query(
      `insert into homework (id, tenant_id, class_id, subject_id, teacher_user_id, campus_id, academic_year_id, title, body, due_at) values
         ('${uid.hwA}', '${uid.tenantA}', '${uid.classA1}', '${uid.subjA}', '${uid.teacherElig}', '${uid.campusA}', '${uid.yearA}', 'HW A', 'body a', '2026-06-01T12:00:00Z'),
         ('${uid.hwOrph}', '${uid.tenantA}', '${uid.classOrph}', '${uid.subjOrph}', '${uid.teacherElig}', '${uid.campusA}', '${uid.yearA}', 'HW Orph', 'body o', NULL)`,
    );
    await migrator.query(
      `insert into files (id, tenant_id, storage_key, original_name, mime, size_bytes, visibility, scan_status) values
         ('${uid.fileA}', '${uid.tenantA}', 'k-${uid.fileA}', 'a.pdf', 'application/pdf', 10, 'private', 'clean'),
         ('${uid.fileB}', '${uid.tenantB}', 'k-${uid.fileB}', 'b.pdf', 'application/pdf', 10, 'private', 'clean')`,
    );
    await migrator.query(
      `insert into homework_attachments (id, tenant_id, homework_id, file_id) values
         ('${uid.attachA}', '${uid.tenantA}', '${uid.hwA}', '${uid.fileA}')`,
    );
    await migrator.query('commit');
  });

  afterAll(async () => {
    try {
      await migrator.query('begin');
      const tenantIds = `'${uid.tenantA}','${uid.tenantB}'`;
      await migrator.query(`delete from homework_attachments where tenant_id in (${tenantIds})`);
      await migrator.query(`delete from homework where tenant_id in (${tenantIds})`);
      await migrator.query(`delete from timetable_entries where tenant_id in (${tenantIds})`);
      await migrator.query(`delete from periods where tenant_id in (${tenantIds})`);
      await migrator.query(`delete from teacher_assignments where tenant_id in (${tenantIds})`);
      await migrator.query(`delete from class_subjects where tenant_id in (${tenantIds})`);
      await migrator.query(`delete from sections where tenant_id in (${tenantIds})`);
      await migrator.query(`delete from acd_classes where tenant_id in (${tenantIds})`);
      await migrator.query(`delete from subjects where tenant_id in (${tenantIds})`);
      await migrator.query(`delete from grade_levels where tenant_id in (${tenantIds})`);
      await migrator.query(`delete from academic_years where tenant_id in (${tenantIds})`);
      await migrator.query(`delete from campuses where tenant_id in (${tenantIds})`);
      await migrator.query(
        `delete from membership_roles where role_id in ('${uid.roleTeacherA}','${uid.roleTeacherB}')`,
      );
      await migrator.query(`delete from roles where id in ('${uid.roleTeacherA}','${uid.roleTeacherB}')`);
      await migrator.query(`delete from memberships where tenant_id in (${tenantIds})`);
      await migrator.query(`delete from files where tenant_id in (${tenantIds})`);
      await migrator.query(
        `delete from user_profiles where user_id in ('${uid.userA}','${uid.userB}','${uid.teacherElig}','${uid.teacherTwo}')`,
      );
      await migrator.query(
        `delete from users where id in ('${uid.userA}','${uid.userB}','${uid.teacherElig}','${uid.teacherTwo}')`,
      );
      await migrator.query(`delete from outbox_events where tenant_id in (${tenantIds})`);
      await migrator.query(`delete from tenants where id in (${tenantIds})`);
      await migrator.query('commit');
    } finally {
      await migrator.end();
      await app.end();
    }
  });

  describe('A. row-level security boundary', () => {
    it('1. RLS is enabled AND forced on all four new tables', async () => {
      const res = await migrator.query<{ tbl: string; rls: boolean; force: boolean }>(
        `select c.relname tbl, c.relrowsecurity rls, c.relforcerowsecurity force
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relname = ANY($1) order by c.relname`,
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
        select has_table_privilege('school_app_rw', 'periods', 'SELECT') s,
               has_table_privilege('school_app_rw', 'periods', 'INSERT') i,
               has_table_privilege('school_app_rw', 'periods', 'UPDATE') u,
               has_table_privilege('school_app_rw', 'periods', 'DELETE') d`);
      expect(g[0]).toEqual({ s: true, i: true, u: true, d: true });
      for (const t of NEW_TABLES) {
        const r = await appQ<{ n: number }>(`select count(*)::int n from "${t}"`);
        expect(Number(r[0]!.n), t).toBe(0);
      }
    });

    it('3. a signed tenant context sees exactly its own rows', async () => {
      await tenantA(async () => {
        const p = (await appQ<{ n: number }>('select count(*)::int n from periods'))[0]!.n;
        const h = (await appQ<{ n: number }>('select count(*)::int n from homework'))[0]!.n;
        expect(Number(p)).toBe(2);
        expect(Number(h)).toBe(2);
      });
      await tenantB(async () => {
        const p = (await appQ<{ n: number }>('select count(*)::int n from periods'))[0]!.n;
        const h = (await appQ<{ n: number }>('select count(*)::int n from homework'))[0]!.n;
        expect(Number(p)).toBe(1);
        expect(Number(h)).toBe(0);
        const a = (await appQ<{ n: number }>('select count(*)::int n from homework_attachments'))[0]!.n;
        expect(Number(a)).toBe(0);
      });
    });

    it('4. the runtime role has no hard DELETE path (privileged-only)', async () => {
      await tenantA(async () => {
        // The DELETE policy is app_privileged() only, so a tenant session's hard
        // DELETE matches zero rows — it cannot destroy data, and the row survives.
        const res = await app.query(`delete from timetable_entries where id = '${uid.entryA}'`);
        expect(res.rowCount).toBe(0);
        const still = await appQ<{ n: number }>(
          `select count(*)::int n from timetable_entries where id = '${uid.entryA}'`,
        );
        expect(Number(still[0]!.n)).toBe(1);
      });
    });

    it('5. the WITH CHECK policy rejects cross-tenant inserts', async () => {
      await tenantA(async () => {
        await app.query('savepoint sp');
        const caught = await app
          .query(
            `insert into periods (tenant_id, name, period_no, start_time, end_time)
             values ('${uid.tenantB}', 'spy', 9, '08:00', '08:45')`,
          )
          .catch((err: pg.DatabaseError) => err);
        await app.query('rollback to savepoint sp');
        expect((caught as pg.DatabaseError).code).toBe('42501');
      });
    });
  });

  describe('B. periods integrity', () => {
    it('6. period_no is unique per (tenant, campus) among live rows', async () => {
      await tenantA(async () => {
        await rejectCode(
          () =>
            app.query(
              `insert into periods (tenant_id, name, period_no, start_time, end_time)
               values ('${uid.tenantA}', 'Dup 1', 1, '10:00', '10:45')`,
            ),
          '23505',
        );
      });
    });

    it('7. overlapping ranges are refused within a tenant (23P01) while touching and cross-tenant overlap are allowed', async () => {
      await tenantA(async () => {
        // Overlap with period 1 (08:00-08:45): 08:30-09:15 overlaps.
        await rejectCode(
          () =>
            app.query(
              `insert into periods (tenant_id, name, period_no, start_time, end_time)
               values ('${uid.tenantA}', 'Overlap', 9, '08:30', '09:15')`,
            ),
          '23P01',
          /periods_no_overlap_excl/,
        );
        // Touching the end of period 2 (08:45-09:30): 09:30-10:15 touches but does not overlap.
        const ok = await app.query(
          `insert into periods (tenant_id, name, period_no, start_time, end_time)
           values ('${uid.tenantA}', 'Touch', 9, '09:30', '10:15') returning id`,
        );
        expect(ok.rows).toHaveLength(1);
        // Cleanup of the touching row happens with the enclosing tenantA rollback.
      });
      // Cross-tenant overlap: tenant B also holds an 08:00-08:45 period.
      await tenantB(async () => {
        const p = (await appQ<{ n: number }>('select count(*)::int n from periods'))[0]!.n;
        expect(Number(p)).toBe(1);
      });
    });

    it('8. a period still referenced by live lessons cannot be deleted (period_has_entries)', async () => {
      await tenantA(async () => {
        await rejectCode(
          () => app.query(`update periods set deleted_at = now() where id = '${uid.periodA}'`),
          '55000',
          /cannot delete period with live timetable entries/,
        );
        // An unused period deletes cleanly (periodA2 is still referenced by
        // entryOrph, so prove the clean path with a fresh period).
        const fresh = await app.query(
          `insert into periods (tenant_id, name, period_no, start_time, end_time)
           values ('${uid.tenantA}', 'Unused', 9, '10:30', '11:15') returning id`,
        );
        const freshId = (fresh.rows[0] as { id: string }).id;
        const ok = await app.query(
          `update periods set deleted_at = now() where id = '${freshId}' returning id`,
        );
        expect(ok.rows).toHaveLength(1);
      });
    });
  });

  describe('C. weekly grid integrity', () => {
    it('9. a section has one live lesson per (weekday, period) slot (23505)', async () => {
      await tenantA(async () => {
        await rejectCode(
          () =>
            app.query(
              `insert into timetable_entries (tenant_id, class_id, section_id, subject_id, teacher_user_id, period_id, campus_id, academic_year_id, weekday)
               values ('${uid.tenantA}', '${uid.classA1}', '${uid.sectionA1}', '${uid.subjA}', '${uid.teacherElig}', '${uid.periodA}', '${uid.campusA}', '${uid.yearA}', 1)`,
            ),
          '23505',
        );
      });
    });

    it('10. a teacher can never be double-booked across sections in the same weekday (55000)', async () => {
      await tenantA(async () => {
        await rejectCode(
          () =>
            app.query(
              `insert into timetable_entries (tenant_id, class_id, section_id, subject_id, teacher_user_id, period_id, campus_id, academic_year_id, weekday)
               values ('${uid.tenantA}', '${uid.classA2}', '${uid.sectionA2}', '${uid.subjA2}', '${uid.teacherElig}', '${uid.periodA}', '${uid.campusA}', '${uid.yearA}', 1)`,
            ),
          '55000',
          /teacher is double-booked/,
        );
      });
    });

    it('11. lessons refuse non-assigned teachers, unattached subjects and cross-tenant parents', async () => {
      await tenantA(async () => {
        // Teacher is not the assigned teacher for (A2, subjA2) — assigned is teacherElig.
        await rejectCode(
          () =>
            app.query(
              `insert into timetable_entries (tenant_id, class_id, section_id, subject_id, teacher_user_id, period_id, campus_id, academic_year_id, weekday)
               values ('${uid.tenantA}', '${uid.classA2}', '${uid.sectionA2}', '${uid.subjA2}', '${uid.teacherTwo}', '${uid.periodA}', '${uid.campusA}', '${uid.yearA}', 2)`,
            ),
          '55000',
          /teacher is not the assigned teacher/,
        );
        // Subject is not attached to the class (subjFree has no link under classA1).
        await rejectCode(
          () =>
            app.query(
              `insert into timetable_entries (tenant_id, class_id, section_id, subject_id, teacher_user_id, period_id, campus_id, academic_year_id, weekday)
               values ('${uid.tenantA}', '${uid.classA1}', '${uid.sectionA1}', '${uid.subjFree}', '${uid.teacherElig}', '${uid.periodA}', '${uid.campusA}', '${uid.yearA}', 3)`,
            ),
          '55000',
          /subject is not attached to the class for this timetable entry/,
        );
        // Cross-tenant parent: classB does not exist in tenant A (composite FK anchor).
        await rejectCode(
          () =>
            app.query(
              `insert into timetable_entries (tenant_id, class_id, section_id, subject_id, teacher_user_id, period_id, campus_id, academic_year_id, weekday)
               values ('${uid.tenantA}', '${uid.classB}', '${uid.sectionB}', '${uid.subjB}', '${uid.teacherElig}', '${uid.periodA}', '${uid.campusB}', '${uid.yearB}', 4)`,
            ),
          '23503',
          /class not found for timetable entry/,
        );
      });
    });

    it('12. a soft-deleted lesson frees its slot for reuse', async () => {
      await tenantA(async () => {
        const inserted = await app.query(
          `insert into timetable_entries (tenant_id, class_id, section_id, subject_id, teacher_user_id, period_id, campus_id, academic_year_id, weekday)
           values ('${uid.tenantA}', '${uid.classA2}', '${uid.sectionA2}', '${uid.subjA2}', '${uid.teacherElig}', '${uid.periodA2}', '${uid.campusA}', '${uid.yearA}', 3)
           returning id`,
        );
        const id = (inserted.rows[0] as { id: string }).id;
        await app.query(`update timetable_entries set deleted_at = now() where id = '${id}'`);
        await app.query(
          `insert into timetable_entries (tenant_id, class_id, section_id, subject_id, teacher_user_id, period_id, campus_id, academic_year_id, weekday)
           values ('${uid.tenantA}', '${uid.classA2}', '${uid.sectionA2}', '${uid.subjA2}', '${uid.teacherElig}', '${uid.periodA2}', '${uid.campusA}', '${uid.yearA}', 3)`,
        );
      });
    });

    it('13. an assigned teacher cannot be unassigned while scheduled (assignment_has_schedule)', async () => {
      await tenantA(async () => {
        await rejectCode(
          () =>
            app.query(
              `update teacher_assignments set deleted_at = now() where id = '${uid.assignA}'`,
            ),
          '55000',
          /cannot unassign a teacher with live timetable entries/,
        );
      });
    });
  });

  describe('D. homework + delete guards', () => {
    it('14. homework authorship, attachment tenant-anchoring and deduplication', async () => {
      await tenantA(async () => {
        // Only the assigned teacher (teacherElig) may author for (A1, subjA).
        await rejectCode(
          () =>
            app.query(
              `insert into homework (tenant_id, class_id, subject_id, teacher_user_id, campus_id, academic_year_id, title)
               values ('${uid.tenantA}', '${uid.classA1}', '${uid.subjA}', '${uid.teacherTwo}', '${uid.campusA}', '${uid.yearA}', 'Spoof')`,
            ),
          '55000',
          /author is not the assigned teacher/,
        );
        // Subject must be attached to the class.
        await rejectCode(
          () =>
            app.query(
              `insert into homework (tenant_id, class_id, subject_id, teacher_user_id, campus_id, academic_year_id, title)
               values ('${uid.tenantA}', '${uid.classA1}', '${uid.subjFree}', '${uid.teacherElig}', '${uid.campusA}', '${uid.yearA}', 'Unlinked')`,
            ),
          '55000',
          /subject is not attached to the class for homework/,
        );
        // Cross-tenant attachment fails the composite FK (files_tenant anchor).
        await rejectCode(
          () =>
            app.query(
              `insert into homework_attachments (tenant_id, homework_id, file_id)
               values ('${uid.tenantA}', '${uid.hwA}', '${uid.fileB}')`,
            ),
          '23503',
        );
        // Duplicate attachment is refused.
        await rejectCode(
          () =>
            app.query(
              `insert into homework_attachments (tenant_id, homework_id, file_id)
               values ('${uid.tenantA}', '${uid.hwA}', '${uid.fileA}')`,
            ),
          '23505',
        );
      });
    });

    it('15. a section cannot be deleted while live lessons reference it (section_has_timetable)', async () => {
      await tenantA(async () => {
        await rejectCode(
          () => app.query(`update sections set deleted_at = now() where id = '${uid.sectionA1}'`),
          '55000',
          /cannot delete section with live timetable entries/,
        );
      });
    });

    it('16. subject delete guards hold even after privileged orphan surgery', async () => {
      // Strip the seeded orphan fixture (link+assignment present) so the guarded
      // paths below exercise the orphaned state, not the happy link.
      await migrator.query(
        `delete from homework_attachments where tenant_id = '${uid.tenantA}' and homework_id = '${uid.hwOrph}'`,
      );
      await migrator.query(
        `delete from homework where tenant_id = '${uid.tenantA}' and id = '${uid.hwOrph}'`,
      );
      await migrator.query(
        `delete from timetable_entries where tenant_id = '${uid.tenantA}' and id = '${uid.entryOrph}'`,
      );
      await migrator.query(
        `delete from teacher_assignments where tenant_id = '${uid.tenantA}' and id = '${uid.assignOrph}'`,
      );
      await migrator.query(
        `delete from class_subjects where tenant_id = '${uid.tenantA}' and id = '${uid.linkOrph}'`,
      );
      // A new lesson for the orphaned subject is refused at the trigger — the DB
      // will not re-create a lesson without its link/assignment.
      await tenantA(async () => {
        await rejectCode(
          () =>
            app.query(
              `insert into timetable_entries (tenant_id, class_id, section_id, subject_id, teacher_user_id, period_id, campus_id, academic_year_id, weekday)
               values ('${uid.tenantA}', '${uid.classOrph}', '${uid.sectionOrph}', '${uid.subjOrph}', '${uid.teacherElig}', '${uid.periodA}', '${uid.campusA}', '${uid.yearA}', 2)`,
            ),
          '55000',
        );
      });
      // Rebuild the intermediate rows and seed LIVE lesson + homework (privileged,
      // persisted — the tenantA helper rolls its writes back at block end).
      await migrator.query(
        `insert into class_subjects (id, tenant_id, class_id, subject_id, campus_id, academic_year_id) values
           ('${uid.linkOrph}', '${uid.tenantA}', '${uid.classOrph}', '${uid.subjOrph}', '${uid.campusA}', '${uid.yearA}')`,
      );
      await migrator.query(
        `insert into teacher_assignments (id, tenant_id, class_id, subject_id, teacher_user_id, campus_id, academic_year_id) values
           ('${uid.assignOrph}', '${uid.tenantA}', '${uid.classOrph}', '${uid.subjOrph}', '${uid.teacherElig}', '${uid.campusA}', '${uid.yearA}')`,
      );
      const seededEntry = await migrator.query(
        `insert into timetable_entries (id, tenant_id, class_id, section_id, subject_id, teacher_user_id, period_id, campus_id, academic_year_id, weekday)
         values ('${uid.entryOrph}', '${uid.tenantA}', '${uid.classOrph}', '${uid.sectionOrph}', '${uid.subjOrph}', '${uid.teacherElig}', '${uid.periodA}', '${uid.campusA}', '${uid.yearA}', 2)`,
      );
      expect(seededEntry.rowCount).toBe(1);
      await migrator.query(
        `insert into homework (id, tenant_id, class_id, subject_id, teacher_user_id, campus_id, academic_year_id, title)
         values ('${uid.hwOrph}', '${uid.tenantA}', '${uid.classOrph}', '${uid.subjOrph}', '${uid.teacherElig}', '${uid.campusA}', '${uid.yearA}', 'Orph HW')`,
      );
      // Privileged orphan surgery: hard-delete the intermediate rows so only the
      // LIVE timetable/homework references remain (hard DELETE bypasses the
      // soft-delete guards).
      await migrator.query(
        `delete from teacher_assignments where tenant_id = '${uid.tenantA}' and id = '${uid.assignOrph}'`,
      );
      await migrator.query(
        `delete from class_subjects where tenant_id = '${uid.tenantA}' and id = '${uid.linkOrph}'`,
      );
      // The live lesson alone must still stop the soft-delete.
      await tenantA(async () => {
        await rejectCode(
          () => app.query(`update subjects set deleted_at = now() where id = '${uid.subjOrph}'`),
          '55000',
          /cannot delete subject with live timetable entries/,
        );
      });
      // Drop the live lesson — the live homework alone must still stop it.
      await migrator.query(
        `delete from timetable_entries where tenant_id = '${uid.tenantA}' and subject_id = '${uid.subjOrph}'`,
      );
      await tenantA(async () => {
        await rejectCode(
          () => app.query(`update subjects set deleted_at = now() where id = '${uid.subjOrph}'`),
          '55000',
          /cannot delete subject with live homework/,
        );
      });
    });

    it('17. class delete guards hold under orphan surgery (class_has_homework; the timetable guard is unreachable)', async () => {
      // End of test 16 leaves: live homework hwOrph for classOrph/subjOrph, live
      // sectionOrph, and NO intermediate link/assignment rows.
      //
      // The class guard's timetable check (class_has_timetable) is unreachable as a
      // first line of defense and therefore pure defense-in-depth: a live lesson's
      // composite FK pins a live section, and the section soft-delete guard refuses
      // while live lessons exist, so class_has_sections always fires first. Prove
      // the reachable NEW guard instead: live homework survives orphan surgery.
      await migrator.query(
        `delete from sections where tenant_id = '${uid.tenantA}' and id = '${uid.sectionOrph}'`,
      );
      await tenantA(async () => {
        await rejectCode(
          () => app.query(`update acd_classes set deleted_at = now() where id = '${uid.classOrph}'`),
          '55000',
          /cannot delete class with live homework/,
        );
      });
      // DOMINANCE PROOF: rebuild the grid and confirm the class soft-delete is
      // refused by the sections guard before the timetable guard is consulted.
      await migrator.query(
        `insert into class_subjects (id, tenant_id, class_id, subject_id, campus_id, academic_year_id) values
           ('${uid.linkOrph}', '${uid.tenantA}', '${uid.classOrph}', '${uid.subjOrph}', '${uid.campusA}', '${uid.yearA}')`,
      );
      await migrator.query(
        `insert into teacher_assignments (id, tenant_id, class_id, subject_id, teacher_user_id, campus_id, academic_year_id) values
           ('${uid.assignOrph}', '${uid.tenantA}', '${uid.classOrph}', '${uid.subjOrph}', '${uid.teacherElig}', '${uid.campusA}', '${uid.yearA}')`,
      );
      await migrator.query(
        `insert into sections (id, tenant_id, class_id, campus_id, academic_year_id, code, status) values
           ('${uid.sectionOrph}', '${uid.tenantA}', '${uid.classOrph}', '${uid.campusA}', '${uid.yearA}', 'so2-${slug}', 'active')`,
      );
      const seededEntry = await migrator.query(
        `insert into timetable_entries (id, tenant_id, class_id, section_id, subject_id, teacher_user_id, period_id, campus_id, academic_year_id, weekday)
         values ('${uid.entryOrph}', '${uid.tenantA}', '${uid.classOrph}', '${uid.sectionOrph}', '${uid.subjOrph}', '${uid.teacherElig}', '${uid.periodA}', '${uid.campusA}', '${uid.yearA}', 3)`,
      );
      expect(seededEntry.rowCount).toBe(1);
      await tenantA(async () => {
        await rejectCode(
          () => app.query(`update acd_classes set deleted_at = now() where id = '${uid.classOrph}'`),
          '55000',
          /cannot delete class with live sections/,
        );
      });
    });

    it('18. cross-tenant homework is invisible (isolation of reads)', async () => {
      await tenantB(async () => {
        const rows = await appQ<{ id: string }>(`select id from homework`);
        expect(rows).toHaveLength(0);
        const d = await appQ<{ id: string }>(`select id from homework where id = '${uid.hwA}'`);
        expect(d).toHaveLength(0);
      });
    });
  });
});