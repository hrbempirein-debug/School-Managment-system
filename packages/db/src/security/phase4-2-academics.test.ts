import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { getEnv } from '@sms/config';

/**
 * Phase 4.2 DB security + academics-integrity proofs, run against the REAL roles
 * + disposable test database (school_app_rw -> school_saas_test). Requires migrations 0009
 * (grade_levels, subjects, class_subjects, teacher_assignments, memberships FK
 * anchor, life-cycle + delete-guard triggers, RLS, permission backfill) and 0010
 * (app_safe_user_display — controlled SECURITY DEFINER display-name helper).
 *
 * Section A (row-level security): all four new tables are FORCE RLS; a bare
 * app_rw session sees nothing; a signed tenant context sees only its own rows;
 * cross-tenant inserts and composite-FK parents are rejected; the runtime role
 * has no DELETE path; the legacy forgeable GUCs grant nothing.
 *
 * Section B (domain integrity): tenant-scoped code uniqueness for live grade
 * levels/subjects; classes reference live grade levels; delete guards refuse
 * dropping live parents (grade-level with classes, subject with live links or
 * assignments, class with live subject links); class_subjects is class-
 * pinned (campus/year) and (class, subject)-unique while live; a link can only
 * be created under a LIVE class and for a LIVE subject and cannot be detached
 * while a live teacher assignment exists; teacher assignments require a LIVE
 * class-subject link plus an ACTIVE membership carrying the tenant-scoped
 * `teacher` role (cross-tenant teachers and suspended/non-teacher members are
 * refused, via a SECURITY INVOKER trigger that runs under the invoking role's
 * RLS); one live assignment per (class, subject); soft-deleted assignments are
 * always writable (unassign survives a later suspension); deleted parents may
 * reuse codes.
 *
 * Opt-in: RUN_RUNTIME_SECURITY_TESTS=1 (requires PostgreSQL + migration 0009).
 */
const enabled = process.env.RUN_RUNTIME_SECURITY_TESTS === '1';
const describeDb = enabled ? describe : describe.skip;

const NEW_TABLES = ['grade_levels', 'subjects', 'class_subjects', 'teacher_assignments'];

describeDb('Phase 4.2 RLS + academics integrity (grade levels/subjects/assignments on school_saas_test)', () => {
  let migrator: pg.Client;
  let app: pg.Client;
  const uid: Record<string, string> = {};
  const slug = 'p42' + randomUUID().slice(0, 8);

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

  async function tenantB<T>(fn: () => Promise<T>): Promise<T> {
    const tkt = (await appQ(
      `select app_ctx_mint('tenant', '${uid.userB}', '${uid.tenantB}') t`,
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
    uid.yearB = randomUUID();
    // teachers: b-per memberships with/without the teacher role
    uid.teacherElig = randomUUID();
    uid.teacherNoRole = randomUUID();
    uid.teacherInactive = randomUUID();
    uid.teacherB = randomUUID();
    uid.memberElig = randomUUID();
    uid.memberNoRole = randomUUID();
    uid.memberInactive = randomUUID();
    uid.memberB = randomUUID();
    uid.roleTeacherA = randomUUID();
    uid.roleTeacherB = randomUUID();
    // grade levels / subjects
    uid.levelA = randomUUID();
    uid.levelA2 = randomUUID();
    uid.levelDeleted = randomUUID();
    uid.levelB = randomUUID();
    uid.subjA = randomUUID();
    uid.subjA2 = randomUUID();
    uid.subjDeleted = randomUUID();
    uid.subjB = randomUUID();
    // classes
    uid.classA1 = randomUUID();
    uid.classA2 = randomUUID();
    uid.classDeleted = randomUUID();
    uid.classB = randomUUID();
    // class_subjects links
    uid.linkA = randomUUID();
    uid.linkA2b = randomUUID();
    uid.linkDeleted = randomUUID();
    uid.linkB = randomUUID();
    // teacher assignments
    uid.assignA = randomUUID();
    uid.assignDeleted = randomUUID();

    await migrator.query('begin');
    await migrator.query(
      `insert into tenants (id, slug, name) values
         ('${uid.tenantA}', '${slug}-a', 'Acad A'),
         ('${uid.tenantB}', '${slug}-b', 'Acad B')`,
    );
    await migrator.query(
      `insert into users (id, email) values
         ('${uid.userA}', 'p42-a-${slug}@example.com'),
         ('${uid.userB}', 'p42-b-${slug}@example.com'),
         ('${uid.teacherElig}', 'p42-te-${slug}@example.com'),
         ('${uid.teacherNoRole}', 'p42-tn-${slug}@example.com'),
         ('${uid.teacherInactive}', 'p42-ti-${slug}@example.com'),
         ('${uid.teacherB}', 'p42-tb-${slug}@example.com')`,
    );
    await migrator.query(
      `insert into memberships (id, tenant_id, user_id, status) values
         ('${uid.memberElig}', '${uid.tenantA}', '${uid.teacherElig}', 'active'),
         ('${uid.memberNoRole}', '${uid.tenantA}', '${uid.teacherNoRole}', 'active'),
         ('${uid.memberInactive}', '${uid.tenantA}', '${uid.teacherInactive}', 'suspended'),
         ('${uid.memberB}', '${uid.tenantB}', '${uid.teacherB}', 'active'),
         ('${randomUUID()}', '${uid.tenantA}', '${uid.userA}', 'active'),
         ('${randomUUID()}', '${uid.tenantB}', '${uid.userB}', 'active')`,
    );
    await migrator.query(
      `insert into user_profiles (user_id, full_name) values
         ('${uid.userA}', 'Caller A'),
         ('${uid.userB}', 'Caller B'),
         ('${uid.teacherElig}', 'Eligible Teacher'),
         ('${uid.teacherNoRole}', 'No Role Teacher'),
         ('${uid.teacherInactive}', 'Inactive Teacher'),
         ('${uid.teacherB}', 'Teacher B')`,
    );
    await migrator.query(
      `insert into roles (id, tenant_id, scope, code, name, is_system) values
         ('${uid.roleTeacherA}', '${uid.tenantA}', 'tenant', 'teacher', 'Teacher', true),
         ('${uid.roleTeacherB}', '${uid.tenantB}', 'tenant', 'teacher', 'Teacher', true)`,
    );
    await migrator.query(
      `insert into membership_roles (membership_id, role_id) values
         ('${uid.memberElig}', '${uid.roleTeacherA}'),
         ('${uid.memberInactive}', '${uid.roleTeacherA}'),
         ('${uid.memberB}', '${uid.roleTeacherB}')`,
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
         ('${uid.levelA2}', '${uid.tenantA}', 'gl2-${slug}', 'Grade A2', 'active'),
         ('${uid.levelDeleted}', '${uid.tenantA}', 'glx-${slug}', 'Grade Gone', 'active'),
         ('${uid.levelB}', '${uid.tenantB}', 'gl-${slug}', 'Grade B', 'active')`,
    );
    await migrator.query(
      `insert into subjects (id, tenant_id, code, name, status) values
         ('${uid.subjA}', '${uid.tenantA}', 'sb-${slug}', 'Subject A', 'active'),
         ('${uid.subjA2}', '${uid.tenantA}', 'sb2-${slug}', 'Subject A2', 'active'),
         ('${uid.subjDeleted}', '${uid.tenantA}', 'sbx-${slug}', 'Subject Gone', 'active'),
         ('${uid.subjB}', '${uid.tenantB}', 'sb-${slug}', 'Subject B', 'active')`,
    );
    await migrator.query(
      `insert into acd_classes (id, tenant_id, campus_id, academic_year_id, grade_level_id, code, name, status) values
         ('${uid.classA1}', '${uid.tenantA}', '${uid.campusA}', '${uid.yearA}', '${uid.levelA}', 'c1-${slug}', 'Class One', 'active'),
         ('${uid.classA2}', '${uid.tenantA}', '${uid.campusA}', '${uid.yearA}', null, 'c2-${slug}', 'Class Two', 'active'),
         ('${uid.classDeleted}', '${uid.tenantA}', '${uid.campusA}', '${uid.yearA}', null, 'cd-${slug}', 'Class Gone', 'active'),
         ('${uid.classB}', '${uid.tenantB}', '${uid.campusB}', '${uid.yearB}', null, 'cb-${slug}', 'Class B', 'active')`,
    );
    await migrator.query(`update acd_classes set deleted_at = now() where id = '${uid.classDeleted}'`);
    await migrator.query(`update grade_levels set deleted_at = now() where id = '${uid.levelDeleted}'`);
    await migrator.query(`update subjects set deleted_at = now() where id = '${uid.subjDeleted}'`);
    await migrator.query(
      `insert into class_subjects (id, tenant_id, class_id, subject_id, campus_id, academic_year_id) values
         ('${uid.linkA}', '${uid.tenantA}', '${uid.classA1}', '${uid.subjA}', '${uid.campusA}', '${uid.yearA}'),
         ('${uid.linkA2b}', '${uid.tenantA}', '${uid.classA2}', '${uid.subjA2}', '${uid.campusA}', '${uid.yearA}'),
         ('${uid.linkDeleted}', '${uid.tenantA}', '${uid.classA1}', '${uid.subjA2}', '${uid.campusA}', '${uid.yearA}'),
         ('${uid.linkB}', '${uid.tenantB}', '${uid.classB}', '${uid.subjB}', '${uid.campusB}', '${uid.yearB}')`,
    );
    await migrator.query(`update class_subjects set deleted_at = now() where id = '${uid.linkDeleted}'`);
    await migrator.query(
      `insert into teacher_assignments (id, tenant_id, class_id, subject_id, teacher_user_id, campus_id, academic_year_id) values
         ('${uid.assignA}', '${uid.tenantA}', '${uid.classA1}', '${uid.subjA}', '${uid.teacherElig}', '${uid.campusA}', '${uid.yearA}'),
         ('${uid.assignDeleted}', '${uid.tenantA}', '${uid.classA2}', '${uid.subjA2}', '${uid.teacherElig}', '${uid.campusA}', '${uid.yearA}')`,
    );
    await migrator.query(`update teacher_assignments set deleted_at = now() where id = '${uid.assignDeleted}'`);
    await migrator.query('commit');
  });

  afterAll(async () => {
    try {
      await migrator.query('begin');
      const tenantIds = `'${uid.tenantA}','${uid.tenantB}'`;
      await migrator.query(`delete from teacher_assignments where tenant_id in (${tenantIds})`);
      await migrator.query(`delete from class_subjects where tenant_id in (${tenantIds})`);
      await migrator.query(`delete from acd_classes where tenant_id in (${tenantIds})`);
      await migrator.query(`delete from subjects where tenant_id in (${tenantIds})`);
      await migrator.query(`delete from grade_levels where tenant_id in (${tenantIds})`);
      await migrator.query(`delete from academic_years where tenant_id in (${tenantIds})`);
      await migrator.query(`delete from campuses where tenant_id in (${tenantIds})`);
      await migrator.query(
        `delete from membership_roles where membership_id in
           ('${uid.memberElig}','${uid.memberNoRole}','${uid.memberInactive}','${uid.memberB}')`,
      );
      await migrator.query(
        `delete from roles where id in ('${uid.roleTeacherA}','${uid.roleTeacherB}')`,
      );
      await migrator.query(`delete from memberships where tenant_id in (${tenantIds})`);
      await migrator.query(
        `delete from user_profiles where user_id in
           ('${uid.userA}','${uid.userB}','${uid.teacherElig}','${uid.teacherNoRole}','${uid.teacherInactive}','${uid.teacherB}')`,
      );
      await migrator.query(
        `delete from users where id in
           ('${uid.userA}','${uid.userB}','${uid.teacherElig}','${uid.teacherNoRole}','${uid.teacherInactive}','${uid.teacherB}')`,
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
        select has_table_privilege('school_app_rw', 'grade_levels', 'SELECT') s,
               has_table_privilege('school_app_rw', 'grade_levels', 'INSERT') i,
               has_table_privilege('school_app_rw', 'grade_levels', 'UPDATE') u,
               has_table_privilege('school_app_rw', 'grade_levels', 'DELETE') d`);
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

    it('4. cross-tenant INSERT is rejected (RLS WITH CHECK on catalogs, parent lookup on link tables)', async () => {
      await tenantA(async () => {
        await rejectCode(
          () =>
            app.query(
              `insert into grade_levels (id, tenant_id, code, name)
               values ('${randomUUID()}', '${uid.tenantB}', 'x-${slug}', 'X')`,
            ),
          '42501',
        );
        await rejectCode(
          () =>
            app.query(
              `insert into subjects (id, tenant_id, code, name)
               values ('${randomUUID()}', '${uid.tenantB}', 'x-${slug}', 'X')`,
            ),
          '42501',
        );
        // class_subjects/teacher_assignments have BEFORE INSERT triggers whose
        // parent lookups run through the invoking role's RLS: a foreign class is
        // "not found" and surfaces as 23503 before RLS WITH CHECK (same pattern
        // as sections in phase4-1).
        await rejectCode(
          () =>
            app.query(
              `insert into class_subjects (id, tenant_id, class_id, subject_id, campus_id, academic_year_id)
               values ('${randomUUID()}', '${uid.tenantB}', '${uid.classB}', '${uid.subjB}', '${uid.campusB}', '${uid.yearB}')`,
            ),
          '23503',
        );
        await rejectCode(
          () =>
            app.query(
              `insert into teacher_assignments (id, tenant_id, class_id, subject_id, teacher_user_id, campus_id, academic_year_id)
               values ('${randomUUID()}', '${uid.tenantB}', '${uid.classB}', '${uid.subjB}', '${uid.teacherB}', '${uid.campusB}', '${uid.yearB}')`,
            ),
          '23503',
        );
      });
    });

    it('5. cross-tenant composite-FK parents are rejected', async () => {
      await tenantA(async () => {
        // Link tenant-A classA1 with tenant-B subject: subject not found.
        await rejectCode(
          () =>
            app.query(
              `insert into class_subjects (id, tenant_id, class_id, subject_id, campus_id, academic_year_id)
               values ('${randomUUID()}', '${uid.tenantA}', '${uid.classA1}', '${uid.subjB}', '${uid.campusA}', '${uid.yearA}')`,
            ),
          '23503',
          /subject not found for class link/,
        );
        // Same shape for an assignment (teacher B is a valid teacher in B, not A).
        await rejectCode(
          () =>
            app.query(
              `insert into teacher_assignments (id, tenant_id, class_id, subject_id, teacher_user_id, campus_id, academic_year_id)
               values ('${randomUUID()}', '${uid.tenantA}', '${uid.classA1}', '${uid.subjB}', '${uid.teacherB}', '${uid.campusA}', '${uid.yearA}')`,
            ),
          '23503',
        );
        // Cross-tenant campus on a link: classA2 (campusA) with campusB. The
        // class_campus pin FK fails. Uses a pair with no live link so the
        // class-subject unique index (23505) cannot mask the FK error.
        await rejectCode(
          () =>
            app.query(
              `insert into class_subjects (id, tenant_id, class_id, subject_id, campus_id, academic_year_id)
               values ('${randomUUID()}', '${uid.tenantA}', '${uid.classA2}', '${uid.subjA}', '${uid.campusB}', '${uid.yearA}')`,
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
      const r = await appQ<{ n: number }>(`select count(*)::int n from grade_levels`);
      await app.query('rollback');
      expect(Number(r[0]!.n)).toBe(0);
    });

    it('8. nested-query isolation: tenant-B links invisible via a tenant-A lookup', async () => {
      await tenantA(async () => {
        const ofB = await appQ<{ n: number }>(
          `select count(*)::int n from class_subjects where class_id = '${uid.classB}'`,
        );
        expect(Number(ofB[0]!.n)).toBe(0);
        const ofA = await appQ<{ n: number }>(
          `select count(*)::int n from class_subjects where class_id = '${uid.classA1}'`,
        );
        expect(Number(ofA[0]!.n)).toBeGreaterThan(0);
      });
    });
  });

  describe('B. domain integrity', () => {
    it('9. grade-level code is unique tenant-wide for live rows; tenant-scoped', async () => {
      await tenantA(async () => {
        await rejectCode(
          () =>
            app.query(
              `insert into grade_levels (id, tenant_id, code, name)
               values ('${randomUUID()}', '${uid.tenantA}', 'gl-${slug}', 'Dup')`,
            ),
          '23505',
          /grade_levels_tenant_code_uq/,
        );
      });
      // The very same code (`gl-${slug}`) is live in BOTH tenants concurrently
      // (fixture levelA/levelB) — uniqueness is scoped per tenant, and each
      // context can only ever see its own copy.
      await tenantB(async () => {
        const mine = (await appQ<{ n: number }>(
          `select count(*)::int n from grade_levels
           where code = 'gl-${slug}' and tenant_id = '${uid.tenantB}'`,
        ))[0]!.n;
        const foreign = (await appQ<{ n: number }>(
          `select count(*)::int n from grade_levels
           where code = 'gl-${slug}' and tenant_id = '${uid.tenantA}'`,
        ))[0]!.n;
        expect(Number(mine)).toBe(1);
        expect(Number(foreign)).toBe(0);
      });
    });

    it('10. subject code is unique tenant-wide for live rows; tenant-scoped', async () => {
      await tenantA(async () => {
        await rejectCode(
          () =>
            app.query(
              `insert into subjects (id, tenant_id, code, name)
               values ('${randomUUID()}', '${uid.tenantA}', 'sb-${slug}', 'Dup')`,
            ),
          '23505',
          /subjects_tenant_code_uq/,
        );
      });
      // Same code (`sb-${slug}`) is live in both tenants (fixture subjA/subjB).
      await tenantB(async () => {
        const mine = (await appQ<{ n: number }>(
          `select count(*)::int n from subjects
           where code = 'sb-${slug}' and tenant_id = '${uid.tenantB}'`,
        ))[0]!.n;
        const foreign = (await appQ<{ n: number }>(
          `select count(*)::int n from subjects
           where code = 'sb-${slug}' and tenant_id = '${uid.tenantA}'`,
        ))[0]!.n;
        expect(Number(mine)).toBe(1);
        expect(Number(foreign)).toBe(0);
      });
    });

    it('11. a class may reference a live grade level; a foreign/cross-tenant level is refused', async () => {
      await tenantA(async () => {
        await rejectCode(
          () =>
            app.query(
              `insert into acd_classes (id, tenant_id, campus_id, academic_year_id, grade_level_id, code, name)
               values ('${randomUUID()}', '${uid.tenantA}', '${uid.campusA}', '${uid.yearA}', '${uid.levelB}', 'glf-${slug}', 'X')`,
            ),
          '23503',
        );
        const ok = await app.query(
          `insert into acd_classes (id, tenant_id, campus_id, academic_year_id, grade_level_id, code, name)
           values ('${randomUUID()}', '${uid.tenantA}', '${uid.campusA}', '${uid.yearA}', '${uid.levelA2}', 'glok-${slug}', 'OK')`,
        );
        expect(ok.rowCount).toBe(1);
      });
    });

    it('12. a grade level with live classes cannot be soft-deleted', async () => {
      await tenantA(async () => {
        await rejectCode(
          () => app.query(`update grade_levels set deleted_at = now() where id = '${uid.levelA}'`),
          '55000',
          /cannot delete grade level with live classes/,
        );
      });
    });

    it('13. an unreferenced live grade level CAN be soft-deleted and its code reused', async () => {
      await tenantA(async () => {
        const del = await app.query(
          `update grade_levels set deleted_at = now() where id = '${uid.levelA2}'`,
        );
        expect(del.rowCount).toBe(1);
        const reuse = await app.query(
          `insert into grade_levels (id, tenant_id, code, name)
           values ('${randomUUID()}', '${uid.tenantA}', 'gl2-${slug}', 'Reused')`,
        );
        expect(reuse.rowCount).toBe(1);
      });
    });

    it('14. a subject with live class links cannot be soft-deleted', async () => {
      await tenantA(async () => {
        await rejectCode(
          () => app.query(`update subjects set deleted_at = now() where id = '${uid.subjA}'`),
          '55000',
          /cannot delete subject attached to a class/,
        );
      });
    });

    it('15. a subject referenced by a live class link (and live assignment) cannot be soft-deleted', async () => {
      await tenantA(async () => {
        // A subject that already has a live link (linkA2b) AND a live teacher
        // assignment cannot be deleted. The link check fires first: given the
        // invariant "live assignment -> live link", the separate live-assignment
        // branch is defense-in-depth and unreachable through honest writes.
        const ins = await app.query(
          `insert into teacher_assignments (id, tenant_id, class_id, subject_id, teacher_user_id, campus_id, academic_year_id)
           values ('${randomUUID()}', '${uid.tenantA}', '${uid.classA2}', '${uid.subjA2}', '${uid.teacherElig}', '${uid.campusA}', '${uid.yearA}')`,
        );
        expect(ins.rowCount).toBe(1);
        await rejectCode(
          () => app.query(`update subjects set deleted_at = now() where id = '${uid.subjA2}'`),
          '55000',
          /cannot delete subject attached to a class/,
        );
      });
    });

    it('16. class-subject links may only be created under a LIVE class', async () => {
      await tenantA(async () => {
        await rejectCode(
          () =>
            app.query(
              `insert into class_subjects (id, tenant_id, class_id, subject_id, campus_id, academic_year_id)
               values ('${randomUUID()}', '${uid.tenantA}', '${uid.classDeleted}', '${uid.subjA}', '${uid.campusA}', '${uid.yearA}')`,
            ),
          '23503',
          /class not found for subject link/,
        );
      });
    });

    it('17. class-subject links may only reference a LIVE subject', async () => {
      await tenantA(async () => {
        await rejectCode(
          () =>
            app.query(
              `insert into class_subjects (id, tenant_id, class_id, subject_id, campus_id, academic_year_id)
               values ('${randomUUID()}', '${uid.tenantA}', '${uid.classA1}', '${uid.subjDeleted}', '${uid.campusA}', '${uid.yearA}')`,
            ),
          '23503',
          /subject not found for class link/,
        );
      });
    });

    it('18. links can never carry a campus/year different from their class', async () => {
      await tenantA(async () => {
        // Pin violations surface as composite-FK 23503. Uses the (classA2, subjA)
        // pair, which has no live link, so the class-subject unique index (23505)
        // cannot mask the pin FK.
        await rejectCode(
          () =>
            app.query(
              `insert into class_subjects (id, tenant_id, class_id, subject_id, campus_id, academic_year_id)
               values ('${randomUUID()}', '${uid.tenantA}', '${uid.classA2}', '${uid.subjA}', '${uid.campusA2}', '${uid.yearA}')`,
            ),
          '23503',
        );
        await rejectCode(
          () =>
            app.query(
              `insert into class_subjects (id, tenant_id, class_id, subject_id, campus_id, academic_year_id)
               values ('${randomUUID()}', '${uid.tenantA}', '${uid.classA2}', '${uid.subjA}', '${uid.campusA}', '${uid.yearB}')`,
            ),
          '23503',
        );
      });
    });

    it('19. (class, subject) is unique among live links; same pair re-used is refused', async () => {
      await tenantA(async () => {
        await rejectCode(
          () =>
            app.query(
              `insert into class_subjects (id, tenant_id, class_id, subject_id, campus_id, academic_year_id)
               values ('${randomUUID()}', '${uid.tenantA}', '${uid.classA1}', '${uid.subjA}', '${uid.campusA}', '${uid.yearA}')`,
            ),
          '23505',
          /class_subjects_class_subject_live_uq/,
        );
      });
    });

    it('20. a link with a live teacher assignment cannot be detached', async () => {
      await tenantA(async () => {
        await rejectCode(
          () => app.query(`update class_subjects set deleted_at = now() where id = '${uid.linkA}'`),
          '55000',
          /cannot detach subject with assigned teachers/,
        );
      });
    });

    it('21. a teacher may only be assigned where the subject is attached to the class', async () => {
      await tenantA(async () => {
        // classA1 has linkA (subjA) but NOT subjA2.
        await rejectCode(
          () =>
            app.query(
              `insert into teacher_assignments (id, tenant_id, class_id, subject_id, teacher_user_id, campus_id, academic_year_id)
               values ('${randomUUID()}', '${uid.tenantA}', '${uid.classA1}', '${uid.subjA2}', '${uid.teacherElig}', '${uid.campusA}', '${uid.yearA}')`,
            ),
          '55000',
          /cannot assign teacher to a subject not attached to the class/,
        );
      });
    });

    it('22. assignment requires an ACTIVE membership with the tenant `teacher` role', async () => {
      await tenantA(async () => {
        const base = (teacher: string) =>
          app.query(
            `insert into teacher_assignments (id, tenant_id, class_id, subject_id, teacher_user_id, campus_id, academic_year_id)
             values ('${randomUUID()}', '${uid.tenantA}', '${uid.classA1}', '${uid.subjA}', '${teacher}', '${uid.campusA}', '${uid.yearA}')`,
          );
        // not a member at all
        await rejectCode(() => base(uid.userA!), '55000', /active teacher membership/);
        // active member without the teacher role
        await rejectCode(() => base(uid.teacherNoRole!), '55000', /active teacher membership/);
        // suspended member WITH the teacher role
        await rejectCode(() => base(uid.teacherInactive!), '55000', /active teacher membership/);
        // teacher in another tenant (eligibility lookup is RLS-filtered)
        await rejectCode(() => base(uid.teacherB!), '55000', /active teacher membership/);
      });
    });

    it('23. a valid assignment for an eligible teacher succeeds', async () => {
      await tenantA(async () => {
        const ok = await app.query(
          `insert into teacher_assignments (id, tenant_id, class_id, subject_id, teacher_user_id, campus_id, academic_year_id)
           values ('${randomUUID()}', '${uid.tenantA}', '${uid.classA2}', '${uid.subjA2}', '${uid.teacherElig}', '${uid.campusA}', '${uid.yearA}')`,
        );
        expect(ok.rowCount).toBe(1);
      });
    });

    it('24. only one live teacher per (class, subject)', async () => {
      await tenantA(async () => {
        await rejectCode(
          () =>
            app.query(
              `insert into teacher_assignments (id, tenant_id, class_id, subject_id, teacher_user_id, campus_id, academic_year_id)
               values ('${randomUUID()}', '${uid.tenantA}', '${uid.classA1}', '${uid.subjA}', '${uid.teacherElig}', '${uid.campusA}', '${uid.yearA}')`,
            ),
          '23505',
          /teacher_assignments_class_subject_live_uq/,
        );
      });
    });

    it('25. unassign always succeeds, even after the teacher is suspended (history writable)', async () => {
      await tenantA(async () => {
        // (classA2, subjA2) has no live assignment (assignDeleted is soft-deleted).
        // Make one live, suspend the teacher membership, then soft-delete the
        // assignment: the delete path skips eligibility checks entirely.
        await app.query('savepoint sp1');
        const ins = await app.query(
          `insert into teacher_assignments (id, tenant_id, class_id, subject_id, teacher_user_id, campus_id, academic_year_id)
           values ('${randomUUID()}', '${uid.tenantA}', '${uid.classA2}', '${uid.subjA2}', '${uid.teacherElig}', '${uid.campusA}', '${uid.yearA}')
           returning id`,
        );
        const assignId = ins.rows[0]!.id as string;
        await app.query(`update memberships set status = 'suspended' where id = '${uid.memberElig}'`);
        const unassign = await app.query(
          `update teacher_assignments set deleted_at = now() where id = '${assignId}'`,
        );
        expect(unassign.rowCount).toBe(1);
        await app.query('rollback to savepoint sp1');
      });
    });

    it('26. a class with live subject links cannot be soft-deleted', async () => {
      await tenantA(async () => {
        await rejectCode(
          () => app.query(`update acd_classes set deleted_at = now() where id = '${uid.classA1}'`),
          '55000',
          /cannot delete class with live subject links/,
        );
      });
    });

    it('27. detached pairs may be re-attached (fresh row); live uniqueness still holds', async () => {
      await tenantA(async () => {
        // linkDeleted (classA1+subjA2) is already soft-deleted; re-attaching is
        // allowed (a new live row) and the second live row is still refused.
        const attach = await app.query(
          `insert into class_subjects (id, tenant_id, class_id, subject_id, campus_id, academic_year_id)
           values ('${randomUUID()}', '${uid.tenantA}', '${uid.classA1}', '${uid.subjA2}', '${uid.campusA}', '${uid.yearA}')`,
        );
        expect(attach.rowCount).toBe(1);
        // and now a NEW duplicate of the (re-)live pair is refused again.
        await rejectCode(
          () =>
            app.query(
              `insert into class_subjects (id, tenant_id, class_id, subject_id, campus_id, academic_year_id)
               values ('${randomUUID()}', '${uid.tenantA}', '${uid.classA1}', '${uid.subjA2}', '${uid.campusA}', '${uid.yearA}')`,
            ),
          '23505',
          /class_subjects_class_subject_live_uq/,
        );
      });
    });

    it('28. soft-deleted subjects may reuse their code in the same tenant', async () => {
      await tenantA(async () => {
        const tmpId = randomUUID();
        const ins = await app.query(
          `insert into subjects (id, tenant_id, code, name)
           values ('${tmpId}', '${uid.tenantA}', 'sbx-${slug}', 'A Temp')`,
        );
        expect(ins.rowCount).toBe(1);
        const del = await app.query(`update subjects set deleted_at = now() where id = '${tmpId}'`);
        expect(del.rowCount).toBe(1);
        const reuse = await app.query(
          `insert into subjects (id, tenant_id, code, name)
           values ('${randomUUID()}', '${uid.tenantA}', 'sbx-${slug}', 'A Reused')`,
        );
        expect(reuse.rowCount).toBe(1);
      });
    });
  });

  describe('C. app_safe_user_display (controlled display-name helper, migration 0010)', () => {
    it('29. a same-tenant ACTIVE caller sees the display name of an ACTIVE teacher member', async () => {
      await tenantA(async () => {
        const r = await appQ(
          `select app_safe_user_display('${uid.teacherElig}', '${uid.tenantA}') name`,
        );
        expect(r[0]!.name).toBe('Eligible Teacher');
      });
    });

    it('30. cross-tenant reads return NULL (caller has no active membership in the target tenant)', async () => {
      await tenantB(async () => {
        const r = await appQ(
          `select app_safe_user_display('${uid.teacherElig}', '${uid.tenantA}') name`,
        );
        expect(r[0]!.name).toBeNull();
      });
    });

    it('31. a suspended member is not name-exposed even inside the same tenant', async () => {
      await tenantA(async () => {
        const r = await appQ(
          `select app_safe_user_display('${uid.teacherInactive}', '${uid.tenantA}') name`,
        );
        expect(r[0]!.name).toBeNull();
      });
    });

    it('32. the helper works for each tenant independently (tenant B caller + tenant B teacher)', async () => {
      await tenantB(async () => {
        const r = await appQ(
          `select app_safe_user_display('${uid.teacherB}', '${uid.tenantB}') name`,
        );
        expect(r[0]!.name).toBe('Teacher B');
      });
    });
  });
});