import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { getEnv } from '@sms/config';

/**
 * Phase 3.1 students/guardians/enrollment foundation DB security+integrity proofs,
 * run against the REAL roles and REAL disposable test database (school_app_rw -> school_saas_test).
 * Requires migration 0005.
 *
 * Section A (row-level security): all ten new tables (files metadata + 9 student
 * lifecycle tables) are FORCE RLS; a bare app_rw session sees nothing; a signed
 * tenant context sees exactly its own rows and can neither write nor update rows
 * of a foreign tenant; composite tenant-aware FKs reject cross-tenant parents;
 * the runtime role has no DELETE path.
 *
 * Section B (domain constraints): status/value CHECK bounds, tenant-local unique
 * student_no / enrollment (student,year), foreign-parent rejection, promotion
 * batch requires distinct years, positives for each new write path.
 *
 * Section C (permission backfill): the forward-only 0005 statement grants the
 * Phase 3.1 set to legacy system roles idempotently and never touches custom
 * (non-system) roles. The statement is extracted verbatim from the migration so
 * the test always exercises exactly what ships.
 *
 * Opt-in: RUN_RUNTIME_SECURITY_TESTS=1 (requires PostgreSQL + migrations 0001..0005).
 */
const enabled = process.env.RUN_RUNTIME_SECURITY_TESTS === '1';
const describeDb = enabled ? describe : describe.skip;

const TABLES = [
  'files',
  'students',
  'guardians',
  'student_guardians',
  'enrollments',
  'student_documents',
  'admission_applications',
  'transfers',
  'promotion_batches',
  'promotion_items',
];

const PHASE_3_OWNER_PERMISSIONS = [
  'students.read',
  'students.create',
  'students.update',
  'students.delete',
  'students.export',
  'guardians.read',
  'guardians.create',
  'guardians.update',
  'enrollment.read',
  'enrollment.manage',
];

describeDb('students foundation RLS + constraints + permission backfill (school_saas_test)', () => {
  let migrator: pg.Client;
  let app: pg.Client;
  const uid: Record<string, string> = {};
  const slug = 'sf' + randomUUID().slice(0, 8);

  const appQ = <T extends pg.QueryResultRow = pg.QueryResultRow>(
    sqlText: string,
  ): Promise<T[]> => app.query<T>(sqlText).then((r) => r.rows);
  const migQ = <T extends pg.QueryResultRow = pg.QueryResultRow>(
    sqlText: string,
  ): Promise<T[]> => migrator.query<T>(sqlText).then((r) => r.rows);

  /**
   * Runs fn inside a savepoint and rolls the savepoint back afterwards, so a
   * raised error does not poison subsequent assertions in the same tenantA() session.
   */
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

  /** Run under a signed tenant-A context transaction, rolling back afterwards. */
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
    uid.yearB = randomUUID();
    uid.yearA2 = randomUUID();
    uid.yearB2 = randomUUID();
    uid.fileA = randomUUID();
    uid.fileB = randomUUID();
    uid.studentA = randomUUID();
    uid.studentB = randomUUID();
    uid.guardianA = randomUUID();
    uid.guardianB = randomUUID();
    uid.relA = randomUUID();
    uid.relB = randomUUID();
    uid.enrollA = randomUUID();
    uid.enrollB = randomUUID();
    uid.docA = randomUUID();
    uid.docB = randomUUID();
    uid.admA = randomUUID();
    uid.admB = randomUUID();
    uid.transferA = randomUUID();
    uid.transferB = randomUUID();
    uid.batchA = randomUUID();
    uid.batchB = randomUUID();
    uid.itemA = randomUUID();
    uid.itemB = randomUUID();
    uid.legacyTenant = randomUUID();
    uid.legacyTenantB = randomUUID();
    uid.legacyOwnerRole = randomUUID();
    uid.legacyCustomRole = randomUUID();

    await migrator.query('begin');
    await migrator.query(
      `insert into tenants (id, slug, name) values
         ('${uid.tenantA}', '${slug}-a', 'Students Found A'),
         ('${uid.tenantB}', '${slug}-b', 'Students Found B'),
         ('${uid.legacyTenant}', '${slug}-legacy', 'Legacy Pre-Phase-3 Tenant'),
         ('${uid.legacyTenantB}', '${slug}-legacy-b', 'Legacy Pre-Phase-3 Tenant B')`,
    );
    await migrator.query(
      `insert into users (id, email) values
         ('${uid.userA}', 'sf-a-${slug}@example.com'),
         ('${uid.userB}', 'sf-b-${slug}@example.com')`,
    );
    await migrator.query(
      `insert into memberships (id, tenant_id, user_id, status) values
         ('${randomUUID()}', '${uid.tenantA}', '${uid.userA}', 'active'),
         ('${randomUUID()}', '${uid.tenantB}', '${uid.userB}', 'active')`,
    );
    // Parent rows required by the composite tenant-aware FKs.
    await migrator.query(
      `insert into campuses (id, tenant_id, code, name, status) values
         ('${uid.campusA}', '${uid.tenantA}', 'sf-ca-${slug}', 'Campus A', 'active'),
         ('${uid.campusB}', '${uid.tenantB}', 'sf-cb-${slug}', 'Campus B', 'active')`,
    );
    await migrator.query(
      `insert into academic_years (id, tenant_id, code, name, starts_on, ends_on, status) values
         ('${uid.yearA}', '${uid.tenantA}', 'sf-ya-${slug}', 'AY 2026 A', '2026-01-01', '2026-12-31', 'active'),
         ('${uid.yearA2}', '${uid.tenantA}', 'sf-ya2-${slug}', 'AY 2027 A', '2027-01-01', '2027-12-31', 'draft'),
         ('${uid.yearB}', '${uid.tenantB}', 'sf-yb-${slug}', 'AY 2026 B', '2026-01-01', '2026-12-31', 'active'),
         ('${uid.yearB2}', '${uid.tenantB}', 'sf-yb2-${slug}', 'AY 2027 B', '2027-01-01', '2027-12-31', 'draft')`,
    );
    await migrator.query(
      `insert into files (id, tenant_id, storage_key, original_name, mime, size_bytes, content_hash, scan_status) values
         ('${uid.fileA}', '${uid.tenantA}', 'tenants/${uid.tenantA}/students/${uid.fileA}/a.pdf', 'a.pdf', 'application/pdf', 100, 'abc', 'clean'),
         ('${uid.fileB}', '${uid.tenantB}', 'tenants/${uid.tenantB}/students/${uid.fileB}/b.pdf', 'b.pdf', 'application/pdf', 100, 'def', 'clean')`,
    );
    await migrator.query(
      `insert into students (id, tenant_id, student_no, first_name, last_name, status, primary_campus_id, photo_file_id) values
         ('${uid.studentA}', '${uid.tenantA}', 'sn-a-${slug}', 'Alice', 'Anderson', 'active', '${uid.campusA}', '${uid.fileA}'),
         ('${uid.studentB}', '${uid.tenantB}', 'sn-b-${slug}', 'Bob', 'Brown', 'active', '${uid.campusB}', '${uid.fileB}')`,
    );
    await migrator.query(
      `insert into guardians (id, tenant_id, first_name, last_name, email) values
         ('${uid.guardianA}', '${uid.tenantA}', 'Gina', 'Alt', 'gina@example.com'),
         ('${uid.guardianB}', '${uid.tenantB}', 'Gary', 'Blue', 'gary@example.com')`,
    );
    await migrator.query(
      `insert into student_guardians (id, tenant_id, student_id, guardian_id, relation, is_primary, can_pickup) values
         ('${uid.relA}', '${uid.tenantA}', '${uid.studentA}', '${uid.guardianA}', 'mother', true, true),
         ('${uid.relB}', '${uid.tenantB}', '${uid.studentB}', '${uid.guardianB}', 'mother', true, true)`,
    );
    await migrator.query(
      `insert into enrollments (id, tenant_id, student_id, academic_year_id, status) values
         ('${uid.enrollA}', '${uid.tenantA}', '${uid.studentA}', '${uid.yearA}', 'active'),
         ('${uid.enrollB}', '${uid.tenantB}', '${uid.studentB}', '${uid.yearB}', 'active')`,
    );
    await migrator.query(
      `insert into student_documents (id, tenant_id, student_id, document_type, file_id) values
         ('${uid.docA}', '${uid.tenantA}', '${uid.studentA}', 'birth_certificate', '${uid.fileA}'),
         ('${uid.docB}', '${uid.tenantB}', '${uid.studentB}', 'birth_certificate', '${uid.fileB}')`,
    );
    await migrator.query(
      `insert into admission_applications (id, tenant_id, student_id, status, snapshot) values
         ('${uid.admA}', '${uid.tenantA}', '${uid.studentA}', 'accepted', '{}'),
         ('${uid.admB}', '${uid.tenantB}', '${uid.studentB}', 'accepted', '{}')`,
    );
    await migrator.query(
      `insert into transfers (id, tenant_id, student_id, type, status) values
         ('${uid.transferA}', '${uid.tenantA}', '${uid.studentA}', 'in', 'completed'),
         ('${uid.transferB}', '${uid.tenantB}', '${uid.studentB}', 'in', 'completed')`,
    );
    await migrator.query(
      `insert into promotion_batches (id, tenant_id, from_academic_year_id, to_academic_year_id, status) values
         ('${uid.batchA}', '${uid.tenantA}', '${uid.yearA}', '${uid.yearA2}', 'completed'),
         ('${uid.batchB}', '${uid.tenantB}', '${uid.yearB}', '${uid.yearB2}', 'completed')`,
    );
    await migrator.query(
      `insert into promotion_items (id, tenant_id, batch_id, student_id, from_academic_year_id, to_academic_year_id, status) values
         ('${uid.itemA}', '${uid.tenantA}', '${uid.batchA}', '${uid.studentA}', '${uid.yearA}', '${uid.yearA2}', 'promoted'),
         ('${uid.itemB}', '${uid.tenantB}', '${uid.batchB}', '${uid.studentB}', '${uid.yearB}', '${uid.yearB2}', 'promoted')`,
    );
    await migrator.query('commit');
  });

  afterAll(async () => {
    try {
      await migrator.query('begin');
      const tenantIds = `'${uid.tenantA}','${uid.tenantB}','${uid.legacyTenant}','${uid.legacyTenantB}'`;
      await migrator.query(
        `delete from promotion_items where tenant_id in (${tenantIds})`,
      );
      await migrator.query(
        `delete from promotion_batches where tenant_id in (${tenantIds})`,
      );
      await migrator.query(`delete from transfers where tenant_id in (${tenantIds})`);
      await migrator.query(
        `delete from admission_applications where tenant_id in (${tenantIds})`,
      );
      await migrator.query(`delete from student_documents where tenant_id in (${tenantIds})`);
      await migrator.query(`delete from enrollments where tenant_id in (${tenantIds})`);
      await migrator.query(
        `delete from student_guardians where tenant_id in (${tenantIds})`,
      );
      await migrator.query(`delete from guardians where tenant_id in (${tenantIds})`);
      await migrator.query(`delete from students where tenant_id in (${tenantIds})`);
      await migrator.query(`delete from files where tenant_id in (${tenantIds})`);
      await migrator.query(`delete from role_permissions where role_id in ('${uid.legacyOwnerRole}','${uid.legacyCustomRole}')`);
      await migrator.query(`delete from roles where id in ('${uid.legacyOwnerRole}','${uid.legacyCustomRole}')`);
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
    it('1. RLS is enabled AND forced on all ten new tables', async () => {
      const res = await migrator.query<{ tbl: string; rls: boolean; force: boolean }>(
        `
        select c.relname tbl, c.relrowsecurity rls, c.relforcerowsecurity force
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname = ANY($1)
        order by c.relname`,
        [TABLES],
      );
      expect(res.rows).toHaveLength(TABLES.length);
      for (const row of res.rows) {
        expect(row.rls).toBe(true);
        expect(row.force).toBe(true);
      }
    });

    it('2. school_app_rw has DML grants but sees zero rows without a context', async () => {
      const grants = await migQ<{ s: boolean; i: boolean; u: boolean; d: boolean }>(`
        select has_table_privilege('school_app_rw', 'students', 'SELECT') s,
               has_table_privilege('school_app_rw', 'students', 'INSERT') i,
               has_table_privilege('school_app_rw', 'students', 'UPDATE') u,
               has_table_privilege('school_app_rw', 'students', 'DELETE') d`);
      expect(grants[0]).toEqual({ s: true, i: true, u: true, d: true });
      for (const t of TABLES) {
        const r = await appQ<{ n: number }>(`select count(*)::int n from "${t}"`);
        expect(Number(r[0]!.n), t).toBe(0);
      }
    });

    it('3. tenant A context sees exactly its own rows, never tenant B', async () => {
      await tenantA(async () => {
        const own: Array<{ tbl: string; n: number }> = [];
        const foreign: Array<{ tbl: string; n: number }> = [];
        for (const t of TABLES) {
          const o = (await appQ<{ n: number }>(
            `select count(*)::int n from "${t}" where tenant_id = '${uid.tenantA}'`,
          ))[0]!.n;
          const f = (await appQ<{ n: number }>(
            `select count(*)::int n from "${t}" where tenant_id = '${uid.tenantB}'`,
          ))[0]!.n;
          own.push({ tbl: t, n: Number(o) });
          foreign.push({ tbl: t, n: Number(f) });
        }
        for (const row of own) expect(row.n, row.tbl).toBeGreaterThan(0);
        for (const row of foreign) expect(row.n, row.tbl).toBe(0);
      });
    });

    it('4. cross-tenant INSERT is rejected for every new table', async () => {
      await tenantA(async () => {
        const inserts: Record<string, string> = {
          files: `insert into files (id, tenant_id, storage_key, original_name, mime, size_bytes)
                  values ('${randomUUID()}', '${uid.tenantB}', 'tenants/${uid.tenantB}/x/x.png', 'x.png', 'image/png', 1)`,
          students: `insert into students (id, tenant_id, student_no, first_name, last_name)
                     values ('${randomUUID()}', '${uid.tenantB}', 'xf-${slug}', 'X', 'Y')`,
          guardians: `insert into guardians (id, tenant_id, first_name, last_name)
                      values ('${randomUUID()}', '${uid.tenantB}', 'X', 'Y')`,
          student_guardians: `insert into student_guardians (id, tenant_id, student_id, guardian_id, relation)
                              values ('${randomUUID()}', '${uid.tenantB}', '${uid.studentB}', '${uid.guardianB}', 'mother')`,
          enrollments: `insert into enrollments (id, tenant_id, student_id, academic_year_id)
                        values ('${randomUUID()}', '${uid.tenantB}', '${uid.studentB}', '${uid.yearB}')`,
          student_documents: `insert into student_documents (id, tenant_id, student_id, document_type, file_id)
                              values ('${randomUUID()}', '${uid.tenantB}', '${uid.studentB}', 'doc', '${uid.fileB}')`,
          admission_applications: `insert into admission_applications (id, tenant_id, student_id, status)
                                   values ('${randomUUID()}', '${uid.tenantB}', '${uid.studentB}', 'draft')`,
          transfers: `insert into transfers (id, tenant_id, student_id, type)
                      values ('${randomUUID()}', '${uid.tenantB}', '${uid.studentB}', 'in')`,
          promotion_batches: `insert into promotion_batches (id, tenant_id, from_academic_year_id, to_academic_year_id)
                              values ('${randomUUID()}', '${uid.tenantB}', '${uid.yearB}', '${uid.yearB2}')`,
          promotion_items: `insert into promotion_items (id, tenant_id, batch_id, student_id, from_academic_year_id, to_academic_year_id)
                            values ('${randomUUID()}', '${uid.tenantB}', '${uid.batchB}', '${uid.studentB}', '${uid.yearB}', '${uid.yearB2}')`,
        };
        for (const t of TABLES) {
          await rejectCode(() => app.query(inserts[t]!), '42501');
        }
      });
    });

    it('5. cross-tenant UPDATE changes nothing; no tenant_id rewrite', async () => {
      await tenantA(async () => {
        const upd = await app.query(
          `update students set last_name = 'owned' where tenant_id = '${uid.tenantB}'`,
        );
        expect(upd.rowCount).toBe(0);
        await rejectCode(
          () =>
            app
              .query(
                `insert into students (id, tenant_id, student_no, first_name, last_name)
                 values ('${randomUUID()}', '${uid.tenantA}', 'rewrite-${slug}', 'Own', 'Row')`,
              )
              .then(() =>
                app.query(
                  `update students set tenant_id = '${uid.tenantB}' where student_no = 'rewrite-${slug}'`,
                ),
              ),
          '42501',
        );
      });
    });

    it('6. the runtime role has no DELETE path (privileged-only policy)', async () => {
      await tenantA(async () => {
        for (const t of TABLES) {
          const del = await app.query(
            `delete from "${t}" where tenant_id = '${uid.tenantA}'`,
          );
          expect(del.rowCount, t).toBe(0);
        }
      });
    });

    it('7. cross-tenant composite FK parents are rejected', async () => {
      await tenantA(async () => {
        // enrollments: student and year must share the tenant context.
        await rejectCode(
          () =>
            app.query(
              `insert into enrollments (id, tenant_id, student_id, academic_year_id)
               values ('${randomUUID()}', '${uid.tenantA}', '${uid.studentB}', '${uid.yearA}')`,
            ),
          '23503',
        );
        await rejectCode(
          () =>
            app.query(
              `insert into enrollments (id, tenant_id, student_id, academic_year_id)
               values ('${randomUUID()}', '${uid.tenantA}', '${uid.studentA}', '${uid.yearB}')`,
            ),
          '23503',
        );
        // student_guardians: guardian must belong to the tenant.
        await rejectCode(
          () =>
            app.query(
              `insert into student_guardians (id, tenant_id, student_id, guardian_id, relation)
               values ('${randomUUID()}', '${uid.tenantA}', '${uid.studentA}', '${uid.guardianB}', 'mother')`,
            ),
          '23503',
        );
        // student_documents: file must belong to the tenant.
        await rejectCode(
          () =>
            app.query(
              `insert into student_documents (id, tenant_id, student_id, document_type, file_id)
               values ('${randomUUID()}', '${uid.tenantA}', '${uid.studentA}', 'doc', '${uid.fileB}')`,
            ),
          '23503',
        );
        // transfers: student must belong to the tenant.
        await rejectCode(
          () =>
            app.query(
              `insert into transfers (id, tenant_id, student_id, type)
               values ('${randomUUID()}', '${uid.tenantA}', '${uid.studentB}', 'in')`,
            ),
          '23503',
        );
        // admission_applications: student must belong to the tenant.
        await rejectCode(
          () =>
            app.query(
              `insert into admission_applications (id, tenant_id, student_id, status)
               values ('${randomUUID()}', '${uid.tenantA}', '${uid.studentB}', 'draft')`,
            ),
          '23503',
        );
        // promotion_items: batch and student must belong to the tenant.
        await rejectCode(
          () =>
            app.query(
              `insert into promotion_items (id, tenant_id, batch_id, student_id, from_academic_year_id, to_academic_year_id)
               values ('${randomUUID()}', '${uid.tenantA}', '${uid.batchB}', '${uid.studentA}', '${uid.yearA}', '${uid.yearA}')`,
            ),
          '23503',
        );
      });
    });

    it('8. legacy forgeable GUCs grant nothing on the new tables', async () => {
      await app.query('begin');
      await app.query(`select set_config('app.platform_access', 'on', true)`);
      await app.query(`select set_config('app.current_tenant', '${uid.tenantA}', true)`);
      await app.query(`select set_config('app.current_user', '${uid.userA}', true)`);
      const r = await appQ<{ n: number }>(`select count(*)::int n from students`);
      await app.query('rollback');
      expect(Number(r[0]!.n)).toBe(0);
    });

    it('9. positive control: tenant A can create rows across the foundation', async () => {
      await tenantA(async () => {
        const posStudentId = randomUUID();
        const st = await app.query(
          `insert into students (id, tenant_id, student_no, first_name, last_name, status)
           values ('${posStudentId}', '${uid.tenantA}', 'pos-${slug}', 'Pos', 'Plus', 'active')`,
        );
        const gu = await app.query(
          `insert into guardians (id, tenant_id, first_name, last_name)
           values ('${randomUUID()}', '${uid.tenantA}', 'Pos', 'Guard')`,
        );
        const fl = await app.query(
          `insert into files (id, tenant_id, storage_key, original_name, mime, size_bytes, scan_status)
           values ('${randomUUID()}', '${uid.tenantA}', 'tenants/${uid.tenantA}/pos/p.pdf', 'p.pdf', 'application/pdf', 1, 'pending')`,
        );
        const en = await app.query(
          `insert into enrollments (id, tenant_id, student_id, academic_year_id, status)
           values ('${randomUUID()}', '${uid.tenantA}', '${posStudentId}', '${uid.yearA}', 'active')`,
        );
        expect(st.rowCount).toBe(1);
        expect(gu.rowCount).toBe(1);
        expect(fl.rowCount).toBe(1);
        expect(en.rowCount).toBe(1);
      });
    });

    it('9a. nested-query isolation: children of a FOREIGN parent are invisible', async () => {
      await tenantA(async () => {
        // Enrollments/documents of tenant B's student are invisible to tenant A
        // even querying only by parent id (the API-style getter shape).
        const enOfB = await appQ<{ n: number }>(
          `select count(*)::int n from enrollments where student_id = '${uid.studentB}'`,
        );
        const docsOfB = await appQ<{ n: number }>(
          `select count(*)::int n from student_documents where student_id = '${uid.studentB}'`,
        );
        const relOfB = await appQ<{ n: number }>(
          `select count(*)::int n from student_guardians where guardian_id = '${uid.guardianB}'`,
        );
        expect(Number(enOfB[0]!.n)).toBe(0);
        expect(Number(docsOfB[0]!.n)).toBe(0);
        expect(Number(relOfB[0]!.n)).toBe(0);
        // Positive controls.
        const enOfA = await appQ<{ n: number }>(
          `select count(*)::int n from enrollments where student_id = '${uid.studentA}'`,
        );
        expect(Number(enOfA[0]!.n)).toBeGreaterThan(0);
      });
    });

    it('9b. the privileged executor can work cross-tenant', async () => {
      const rows = await migQ<{ n: number }>(
        `select count(*)::int n from students where tenant_id in ('${uid.tenantA}','${uid.tenantB}')`,
      );
      expect(Number(rows[0]!.n)).toBe(2);
    });
  });

  describe('B. domain constraints', () => {
    it('10. duplicate student_no within a tenant is rejected; cross-tenant is allowed', async () => {
      await tenantA(async () => {
        await rejectCode(
          () =>
            app.query(
              `insert into students (id, tenant_id, student_no, first_name, last_name)
               values ('${randomUUID()}', '${uid.tenantA}', 'sn-a-${slug}', 'Dup', 'No')`,
            ),
          '23505',
        );
        const cross = await app.query(
          `insert into students (id, tenant_id, student_no, first_name, last_name)
           values ('${randomUUID()}', '${uid.tenantA}', 'sn-b-${slug}', 'Cross', 'Tenant')`,
        );
        expect(cross.rowCount).toBe(1);
      });
    });

    it('11. duplicate enrollment (student, academic_year) is rejected', async () => {
      await tenantA(async () => {
        await rejectCode(
          () =>
            app.query(
              `insert into enrollments (id, tenant_id, student_id, academic_year_id)
               values ('${randomUUID()}', '${uid.tenantA}', '${uid.studentA}', '${uid.yearA}')`,
            ),
          '23505',
        );
      });
    });

    it('12. unknown status values are rejected by CHECK constraints', async () => {
      await tenantA(async () => {
        await rejectCode(
          () =>
            app.query(
              `insert into students (id, tenant_id, student_no, first_name, last_name, status)
               values ('${randomUUID()}', '${uid.tenantA}', 'badst-${slug}', 'Bad', 'St', 'ghost')`,
            ),
          '23514',
        );
        await rejectCode(
          () =>
            app.query(
              `insert into files (id, tenant_id, storage_key, original_name, mime, size_bytes, scan_status)
               values ('${randomUUID()}', '${uid.tenantA}', 'tenants/${uid.tenantA}/bad/b.pdf', 'b.pdf', 'application/pdf', 1, 'infected')`,
            ),
          '23514',
        );
        await rejectCode(
          () =>
            app.query(
              `insert into transfers (id, tenant_id, student_id, type)
               values ('${randomUUID()}', '${uid.tenantA}', '${uid.studentA}', 'sideways')`,
            ),
          '23514',
        );
      });
    });

    it('13. promotion batch requires distinct from/to years', async () => {
      await tenantA(async () => {
        await rejectCode(
          () =>
            app.query(
              `insert into promotion_batches (id, tenant_id, from_academic_year_id, to_academic_year_id)
               values ('${randomUUID()}', '${uid.tenantA}', '${uid.yearA}', '${uid.yearA}')`,
            ),
          '23514',
        );
      });
    });

    it('14. duplicate student_guardians (student, guardian, relation) is rejected', async () => {
      await tenantA(async () => {
        await rejectCode(
          () =>
            app.query(
              `insert into student_guardians (id, tenant_id, student_id, guardian_id, relation)
               values ('${randomUUID()}', '${uid.tenantA}', '${uid.studentA}', '${uid.guardianA}', 'mother')`,
            ),
          '23505',
        );
      });
    });
  });

  describe('C. existing-tenant permission backfill', () => {
    let backfillSql = '';

    beforeAll(async () => {
      // Extract the EXACT backfill statement shipped in migration 0005 so this
      // suite always exercises the migration SQL, not a copy.
      const migration = await readFile(
        new URL('../../migrations/0005_students_foundation.sql', import.meta.url),
        'utf8',
      );
      const lines = migration.split('\n');
      const start = lines.findIndex((l) => l.includes('PHASE 3.1 PERMISSION BACKFILL'));
      const end = lines.findIndex((l) => l.includes('END PHASE 3.1 PERMISSION BACKFILL'));
      expect(start).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      backfillSql = lines.slice(start + 1, end).join('\n');
    });

    it('15. grants the Phase 3.1 set to legacy system template roles only, idempotently', async () => {
      // Simulate a tenant created BEFORE migration 0005: its system roles carry
      // the old template permission set (no Phase 3 permissions). A second
      // legacy tenant holds a NON-system custom role that reuses a template
      // code, the case the is_system guard must refuse.
      await migrator.query('begin');
      await migrator.query(
        `insert into roles (id, tenant_id, scope, code, name, is_system) values
           ('${uid.legacyOwnerRole}', '${uid.legacyTenant}', 'tenant', 'school_owner', 'Legacy Owner', true),
           ('${uid.legacyCustomRole}', '${uid.legacyTenantB}', 'tenant', 'school_owner', 'Custom Copy', false)`,
      );
      await migrator.query(
        `insert into role_permissions (role_id, permission)
         select '${uid.legacyOwnerRole}', permission
         from unnest(array['tenant.read','audit.read']) as permission`,
      );
      await migrator.query('commit');

      // First application of the backfill.
      await migrator.query('begin');
      await migrator.query(backfillSql);
      await migrator.query('commit');

      const ownerGrants = await migQ<{ permission: string }>(
        `select permission from role_permissions where role_id = '${uid.legacyOwnerRole}' order by permission`,
      );
      const ownerSet = new Set(ownerGrants.map((r) => r.permission));
      for (const p of PHASE_3_OWNER_PERMISSIONS) expect(ownerSet.has(p), p).toBe(true);

      // Principal read-only subset is applied too.
      const principalRole = randomUUID();
      await migrator.query(
        `insert into roles (id, tenant_id, scope, code, name, is_system) values
           ('${principalRole}', '${uid.legacyTenant}', 'tenant', 'principal', 'Legacy Principal', true)`,
      );
      await migrator.query('begin');
      await migrator.query(backfillSql);
      await migrator.query('commit');
      const principalGrants = await migQ<{ permission: string }>(
        `select permission from role_permissions where role_id = '${principalRole}' order by permission`,
      );
      const principalSet = new Set(principalGrants.map((r) => r.permission));
      expect(principalSet.has('students.read')).toBe(true);
      expect(principalSet.has('guardians.read')).toBe(true);
      expect(principalSet.has('enrollment.read')).toBe(true);
      expect(principalSet.has('students.create')).toBe(false);
      expect(principalSet.has('enrollment.manage')).toBe(false);

      // Idempotency: a second application adds nothing.
      const before = await migQ<{ n: number }>(
        `select count(*)::int n from role_permissions where role_id = '${uid.legacyOwnerRole}'`,
      );
      await migrator.query('begin');
      await migrator.query(backfillSql);
      await migrator.query('commit');
      const after = await migQ<{ n: number }>(
        `select count(*)::int n from role_permissions where role_id = '${uid.legacyOwnerRole}'`,
      );
      expect(Number(after[0]!.n)).toBe(Number(before[0]!.n));

      // Custom (non-system) roles with a matching template code are NEVER touched.
      const customGrants = await migQ<{ n: number }>(
        `select count(*)::int n from role_permissions where role_id = '${uid.legacyCustomRole}'`,
      );
      expect(Number(customGrants[0]!.n)).toBe(0);

      await migrator.query(
        `delete from role_permissions where role_id = '${principalRole}'`,
      );
      await migrator.query(`delete from roles where id = '${principalRole}'`);
    });
  });
});