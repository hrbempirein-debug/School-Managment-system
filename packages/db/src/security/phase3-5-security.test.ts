import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { getEnv } from '@sms/config';

/**
 * Phase 3.5 import/admission-link RLS + constraints + permission backfill proofs,
 * run against the REAL roles and REAL disposable test database. Requires migration 0007.
 *
 * Section A (row-level security): student_imports + student_import_rows are FORCE
 * RLS; a bare app_rw session sees nothing; a signed tenant context sees exactly its
 * own rows; cross-tenant INSERT is rejected; the runtime role has no DELETE path;
 * composite (tenant_id, ...) FKs reject cross-tenant parents (import->student,
 * import->campus, row->import).
 *
 * Section B (domain constraints): status CHECK bounds, row-result bucket CHECK
 * (created implies student_id, others forbid it), per-import row_number uniqueness,
 * globally-unique storage_key, and the partial unique admission<->student linkage.
 *
 * Section C (permission backfill): the exact 0007 PHASE 3.5 PERMISSION BACKFILL
 * statement is extracted and applied to a simulated pre-0007 tenant: school_owner
 * gains admission.read/create/update/review, principal admission.read only, runs
 * idempotently, and never touches non-system custom roles.
 *
 * Opt-in: RUN_RUNTIME_SECURITY_TESTS=1 (requires PostgreSQL + migrations 0001..0007).
 */
const enabled = process.env.RUN_RUNTIME_SECURITY_TESTS === '1';
const describeDb = enabled ? describe : describe.skip;

const TABLES = ['student_imports', 'student_import_rows'];

const PHASE_3_5_OWNER_PERMISSIONS = [
  'admission.read',
  'admission.create',
  'admission.update',
  'admission.review',
];

describeDb('phase 3.5 imports RLS + constraints + permission backfill (school_saas_test)', () => {
  let migrator: pg.Client;
  let app: pg.Client;
  const uid: Record<string, string> = {};
  const slug = 'p35' + randomUUID().slice(0, 8);

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
    uid.campusB = randomUUID();
    uid.studentA = randomUUID();
    uid.studentB = randomUUID();
    uid.importA = randomUUID();
    uid.importB = randomUUID();
    uid.rowA = randomUUID();
    uid.rowA2 = randomUUID();
    uid.rowB = randomUUID();
    uid.legacyTenant = randomUUID();
    uid.legacyTenantB = randomUUID();
    uid.legacyOwnerRole = randomUUID();
    uid.legacyCustomRole = randomUUID();

    await migrator.query('begin');
    await migrator.query(
      `insert into tenants (id, slug, name) values
         ('${uid.tenantA}', '${slug}-a', 'Phase 35 A'),
         ('${uid.tenantB}', '${slug}-b', 'Phase 35 B'),
         ('${uid.legacyTenant}', '${slug}-legacy', 'Legacy Pre-Phase-3.5 Tenant'),
         ('${uid.legacyTenantB}', '${slug}-legacy-b', 'Legacy Pre-Phase-3.5 Tenant B')`,
    );
    await migrator.query(
      `insert into users (id, email) values
         ('${uid.userA}', 'p35-a-${slug}@example.com'),
         ('${uid.userB}', 'p35-b-${slug}@example.com')`,
    );
    await migrator.query(
      `insert into memberships (id, tenant_id, user_id, status) values
         ('${randomUUID()}', '${uid.tenantA}', '${uid.userA}', 'active'),
         ('${randomUUID()}', '${uid.tenantB}', '${uid.userB}', 'active')`,
    );
    await migrator.query(
      `insert into campuses (id, tenant_id, code, name, status) values
         ('${uid.campusA}', '${uid.tenantA}', 'p35-ca-${slug}', 'Campus A', 'active'),
         ('${uid.campusB}', '${uid.tenantB}', 'p35-cb-${slug}', 'Campus B', 'active')`,
    );
    await migrator.query(
      `insert into students (id, tenant_id, student_no, first_name, last_name, status, primary_campus_id) values
         ('${uid.studentA}', '${uid.tenantA}', 'p35-sa-${slug}', 'Alice', 'Anderson', 'applicant', '${uid.campusA}'),
         ('${uid.studentB}', '${uid.tenantB}', 'p35-sb-${slug}', 'Bob', 'Brown', 'applicant', '${uid.campusB}')`,
    );
    await migrator.query(
      `insert into admission_applications (id, tenant_id, student_id, status) values
         ('${randomUUID()}', '${uid.tenantA}', '${uid.studentA}', 'draft')`,
    );
    await migrator.query(
      `insert into student_imports (id, tenant_id, campus_id, filename, storage_key, status, total_rows, created_count, duplicate_count, conflict_count, rejected_count) values
         ('${uid.importA}', '${uid.tenantA}', '${uid.campusA}', 'a.csv', 'imports/k-a-${slug}.csv', 'completed', 2, 2, 0, 0, 0),
         ('${uid.importB}', '${uid.tenantB}', null, 'b.csv', 'imports/k-b-${slug}.csv', 'completed', 1, 1, 0, 0, 0)`,
    );
    await migrator.query(
      `insert into student_import_rows (id, tenant_id, import_id, row_number, status, student_id, field, message) values
         ('${uid.rowA}', '${uid.tenantA}', '${uid.importA}', 1, 'created', '${uid.studentA}', null, null),
         ('${uid.rowA2}', '${uid.tenantA}', '${uid.importA}', 2, 'rejected', null, 'gender', 'invalid gender'),
         ('${uid.rowB}', '${uid.tenantB}', '${uid.importB}', 1, 'created', '${uid.studentB}', null, null)`,
    );
    await migrator.query('commit');
  });

  afterAll(async () => {
    try {
      await migrator.query('begin');
      const tenantIds = `'${uid.tenantA}','${uid.tenantB}','${uid.legacyTenant}','${uid.legacyTenantB}'`;
      await migrator.query(`delete from student_import_rows where tenant_id in (${tenantIds})`);
      await migrator.query(`delete from student_imports where tenant_id in (${tenantIds})`);
      await migrator.query(`delete from admission_applications where tenant_id in (${tenantIds})`);
      await migrator.query(`delete from students where tenant_id in (${tenantIds})`);
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
    it('1. RLS is enabled AND forced on student_imports + student_import_rows', async () => {
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

    it('2. school_app_rw sees zero rows without a context', async () => {
      for (const t of TABLES) {
        const r = await appQ<{ n: number }>(`select count(*)::int n from "${t}"`);
        expect(Number(r[0]!.n), t).toBe(0);
      }
    });

    it('3. tenant A context sees exactly its own import rows, never tenant B', async () => {
      await tenantA(async () => {
        for (const t of TABLES) {
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

    it('4. cross-tenant INSERT is rejected for both import tables', async () => {
      await tenantA(async () => {
        await rejectCode(
          () =>
            app.query(
              `insert into student_imports (id, tenant_id, filename, storage_key)
               values ('${randomUUID()}', '${uid.tenantB}', 'x.csv', 'imports/x-${slug}.csv')`,
            ),
          '42501',
        );
        await rejectCode(
          () =>
            app.query(
              `insert into student_import_rows (id, tenant_id, import_id, row_number, status, student_id)
               values ('${randomUUID()}', '${uid.tenantB}', '${uid.importB}', 9, 'created', '${uid.studentB}')`,
            ),
          '42501',
        );
      });
    });

    it('5. no runtime-role DELETE path; no tenant_id rewrite', async () => {
      await tenantA(async () => {
        for (const t of TABLES) {
          const del = await app.query(`delete from "${t}" where tenant_id = '${uid.tenantA}'`);
          expect(del.rowCount, t).toBe(0);
        }
        await rejectCode(
          () =>
            app
              .query(
                `insert into student_imports (id, tenant_id, filename, storage_key)
                 values ('${randomUUID()}', '${uid.tenantA}', 'rw.csv', 'imports/rw-${slug}.csv')`,
              )
              .then(() =>
                app.query(
                  `update student_imports set tenant_id = '${uid.tenantB}' where filename = 'rw.csv'`,
                ),
              ),
          '42501',
        );
      });
    });

    it('6. cross-tenant composite FK parents are rejected', async () => {
      await tenantA(async () => {
        // row -> import: tenant B's import is not a valid parent in tenant A.
        await rejectCode(
          () =>
            app.query(
              `insert into student_import_rows (id, tenant_id, import_id, row_number, status, student_id)
               values ('${randomUUID()}', '${uid.tenantA}', '${uid.importB}', 9, 'created', '${uid.studentA}')`,
            ),
          '23503',
        );
        // row -> student: tenant B's student is not a valid child in tenant A.
        await rejectCode(
          () =>
            app.query(
              `insert into student_import_rows (id, tenant_id, import_id, row_number, status, student_id)
               values ('${randomUUID()}', '${uid.tenantA}', '${uid.importA}', 9, 'created', '${uid.studentB}')`,
            ),
          '23503',
        );
        // import -> campus: tenant B's campus is not a valid scope in tenant A.
        await rejectCode(
          () =>
            app.query(
              `insert into student_imports (id, tenant_id, campus_id, filename, storage_key)
               values ('${randomUUID()}', '${uid.tenantA}', '${uid.campusB}', 'c.csv', 'imports/c-${slug}.csv')`,
            ),
          '23503',
        );
      });
    });

    it('7. nested-query isolation: tenant A never sees tenant B rows by foreign id', async () => {
      await tenantA(async () => {
        const rowsOfB = await appQ<{ n: number }>(
          `select count(*)::int n from student_import_rows where import_id = '${uid.importB}'`,
        );
        const impOfB = await appQ<{ n: number }>(
          `select count(*)::int n from student_imports where id = '${uid.importB}'`,
        );
        expect(Number(rowsOfB[0]!.n)).toBe(0);
        expect(Number(impOfB[0]!.n)).toBe(0);
        // Positive control.
        const rowsOfA = await appQ<{ n: number }>(
          `select count(*)::int n from student_import_rows where import_id = '${uid.importA}'`,
        );
        expect(Number(rowsOfA[0]!.n)).toBeGreaterThan(0);
      });
    });

    it('8. positive control: tenant A can write new import records', async () => {
      await tenantA(async () => {
        const imp = await app.query(
          `insert into student_imports (id, tenant_id, campus_id, filename, storage_key, status)
           values ('${randomUUID()}', '${uid.tenantA}', '${uid.campusA}', 'pos.csv', 'imports/pos-${slug}.csv', 'submitted')`,
        );
        expect(imp.rowCount).toBe(1);
      });
    });
  });

  describe('B. domain constraints', () => {
    it('9. unknown import status is rejected by CHECK', async () => {
      await tenantA(async () => {
        await rejectCode(
          () =>
            app.query(
              `insert into student_imports (id, tenant_id, filename, storage_key, status)
               values ('${randomUUID()}', '${uid.tenantA}', 'bad.csv', 'imports/bad-${slug}.csv', 'paused')`,
            ),
          '23514',
        );
      });
    });

    it('10. duplicate storage_key across the whole schema is rejected', async () => {
      await tenantA(async () => {
        await rejectCode(
          () =>
            app.query(
              `insert into student_imports (id, tenant_id, filename, storage_key)
               values ('${randomUUID()}', '${uid.tenantA}', 'dupe.csv', 'imports/k-a-${slug}.csv')`,
            ),
          '23505',
        );
      });
    });

    it('11. duplicate row_number within an import is rejected', async () => {
      await tenantA(async () => {
        await rejectCode(
          () =>
            app.query(
              `insert into student_import_rows (id, tenant_id, import_id, row_number, status, student_id)
               values ('${randomUUID()}', '${uid.tenantA}', '${uid.importA}', 1, 'created', '${uid.studentA}')`,
            ),
          '23505',
        );
      });
    });

    it('12. row result buckets are exact (created implies student_id; others forbid it)', async () => {
      await tenantA(async () => {
        // created without a student is denied.
        await rejectCode(
          () =>
            app.query(
              `insert into student_import_rows (id, tenant_id, import_id, row_number, status, student_id)
               values ('${randomUUID()}', '${uid.tenantA}', '${uid.importA}', 30, 'created', null)`,
            ),
          '23514',
        );
        // non-created with a student is denied.
        await rejectCode(
          () =>
            app.query(
              `insert into student_import_rows (id, tenant_id, import_id, row_number, status, student_id)
               values ('${randomUUID()}', '${uid.tenantA}', '${uid.importA}', 31, 'conflict', '${uid.studentA}')`,
            ),
          '23514',
        );
        // unknown bucket is denied.
        await rejectCode(
          () =>
            app.query(
              `insert into student_import_rows (id, tenant_id, import_id, row_number, status, student_id)
               values ('${randomUUID()}', '${uid.tenantA}', '${uid.importA}', 32, 'skipped', null)`,
            ),
          '23514',
        );
      });
    });

    it('13. a live admission application may link a student only once', async () => {
      await tenantA(async () => {
        // uid.studentA is a live applicant linked by import row uid.rowA; try to
        // attach a second live application to it.
        await rejectCode(
          () =>
            app.query(
              `insert into admission_applications (id, tenant_id, student_id, status)
               values ('${randomUUID()}', '${uid.tenantA}', '${uid.studentA}', 'accepted')`,
            ),
          '23505',
        );
        // A soft-deleted application may reuse the link (history is not constrained).
        const soft = await app.query(
          `insert into admission_applications (id, tenant_id, student_id, status, deleted_at)
           values ('${randomUUID()}', '${uid.tenantA}', '${uid.studentA}', 'withdrawn', now())`,
        );
        expect(soft.rowCount).toBe(1);
      });
    });
  });

  describe('C. existing-tenant permission backfill', () => {
    let backfillSql = '';

    beforeAll(async () => {
      const migration = await readFile(
        new URL('../../migrations/0007_student_imports_admission_link.sql', import.meta.url),
        'utf8',
      );
      const lines = migration.split('\n');
      const start = lines.findIndex((l) => l.includes('PHASE 3.5 PERMISSION BACKFILL'));
      const end = lines.findIndex((l) => l.includes('END PHASE 3.5 PERMISSION BACKFILL'));
      expect(start).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      backfillSql = lines.slice(start + 1, end).join('\n');
    });

    it('14. grants the Phase 3.5 set to legacy system template roles only, idempotently', async () => {
      await migrator.query('begin');
      await migrator.query(
        `insert into roles (id, tenant_id, scope, code, name, is_system) values
           ('${uid.legacyOwnerRole}', '${uid.legacyTenant}', 'tenant', 'school_owner', 'Legacy Owner', true),
           ('${uid.legacyCustomRole}', '${uid.legacyTenantB}', 'tenant', 'school_owner', 'Custom Copy', false)`,
      );
      await migrator.query('commit');

      await migrator.query('begin');
      await migrator.query(backfillSql);
      await migrator.query('commit');

      const ownerGrants = await migQ<{ permission: string }>(
        `select permission from role_permissions where role_id = '${uid.legacyOwnerRole}' order by permission`,
      );
      const ownerSet = new Set(ownerGrants.map((r) => r.permission));
      for (const p of PHASE_3_5_OWNER_PERMISSIONS) expect(ownerSet.has(p), p).toBe(true);

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
      expect(principalSet.has('admission.read')).toBe(true);
      expect(principalSet.has('admission.create')).toBe(false);
      expect(principalSet.has('admission.review')).toBe(false);

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

      const customGrants = await migQ<{ n: number }>(
        `select count(*)::int n from role_permissions where role_id = '${uid.legacyCustomRole}'`,
      );
      expect(Number(customGrants[0]!.n)).toBe(0);

      await migrator.query(`delete from role_permissions where role_id = '${principalRole}'`);
      await migrator.query(`delete from roles where id = '${principalRole}'`);
    });
  });
});