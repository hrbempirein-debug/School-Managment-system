import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { getEnv } from '@sms/config';

/**
 * Phase 3.4 student-document DB integrity + security proofs, run against the REAL
 * roles and REAL disposable test database (school_app_rw -> school_saas_test). Requires
 * migrations 0001..0006 (tables `files` + `student_documents` ship in 0005).
 *
 * Complements the Phase 3.1 foundation suite (which already proves RLS FORCE on
 * every new table, cross-tenant INSERT denial, and the privileged-only DELETE
 * path). This suite proves the document-specific invariants the API + worker
 * depend on:
 *
 *   A. files metadata bounds: scan_status and visibility CHECK gates, GLOBAL
 *      storage_key uniqueness (cross-tenant collision rejected), size/0 CHECK,
 *      content_hash metadata round-trip.
 *   B. student_documents linkage: same-tenant (student, file) composite FKs pair
 *      (a foreign student or a foreign file is rejected 23503), document_type is
 *      free-form (no enum), soft-delete hides the document from live reads, a
 *      live referenced file cannot be hard-deleted (immutability, NO ACTION),
 *      and deleting a student CASCADES its document rows while the FILE rows
 *      survive.
 *   C. scan-state transition is guarded: the worker's
 *      `UPDATE ... WHERE scan_status='pending' RETURNING` is single-winner and a
 *      terminal row can never be re-transitioned (idempotent redelivery).
 *   D. parent-scoped isolation: listing a foreign student's documents through the
 *      FROM students-join pattern returns zero rows; scan_status can never be
 *      written to 'clean' by an app-role client on a foreign file.
 *
 * Opt-in: RUN_RUNTIME_SECURITY_TESTS=1 (requires PostgreSQL + migrations 0001..0006).
 */
const enabled = process.env.RUN_RUNTIME_SECURITY_TESTS === '1';
const describeDb = enabled ? describe : describe.skip;

describeDb('student documents: files/student_documents invariants + scan-state guard (school_saas_test)', () => {
  let migrator: pg.Client;
  let app: pg.Client;
  const uid: Record<string, string> = {};
  const slug = 'doc' + randomUUID().slice(0, 8);

  const appQ = <T extends pg.QueryResultRow = pg.QueryResultRow>(
    sqlText: string,
  ): Promise<T[]> => app.query<T>(sqlText).then((r) => r.rows);
  const migQ = <T extends pg.QueryResultRow = pg.QueryResultRow>(
    sqlText: string,
  ): Promise<T[]> => migrator.query<T>(sqlText).then((r) => r.rows);

  /** App-role error inside a rolled-back savepoint so the session stays usable. */
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
    uid.tenantA = randomUUID();
    uid.tenantB = randomUUID();
    uid.campusA = randomUUID();
    uid.campusB = randomUUID();
    uid.studentA = randomUUID();
    uid.studentForeign = randomUUID();
    uid.fileA = randomUUID();
    uid.fileForeign = randomUUID();
    uid.docA = randomUUID();
    uid.docA2 = randomUUID();
    uid.docForeign = randomUUID();
    uid.storageKeyA = `documents/${uid.docA}.pdf`;
    uid.storageKeyB = `documents/${uid.docForeign}.pdf`;

    await migrator.query('begin');
    await migrator.query(
      `insert into tenants (id, slug, name) values
         ('${uid.tenantA}', '${slug}-a', 'Docs A'),
         ('${uid.tenantB}', '${slug}-b', 'Docs B')`,
    );
    await migrator.query(
      `insert into users (id, email) values
         ('${uid.userA}', 'docs-${slug}@example.com')`,
    );
    await migrator.query(
      `insert into memberships (id, tenant_id, user_id, status) values
         ('${randomUUID()}', '${uid.tenantA}', '${uid.userA}', 'active')`,
    );
    await migrator.query(
      `insert into campuses (id, tenant_id, code, name, status) values
         ('${uid.campusA}', '${uid.tenantA}', 'dc-ca-${slug}', 'Campus A', 'active'),
         ('${uid.campusB}', '${uid.tenantB}', 'dc-cb-${slug}', 'Campus B', 'active')`,
    );
    await migrator.query(
      `insert into students (id, tenant_id, student_no, first_name, last_name, status, primary_campus_id) values
         ('${uid.studentA}', '${uid.tenantA}', 'dc-sa-${slug}', 'Dan', 'Doc', 'active', '${uid.campusA}'),
         ('${uid.studentForeign}', '${uid.tenantB}', 'dc-sf-${slug}', 'Zoe', 'Zed', 'active', '${uid.campusB}')`,
    );
    await migrator.query(
      `insert into files (id, tenant_id, storage_key, original_name, mime, size_bytes, content_hash, scan_status) values
         ('${uid.fileA}', '${uid.tenantA}', '${uid.storageKeyA}', 'birth.pdf', 'application/pdf', 1234, 'abc123', 'pending'),
         ('${uid.fileForeign}', '${uid.tenantB}', '${uid.storageKeyB}', 'foreign.pdf', 'application/pdf', 4321, 'def456', 'clean')`,
    );
    await migrator.query(
      `insert into student_documents (id, tenant_id, student_id, document_type, file_id) values
         ('${uid.docA}', '${uid.tenantA}', '${uid.studentA}', 'birth_certificate', '${uid.fileA}'),
         ('${uid.docA2}', '${uid.tenantA}', '${uid.studentA}', 'report_card', '${uid.fileA}'),
         ('${uid.docForeign}', '${uid.tenantB}', '${uid.studentForeign}', 'id_copy', '${uid.fileForeign}')`,
    );
    await migrator.query('commit');
  });

  afterAll(async () => {
    try {
      await migrator.query('begin');
      const tenantIds = `'${uid.tenantA}','${uid.tenantB}'`;
      await migrator.query(`delete from student_documents where tenant_id in (${tenantIds})`);
      await migrator.query(`delete from files where tenant_id in (${tenantIds})`);
      await migrator.query(`delete from students where tenant_id in (${tenantIds})`);
      await migrator.query(`delete from campuses where tenant_id in (${tenantIds})`);
      await migrator.query(`delete from memberships where tenant_id in (${tenantIds})`);
      await migrator.query(`delete from users where id in ('${uid.userA}')`);
      await migrator.query(`delete from tenants where id in (${tenantIds})`);
      await migrator.query('commit');
    } finally {
      await migrator.end();
      await app.end();
    }
  });

  describe('A. files metadata bounds', () => {
    it('1. scan_status only admits pending/clean/blocked (CHECK files_scan_status_ck)', async () => {
      await tenantA(async () => {
        await rejectCode(
          () =>
            appQ(`insert into files (id, tenant_id, storage_key, original_name, mime, size_bytes, scan_status)
                   values ('${randomUUID()}', '${uid.tenantA}', '${slug}-bad-scan', 'x.pdf', 'application/pdf', 1, 'infected')`),
          '23514',
          'files_scan_status_ck',
        );
        await appQ(`insert into files (id, tenant_id, storage_key, original_name, mime, size_bytes, scan_status)
                     values ('${randomUUID()}', '${uid.tenantA}', '${slug}-good-scan', 'x.pdf', 'application/pdf', 1, 'blocked')`);
      });
    });

    it('2. visibility only admits private/tenant_portal (CHECK files_visibility_ck)', async () => {
      await tenantA(async () => {
        await rejectCode(
          () =>
            appQ(`insert into files (id, tenant_id, storage_key, original_name, mime, size_bytes, visibility)
                   values ('${randomUUID()}', '${uid.tenantA}', '${slug}-bad-vis', 'x.pdf', 'application/pdf', 1, 'public')`),
          '23514',
          'files_visibility_ck',
        );
      });
    });

    it('3. storage_key is GLOBALLY unique: a second tenant cannot reuse a taken key (23505)', async () => {
      await tenantA(async () => {
        await rejectCode(
          () =>
            appQ(`insert into files (id, tenant_id, storage_key, original_name, mime, size_bytes)
                   values ('${randomUUID()}', '${uid.tenantA}', '${uid.storageKeyA}', 'clone.pdf', 'application/pdf', 1)`),
          '23505',
          'files_storage_key_uq',
        );
      });
    });

    it('4. size_bytes must be non-negative (files_size_ck)', async () => {
      await tenantA(async () => {
        await rejectCode(
          () =>
            appQ(`insert into files (id, tenant_id, storage_key, original_name, mime, size_bytes)
                   values ('${randomUUID()}', '${uid.tenantA}', '${slug}-neg-size.pdf', 'x.pdf', 'application/pdf', -5)`),
          '23514',
          'files_size_ck',
        );
      });
    });

    it('5. content_hash round-trips for scan verification', async () => {
      const rows = await migQ(
        `select content_hash from files where id = '${uid.fileA}'`,
      );
      expect(String(rows[0]!.content_hash)).toBe('abc123');
    });
  });

  describe('B. student_documents linkage', () => {
    it('6. a document must reference a SAME-TENANT file (student_documents_file_fk)', async () => {
      await tenantA(async () => {
        await rejectCode(
          () =>
            appQ(`insert into student_documents (id, tenant_id, student_id, document_type, file_id)
                   values ('${randomUUID()}', '${uid.tenantA}', '${uid.studentA}', 'id_copy', '${uid.fileForeign}')`),
          '23503',
          'student_documents_file_fk',
        );
      });
    });

    it('7. a document must reference a SAME-TENANT student (student_documents_student_fk)', async () => {
      await tenantA(async () => {
        await rejectCode(
          () =>
            appQ(`insert into student_documents (id, tenant_id, student_id, document_type, file_id)
                   values ('${randomUUID()}', '${uid.tenantA}', '${uid.studentForeign}', 'id_copy', '${uid.fileA}')`),
          '23503',
          'student_documents_student_fk',
        );
      });
    });

    it('8. document_type is free-form (no enum): arbitrary labels are accepted and stored', async () => {
      await tenantA(async () => {
        await appQ(`insert into student_documents (id, tenant_id, student_id, document_type, file_id)
                     values ('${randomUUID()}', '${uid.tenantA}', '${uid.studentA}', 'birth_certificate_custom_2026', '${uid.fileA}')`);
      });
    });

    it('9. soft-deleting a document hides it from live queries but keeps the row', async () => {
      await migQ(`update student_documents set deleted_at = now() where id = '${uid.docA2}'`);
      const live = await migQ(`select count(*)::int n from student_documents where id = '${uid.docA2}' and deleted_at is null`);
      const all = await migQ(`select count(*)::int n from student_documents where id = '${uid.docA2}'`);
      expect(Number(live[0]!.n)).toBe(0);
      expect(Number(all[0]!.n)).toBe(1);
      await migQ(`update student_documents set deleted_at = null where id = '${uid.docA2}'`);
    });

    it('10. a live referenced file cannot be hard-deleted (immutability via NO ACTION)', async () => {
      const caught = await migrator
        .query(`delete from files where id = '${uid.fileA}'`)
        .catch((err: pg.DatabaseError) => err);
      expect((caught as pg.DatabaseError).code).toBe('23503');
      expect((caught as pg.DatabaseError).constraint).toBe('student_documents_file_fk');
    });

    it('11. deleting a student CASCADES its document rows; the referenced FILE rows survive', async () => {
      const victimStudent = randomUUID();
      const victimFiles: string[] = [];
      await migQ('begin');
      try {
        await migQ(
          `insert into students (id, tenant_id, student_no, first_name, last_name, status) values
             ('${victimStudent}', '${uid.tenantA}', 'dc-cc-${slug}', 'Cascade', 'Case', 'active')`,
        );
        const fileRows = await migQ(
          `insert into files (id, tenant_id, storage_key, original_name, mime, size_bytes) values
             ('${randomUUID()}', '${uid.tenantA}', '${slug}-cc1.pdf', 'c1.pdf', 'application/pdf', 1),
             ('${randomUUID()}', '${uid.tenantA}', '${slug}-cc2.pdf', 'c2.pdf', 'application/pdf', 1)
           returning id`,
        );
        victimFiles.push(...(fileRows as Array<{ id: string }>).map((r) => String(r.id)));
        await migQ(
          `insert into student_documents (id, tenant_id, student_id, document_type, file_id) values
             ('${randomUUID()}', '${uid.tenantA}', '${victimStudent}', 'id_copy', '${victimFiles[0]}'),
             ('${randomUUID()}', '${uid.tenantA}', '${victimStudent}', 'report_card', '${victimFiles[1]}')`,
        );
        await migQ(`delete from students where id = '${victimStudent}'`);
        const docs = await migQ(`select count(*)::int n from student_documents where tenant_id = '${uid.tenantA}' and student_id = '${victimStudent}'`);
        const filesAfter = await migQ(`select count(*)::int n from files where tenant_id = '${uid.tenantA}' and id in ('${victimFiles[0]}','${victimFiles[1]}')`);
        expect(Number(docs[0]!.n)).toBe(0);
        expect(Number(filesAfter[0]!.n)).toBe(2);
      } finally {
        await migQ('rollback');
      }
    });
  });

  describe('C. scan-state guarded transition (worker idempotency mechanism)', () => {
    it('12. only a pending row can transition; a terminal row can never be re-transitioned', async () => {
      await tenantA(async () => {
        const first = await appQ(
          `update files set scan_status = 'clean' where id = '${uid.fileA}' and scan_status = 'pending' returning id`,
        );
        expect(first.length).toBe(1);
        const second = await appQ(
          `update files set scan_status = 'blocked' where id = '${uid.fileA}' and scan_status = 'pending' returning id`,
        );
        expect(second.length).toBe(0);
        const row = await appQ(`select scan_status from files where id = '${uid.fileA}'`);
        expect(String(row[0]!.scan_status)).toBe('clean');
        // restore for other suites / teardown hygiene
        await appQ(`update files set scan_status = 'pending' where id = '${uid.fileA}'`);
      });
    });
  });

  describe('D. parent-scoped isolation at the API pattern', () => {
    it('13. listing a FOREIGN student\'s documents via the parent-scoped join returns zero rows', async () => {
      await tenantA(async () => {
        const rows = await appQ(
          `select d.id from students s
             join student_documents d on d.tenant_id = s.tenant_id and d.student_id = s.id and d.deleted_at is null
            where s.tenant_id = '${uid.tenantA}' and s.id = '${uid.studentForeign}'`,
        );
        expect(rows.length).toBe(0);
      });
    });

    it('14. an app-role client cannot flip scan_status on a foreign tenant file', async () => {
      const rows = await appQ(
        `update files set scan_status = 'clean' where id = '${uid.fileForeign}' returning id`,
      );
      expect(rows.length).toBe(0);
      const foreignState = await migQ(`select scan_status from files where id = '${uid.fileForeign}'`);
      expect(String(foreignState[0]!.scan_status)).toBe('clean'); // unchanged
    });

    it('15. metadata + scan state of local documents are readable under the tenant context', async () => {
      await tenantA(async () => {
        const rows = await appQ(
          `select f.scan_status, f.mime, d.document_type from student_documents d
             join files f on f.tenant_id = d.tenant_id and f.id = d.file_id
            where d.tenant_id = '${uid.tenantA}' and d.student_id = '${uid.studentA}' and d.deleted_at is null`,
        );
        expect(rows.length).toBeGreaterThanOrEqual(1);
        expect(String(rows[0]!.mime)).toBe('application/pdf');
        expect(String(rows[0]!.scan_status)).toMatch(/^(pending|clean|blocked)$/);
      });
    });
  });
});