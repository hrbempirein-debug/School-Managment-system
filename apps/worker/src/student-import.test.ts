import { beforeAll, describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sql, eq, and } from 'drizzle-orm';
import { getEnv } from '@sms/config';
import {
  campuses,
  guardians,
  studentGuardians,
  studentImportRows,
  studentImports,
  students,
  auditLogs,
  outboxEvents,
  createDb,
  withSystem,
  type Db,
} from '@sms/db';
import type { OutboxEvent } from '@sms/contracts';
import type { StorageProvider } from '@sms/storage';
import { FsStorageProvider } from '@sms/storage';
import { makeStudentImportHandler, type StudentImportHandler } from './student-import.js';

/**
 * Phase 3.5 async CSV import executor proofs, against the REAL disposable test Postgres and a
 * throwaway FsStorageProvider. Every branch is exercised:
 *   happy path (students/guardians/links + completed + audit + outbox + object
 *   cleanup), campus-scoped row denials and unknown-campus rejections, validation
 *   rejections, within-import duplicates, DB conflicts via students_student_no_uq,
 *   fail-closed on missing storage / unreadable object / bad header, no-op acks for
 *   missing imports and completed re-runs, per-row actually-existing result skip on
 *   redrive, payload validation, and the buildHandlers registry wiring.
 *
 * Opt-in: RUN_RUNTIME_SECURITY_TESTS=1 (requires migrations 0001..0007).
 */
const enabled = process.env.RUN_RUNTIME_SECURITY_TESTS === '1';
const describeDb = enabled ? describe : describe.skip;

const CSV_HEADER =
  'student_no,first_name,last_name,date_of_birth,gender,campus,guardian_first_name,guardian_last_name,guardian_email,guardian_phone,relation,is_primary';

interface ImportFixture {
  importId: string;
  storageKey: string;
}

describeDb('student CSV import executor (real PG + temp storage)', () => {
  let db: Db;
  let pool: ReturnType<typeof createDb>['pool'];
  let tenantId: string;
  let slug: string;
  let campusNorth: string;
  let campusSouth: string;
  let existingStudentNo: string;
  let tempRoot: string;
  let storage: StorageProvider;

  const silentLog = (): void => {};

  beforeAll(async () => {
    const env = getEnv();
    const created = createDb({ url: env.DATABASE_URL_MIGRATOR });
    db = created.db;
    pool = created.pool;
    tenantId = randomUUID();
    slug = `imp${randomUUID().slice(0, 8)}`;
    campusNorth = randomUUID();
    campusSouth = randomUUID();
    existingStudentNo = `imp-conf-${slug}`;
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sms-imp-'));
    storage = new FsStorageProvider(tempRoot);
    await withSystem(db, async (tx) => {
      await tx.execute(sql`insert into tenants (id, slug, name) values (${tenantId}, ${`t-${slug}`}, 'Import Tenant')`);
      await tx.execute(
        sql`insert into campuses (id, tenant_id, code, name, status) values
              (${campusNorth}, ${tenantId}, 'north', 'North Campus', 'active'),
              (${campusSouth}, ${tenantId}, 'south', 'South Campus', 'active')`,
      );
      await tx.execute(
        sql`insert into students (id, tenant_id, student_no, first_name, last_name, status, primary_campus_id) values
              (${randomUUID()}, ${tenantId}, ${existingStudentNo}, 'Live', 'Student', 'active', ${campusNorth})`,
      );
    });
  });

  afterAll(async () => {
    try {
      await withSystem(db, async (tx) => {
        const ids = sql`${tenantId}`;
        await tx.execute(sql`delete from outbox_events where tenant_id = ${ids}`);
        await tx.execute(sql`delete from audit_logs where tenant_id = ${ids}`);
        await tx.execute(sql`delete from student_guardians where tenant_id = ${ids}`);
        await tx.execute(sql`delete from guardians where tenant_id = ${ids}`);
        await tx.execute(sql`delete from student_import_rows where tenant_id = ${ids}`);
        await tx.execute(sql`delete from student_imports where tenant_id = ${ids}`);
        await tx.execute(sql`delete from students where tenant_id = ${ids}`);
        await tx.execute(sql`delete from campuses where tenant_id = ${ids}`);
        await tx.execute(sql`delete from tenants where id = ${tenantId}`);
      });
    } catch {
      // best-effort cleanup
    }
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
    await pool.end();
  });

  const event = (over: Partial<OutboxEvent['payload']>): OutboxEvent =>
    ({
      id: randomUUID(),
      eventType: 'student.import.submitted',
      aggregateType: 'student_import',
      aggregateId: randomUUID(),
      tenantId,
      scope: 'tenant',
      version: 1,
      payload: { tenantId, importId: randomUUID(), ...over },
      correlationId: randomUUID(),
      causationId: null,
      createdAt: new Date().toISOString(),
    }) as OutboxEvent;

  const createImport = async (input: {
    csv: string;
    campusId?: string | null;
    storeObject?: boolean;
  }): Promise<ImportFixture> => {
    const importId = randomUUID();
    const storageKey = `imports/${randomUUID()}.csv`;
    if (input.storeObject !== false) {
      await storage.putObject({ tenantId, key: storageKey, data: Buffer.from(input.csv, 'utf8'), contentType: 'text/csv' });
    }
    await withSystem(db, async (tx) => {
      await tx.insert(studentImports).values({
        id: importId,
        tenantId,
        campusId: input.campusId === undefined ? null : input.campusId,
        filename: 'import.csv',
        storageKey,
        status: 'submitted',
      });
    });
    return { importId, storageKey };
  };

  const run = async (handler: StudentImportHandler, payload: Record<string, unknown>): Promise<void> => {
    await withSystem(db, async (tx) => {
      await handler({ tx, event: event(payload as never) });
    });
  };

  const importRow = async (importId: string): Promise<typeof studentImports.$inferSelect | undefined> => {
    const [r] = await withSystem(db, async (tx) =>
      tx.select().from(studentImports).where(and(eq(studentImports.tenantId, tenantId), eq(studentImports.id, importId))).limit(1).execute(),
    );
    return r;
  };

  const resultRows = async (importId: string): Promise<Array<{ status: string; studentId: string | null; field: string | null; message: string | null }>> => {
    return await withSystem(db, async (tx) =>
      tx
        .select({ status: studentImportRows.status, studentId: studentImportRows.studentId, field: studentImportRows.field, message: studentImportRows.message })
        .from(studentImportRows)
        .where(eq(studentImportRows.importId, importId))
        .orderBy(studentImportRows.rowNumber)
        .execute(),
    );
  };

  const studentByNo = async (studentNo: string) => {
    const [r] = await withSystem(db, async (tx) =>
      tx.select().from(students).where(and(eq(students.tenantId, tenantId), eq(students.studentNo, studentNo))).limit(1).execute(),
    );
    return r;
  };

  const completedCount = async (importId: string): Promise<number> => {
    const rows = await withSystem(db, async (tx) =>
      tx.select({ n: sql<number>`count(*)::int` }).from(auditLogs).where(
        and(eq(auditLogs.tenantId, tenantId), eq(auditLogs.action, 'student.import.completed'), eq(auditLogs.resourceId, importId)),
      ).execute(),
    );
    return Number(rows[0]!.n);
  };

  const completedOutbox = async (importId: string) => {
    const rows = await withSystem(db, async (tx) =>
      tx.select().from(outboxEvents).where(
        and(eq(outboxEvents.tenantId, tenantId), eq(outboxEvents.eventType, 'student.import.completed'), eq(outboxEvents.aggregateId, importId)),
      ).execute(),
    );
    return rows;
  };

  it('1. clean import: students+guardians created, completed, audited, outboxed, object deleted', async () => {
    const csv = [
      CSV_HEADER,
      `${'A-001-' + slug},Alice,Anderson,2015-04-01,female,north,Gina,Alt,gina.alt@example.com,5550101,mother,true`,
      `${'A-002-' + slug},Bob,Brown,2014-01-12,male,north,,,,,,`,
      `${'A-003-' + slug},Carol,Chen,2016-09-30,female,south,,,,,,`,
    ].join('\n');
    const fx = await createImport({ csv });

    await run(makeStudentImportHandler(silentLog, storage), { tenantId, importId: fx.importId });

    const row = await importRow(fx.importId);
    expect(row?.status).toBe('completed');
    expect(row?.totalRows).toBe(3);
    expect(row?.createdCount).toBe(3);
    expect(row?.rejectedCount).toBe(0);
    expect(row?.errorSummary).toBeNull();

    const results = await resultRows(fx.importId);
    expect(results).toHaveLength(3);
    expect(results.every((r) => r.status === 'created')).toBe(true);

    const alice = await studentByNo(`A-001-${slug}`);
    expect(alice?.['status']).toBe('applicant');
    expect(alice?.['primaryCampusId']).toBe(campusNorth);
    const carol = await studentByNo(`A-003-${slug}`);
    expect(carol?.['primaryCampusId']).toBe(campusSouth);

    // guardian matched by email on a single row: one guardian, one primary link.
    const guardiansRows = await withSystem(db, async (tx) =>
      tx.select({ id: guardians.id }).from(guardians).where(eq(guardians.tenantId, tenantId)).execute(),
    );
    const links = await withSystem(db, async (tx) =>
      tx.select({ isPrimary: studentGuardians.isPrimary, relation: studentGuardians.relation }).from(studentGuardians).where(eq(studentGuardians.tenantId, tenantId)).execute(),
    );
    expect(guardiansRows).toHaveLength(1);
    expect(links).toHaveLength(1);
    expect(links[0]!.isPrimary).toBe(true);
    expect(String(links[0]!.relation)).toBe('mother');

    expect(await completedCount(fx.importId)).toBe(1);
    const audits = await withSystem(db, async (tx) =>
      tx.select({ actorType: auditLogs.actorType }).from(auditLogs).where(eq(auditLogs.resourceId, fx.importId)).execute(),
    );
    expect(String(audits[0]!.actorType)).toBe('job');

    // Outbox carries ONLY counts (no PII), and the object is cleaned up.
    const outbox = await completedOutbox(fx.importId);
    expect(outbox).toHaveLength(1);
    const payload = outbox[0]!.payload as Record<string, unknown>;
    expect(payload['totalRows']).toBe(3);
    expect(payload['createdCount']).toBe(3);
    expect(JSON.stringify(payload)).not.toMatch(/firstName|lastName|Anderson|Alt|@example\.com/i);
    await expect(storage.readObject(tenantId, fx.storageKey)).rejects.toThrow();
  });

  it('2. a campus-scoped import may only materialize rows for its own campus', async () => {
    const csv = [
      CSV_HEADER,
      `${'B-001-' + slug},Dora,Donut,,,,,,,`,
      `${'B-002-' + slug},Evan,East,,,north,,,,,,`,
    ].join('\n');
    const fx = await createImport({ csv, campusId: campusNorth });

    await run(makeStudentImportHandler(silentLog, storage), { tenantId, importId: fx.importId });

    const row = await importRow(fx.importId);
    expect(row?.status).toBe('completed');
    expect(row?.createdCount).toBe(1);
    expect(row?.rejectedCount).toBe(1);
    const results = await resultRows(fx.importId);
    expect(results[0]!.field).toBe('campus');
    expect(results[0]!.message).toMatch(/campus-scoped/);
    // only Dora landed (campusless row on a campus-scoped import is denied too)
    expect(await studentByNo(`B-001-${slug}`)).toBeUndefined();
    expect(await studentByNo(`B-002-${slug}`)).toBeDefined();
  });

  it('3. unknown campus code on a school-wide import is rejected per-row', async () => {
    const csv = [CSV_HEADER, `${'C-001-' + slug},Fay,Finn,,,nowhere,,,,,`].join('\n');
    const fx = await createImport({ csv });

    await run(makeStudentImportHandler(silentLog, storage), { tenantId, importId: fx.importId });

    const row = await importRow(fx.importId);
    expect(row?.status).toBe('completed');
    expect(row?.rejectedCount).toBe(1);
    const results = await resultRows(fx.importId);
    expect(results[0]!.status).toBe('rejected');
    expect(results[0]!.field).toBe('campus');
    expect(await studentByNo(`C-001-${slug}`)).toBeUndefined();
  });

  it('4. validation failures bucket rows as rejected with their field', async () => {
    const csv = [
      CSV_HEADER,
      `,NoNo,Shane,,,,,,,`, // missing student_no
      `${'D-001-' + slug},Gus,Gunner,not-a-date,other,,,,,,`, // bad date
      `${'D-002-' + slug},Han,Solo,,alien,,,,,`, // bad gender
      `${'D-003-' + slug},Ida,Ivan,,,,,,,`, // valid -> created
    ].join('\n');
    const fx = await createImport({ csv });

    await run(makeStudentImportHandler(silentLog, storage), { tenantId, importId: fx.importId });

    const row = await importRow(fx.importId);
    expect(row?.status).toBe('completed');
    expect(row?.createdCount).toBe(1);
    expect(row?.rejectedCount).toBe(3);
    const results = await resultRows(fx.importId);
    expect(results[0]!.field).toBe('student_no');
    expect(results[1]!.field).toBe('date_of_birth');
    expect(results[2]!.field).toBe('gender');
    expect(results[3]!.status).toBe('created');
    expect(await studentByNo(`D-003-${slug}`)).toBeDefined();
  });

  it('5. a student_no seen twice in the same import is bucketed duplicate', async () => {
    const csv = [CSV_HEADER, `${'E-001-' + slug},Ken,Kilo,,,,,,,`, `${'E-001-' + slug},Kenny,Kilo,,,,,,,`].join('\n');
    const fx = await createImport({ csv });

    await run(makeStudentImportHandler(silentLog, storage), { tenantId, importId: fx.importId });

    const row = await importRow(fx.importId);
    expect(row?.createdCount).toBe(1);
    expect(row?.duplicateCount).toBe(1);
    const results = await resultRows(fx.importId);
    expect(results[0]!.status).toBe('created');
    expect(results[1]!.status).toBe('duplicate');
  });

  it('6. a live student with the same number in the tenant is bucketed conflict (no partial insert)', async () => {
    const csv = [CSV_HEADER, `${existingStudentNo},Still,Live,,,,,,,`].join('\n');
    const fx = await createImport({ csv });

    await run(makeStudentImportHandler(silentLog, storage), { tenantId, importId: fx.importId });

    const row = await importRow(fx.importId);
    expect(row?.createdCount).toBe(0);
    expect(row?.conflictCount).toBe(1);
    const results = await resultRows(fx.importId);
    expect(results[0]!.status).toBe('conflict');
    expect(results[0]!.field).toBe('student_no');
  });

  it('7. a second delivery after completion is a no-op (claim guard)', async () => {
    const csv = [CSV_HEADER, `${'G-001-' + slug},Jim,Jetson,,,,,,,`].join('\n');
    const fx = await createImport({ csv });
    const handler = makeStudentImportHandler(silentLog, storage);

    await run(handler, { tenantId, importId: fx.importId });
    await run(handler, { tenantId, importId: fx.importId });

    expect(await completedCount(fx.importId)).toBe(1);
    const all = await withSystem(db, async (tx) =>
      tx.select({ id: students.id }).from(students).where(eq(students.studentNo, `G-001-${slug}`)).execute(),
    );
    expect(all).toHaveLength(1);
  });

  it('8. on redrive a row that already carries a result is skipped, never double-inserted', async () => {
    // Simulate a partially-converged import: claim still possible (processing),
    // but the row's result already exists.
    const importId = randomUUID();
    const storageKey = `imports/${randomUUID()}.csv`;
    await storage.putObject({ tenantId, key: storageKey, data: Buffer.from([CSV_HEADER, `H-001-${slug},Hal,Hale,,,,,,,`].join('\n')), contentType: 'text/csv' });
    await withSystem(db, async (tx) => {
      await tx.insert(studentImports).values({ id: importId, tenantId, campusId: null, filename: 'i.csv', storageKey, status: 'submitted' });
      await tx.insert(studentImportRows).values({ tenantId, importId, rowNumber: 1, status: 'duplicate', studentId: null, field: 'student_no', message: 'seen twice' });
    });

    await run(makeStudentImportHandler(silentLog, storage), { tenantId, importId });

    const row = await importRow(importId);
    expect(row?.status).toBe('completed');
    expect(row?.createdCount).toBe(0);
    expect(row?.duplicateCount).toBe(0);
    const all = await withSystem(db, async (tx) =>
      tx.select({ id: students.id }).from(students).where(eq(students.studentNo, `H-001-${slug}`)).execute(),
    );
    expect(all).toHaveLength(0);
  });

  it('9. a missing import row is a no-op ack (converged), not an error', async () => {
    const fx = await createImport({ csv: [CSV_HEADER, `${'I-001-' + slug},Ida,Idly,,,,,,,`].join('\n') });
    const orphanId = randomUUID();
    const handler = makeStudentImportHandler(silentLog, storage);
    await expect(withSystem(db, async (tx) => handler({ tx, event: event({ tenantId, importId: orphanId }) }))).resolves.toBeUndefined();
    expect(await studentByNo(`I-001-${slug}`)).toBeUndefined();
    // fx object remains stored and untouched.
    await expect(storage.readObject(tenantId, fx.storageKey)).resolves.toBeDefined();
  });

  it('10. no storage provider fails CLOSED: import marked failed, no students', async () => {
    const csv = [CSV_HEADER, `${'J-001-' + slug},Jon,Jonah,,,,,,,`].join('\n');
    const fx = await createImport({ csv });
    const handler = makeStudentImportHandler(silentLog, undefined);

    await run(handler, { tenantId, importId: fx.importId });

    const row = await importRow(fx.importId);
    expect(row?.status).toBe('failed');
    expect(row?.errorSummary).toMatch(/storage is not configured/i);
    expect(await studentByNo(`J-001-${slug}`)).toBeUndefined();
  });

  it('11. an unreadable stored object marks the import failed (no retry storm)', async () => {
    const fx = await createImport({ csv: [CSV_HEADER, `${'K-001-' + slug},Kai,Kid,,,,,,,`].join('\n'), storeObject: false });
    const handler = makeStudentImportHandler(silentLog, storage);

    await run(handler, { tenantId, importId: fx.importId });

    const row = await importRow(fx.importId);
    expect(row?.status).toBe('failed');
    expect(row?.errorSummary).toMatch(/could not read stored csv/i);
    expect(await studentByNo(`K-001-${slug}`)).toBeUndefined();
  });

  it('12. a CSV with unknown or missing columns is failed with a header error', async () => {
    const badHeader = 'student_no,first_name,last_name,student_email'; // student_email not a column
    const fx = await createImport({ csv: [badHeader, '1,Al,A'].join('\n') });
    await run(makeStudentImportHandler(silentLog, storage), { tenantId, importId: fx.importId });

    const row = await importRow(fx.importId);
    expect(row?.status).toBe('failed');
    expect(row?.errorSummary).toMatch(/required columns/i);
  });

  it('13. a CSV with no data rows is failed', async () => {
    const fx = await createImport({ csv: CSV_HEADER });
    await run(makeStudentImportHandler(silentLog, storage), { tenantId, importId: fx.importId });

    const row = await importRow(fx.importId);
    expect(row?.status).toBe('failed');
    expect(row?.errorSummary).toMatch(/no data rows/i);
  });

  it('14. a malformed payload (missing importId) is rejected, not acked', async () => {
    await expect(
      withSystem(db, async (tx) =>
        makeStudentImportHandler(silentLog, storage)({ tx, event: event({ tenantId, importId: null }) }),
      ),
    ).rejects.toThrow(/requires string 'tenantId' and 'importId'/);
  });

  it('15. buildHandlers wires student.import.submitted to the import executor (storage-aware)', async () => {
    const { buildHandlers } = await import('./worker.js');
    const registry = buildHandlers(silentLog, { storage });
    expect(typeof registry['student.import.submitted']).toBe('function');
    const logOnlyFn = registry['campus.created'] as (deps: { event: OutboxEvent }) => Promise<void>;
    const importFn = registry['student.import.submitted'] as (deps: { event: OutboxEvent }) => Promise<void>;
    expect(importFn.toString()).toContain('studentImports');
    expect(logOnlyFn.toString()).not.toContain('studentImports');
  });
});