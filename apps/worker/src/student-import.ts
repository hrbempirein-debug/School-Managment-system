import { and, eq, isNull } from 'drizzle-orm';
import {
  campuses,
  guardians,
  studentGuardians,
  studentImportRows,
  studentImports,
  students,
  type Tx,
} from '@sms/db';
import { writeAudit } from '@sms/audit';
import { enqueueOutbox } from '@sms/events';
import { getEnv } from '@sms/config';
import { parseCsv } from '@sms/core';
import { normalizeImportHeader, type OutboxEvent, type StudentImportColumn } from '@sms/contracts';
import type { StorageProvider } from '@sms/storage';

type Logger = (level: 'info' | 'warn' | 'error', msg: string, data?: unknown) => void;

export interface StudentImportHandlerDeps {
  tx: Tx;
  event: OutboxEvent;
}

export type StudentImportHandler = (deps: StudentImportHandlerDeps) => Promise<void>;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const GENDERS = new Set(['male', 'female', 'other']);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TRUE_TOKENS = new Set(['true', '1', 'yes', 'y']);

interface RowValues {
  studentNo: string;
  firstName: string;
  lastName: string;
  dateOfBirth: string;
  gender: string;
  campus: string;
  guardianFirstName: string;
  guardianLastName: string;
  guardianEmail: string;
  guardianPhone: string;
  relation: string;
  isPrimary: string;
}

function rowToValues(row: string[], positions: (StudentImportColumn | null)[]): RowValues {
  const values: RowValues = {
    studentNo: '',
    firstName: '',
    lastName: '',
    dateOfBirth: '',
    gender: '',
    campus: '',
    guardianFirstName: '',
    guardianLastName: '',
    guardianEmail: '',
    guardianPhone: '',
    relation: '',
    isPrimary: '',
  };
  for (let i = 0; i < positions.length; i += 1) {
    const col = positions[i];
    if (!col) continue;
    const value = (row[i] ?? '').trim();
    switch (col) {
      case 'student_no': values.studentNo = value; break;
      case 'first_name': values.firstName = value; break;
      case 'last_name': values.lastName = value; break;
      case 'date_of_birth': values.dateOfBirth = value; break;
      case 'gender': values.gender = value; break;
      case 'campus': values.campus = value; break;
      case 'guardian_first_name': values.guardianFirstName = value; break;
      case 'guardian_last_name': values.guardianLastName = value; break;
      case 'guardian_email': values.guardianEmail = value; break;
      case 'guardian_phone': values.guardianPhone = value; break;
      case 'relation': values.relation = value; break;
      case 'is_primary': values.isPrimary = value; break;
    }
  }
  return values;
}

async function rowResultExists(tx: Tx, importId: string, rowNumber: number): Promise<boolean> {
  const rows = await tx
    .select({ id: studentImportRows.id })
    .from(studentImportRows)
    .where(and(eq(studentImportRows.importId, importId), eq(studentImportRows.rowNumber, rowNumber)))
    .limit(1)
    .execute();
  return rows.length > 0;
}

async function recordResult(
  tx: Tx,
  tenantId: string,
  importId: string,
  rowNumber: number,
  status: 'created' | 'duplicate' | 'conflict' | 'rejected',
  studentId: string | null,
  field: string | null,
  message: string | null,
): Promise<void> {
  await tx.insert(studentImportRows).values({
    tenantId,
    importId,
    rowNumber,
    status,
    studentId,
    field,
    message,
  });
}

/**
 * Async executor for `student.import.submitted` (POST /students/import enqueues it).
 *
 * Runs inside runEventHandler's system transaction (app_privileged, app.rls cleared),
 * so every read/write is DATA-scoped on event.payload.tenantId. Flow:
 *   1. Claim: guarded single-winner UPDATE student_imports submitted -> processing.
 *      A missing row, or one already claimed/completed/failed, is a no-op ack so
 *      redrives + concurrent deliveries converge without double work.
 *   2. Read the stored CSV object. A read failure marks the import 'failed'
 *      (terminal, no retry storm) + audit, then ack.
 *   3. Parse + normalize the header with the SAME rules as the upload route. Row
 *      bucketing per row:
 *        created    - student (+ optional guardian/link) inserted => result student_id
 *        duplicate  - student_no already seen in THIS import
 *        conflict   - a live student with this student_no already exists in the
 *                     tenant (students_student_no_uq, the DB is the final guard)
 *        rejected   - validation failure / unknown campus / campus-scope denial
 *      Each student insert runs in its own savepoint (tx.transaction) so a 23505
 *      or any row-level failure rolls back only that row and never the batch.
 *      Rows that already carry a result are skipped (idempotent redrive).
 *   4. Finalize: completed + aggregate counts + audit + `student.import.completed`
 *      (counts only, zero PII) and best-effort deletion of the storage object.
 */
export function makeStudentImportHandler(
  log: Logger,
  storage?: StorageProvider,
): StudentImportHandler {
  return async ({ tx, event }) => {
    const tenantId = typeof event.payload['tenantId'] === 'string' ? event.payload['tenantId'] : null;
    const importId = typeof event.payload['importId'] === 'string' ? event.payload['importId'] : null;
    if (!tenantId || !importId) {
      throw new Error("student.import.submitted requires string 'tenantId' and 'importId' in payload");
    }

    const imp = await tx
      .select()
      .from(studentImports)
      .where(and(eq(studentImports.tenantId, tenantId), eq(studentImports.id, importId)))
      .limit(1)
      .execute()
      .then((r) => r[0]);

    if (!imp) {
      log('info', 'student.import.submitted: no-op (import row missing)', { importId });
      return;
    }
    if (imp.status !== 'submitted') {
      log('info', 'student.import.submitted: no-op (already claimed/completed/failed)', {
        importId,
        status: imp.status,
      });
      return;
    }

    const claimed = await tx
      .update(studentImports)
      .set({ status: 'processing' })
      .where(and(eq(studentImports.tenantId, tenantId), eq(studentImports.id, importId), eq(studentImports.status, 'submitted')))
      .returning({ id: studentImports.id });
    if (claimed.length === 0) {
      log('info', 'student.import.submitted: no-op (lost the claim race)', { importId });
      return;
    }

    if (!storage) {
      await failImport(tx, log, event, tenantId, importId, 'import storage is not configured', imp.totalRows, 0, 0, 0, 0);
      return;
    }

    let csv: Buffer;
    try {
      csv = await storage.readObject(tenantId, imp.storageKey);
    } catch (err) {
      await failImport(
        tx,
        log,
        event,
        tenantId,
        importId,
        `could not read stored CSV: ${err instanceof Error ? err.message : String(err)}`,
        imp.totalRows,
        0, 0, 0, 0,
      );
      return;
    }

    const rows = parseCsv(csv.toString('utf8'));
    const dataRows = rows.length >= 2 ? rows.slice(1) : [];
    const totalRows = dataRows.length;
    const header = rows.length >= 1 ? normalizeImportHeader(rows[0]!) : { positions: [] as (StudentImportColumn | null)[], missing: ['student_no', 'first_name', 'last_name'], unknown: [] };
    if (header.missing.length > 0 || header.unknown.length > 0 || dataRows.length === 0) {
      await failImport(
        tx,
        log,
        event,
        tenantId,
        importId,
        'CSV is missing required columns, uses unsupported columns, or has no data rows',
        totalRows,
        0, 0, 0, 0,
      );
      return;
    }
    if (totalRows > getEnv().MAX_IMPORT_ROWS) {
      await failImport(tx, log, event, tenantId, importId, 'CSV exceeds the data-row import limit', totalRows, 0, 0, 0, 0);
      return;
    }

    // Campus authz: the uploader's boundary is pinned on the import row (NULL =
    // school-wide). Resolve row.campus codes once per import (campus -> id cache).
    const campusCache = new Map<string, string | null>();

    let createdCount = 0;
    let duplicateCount = 0;
    let conflictCount = 0;
    let rejectedCount = 0;
    const seenStudentNos = new Set<string>();
    const guardianByEmail = new Map<string, string>();
    const guardianByName = new Map<string, string>();
    const firstGuardianLinked = new Set<string>();

    for (let i = 0; i < dataRows.length; i += 1) {
      const rowNumber = i + 1;
      if (await rowResultExists(tx, importId, rowNumber)) continue;

      const values = rowToValues(dataRows[i]!, header.positions);
      const validation = validateRow(values);
      if (validation.length > 0) {
        const first = validation[0]!;
        await recordResult(tx, tenantId, importId, rowNumber, 'rejected', null, first.field, first.message);
        rejectedCount += 1;
        continue;
      }
      if (values.studentNo) {
        if (seenStudentNos.has(values.studentNo)) {
          await recordResult(tx, tenantId, importId, rowNumber, 'duplicate', null, 'student_no', 'student number appears more than once in this import');
          duplicateCount += 1;
          continue;
        }
        seenStudentNos.add(values.studentNo);
      }

      const campusId = await resolveCampus(tx, tenantId, imp.campusId, values.campus, campusCache);
      if (campusId === 'DENIED') {
        await recordResult(tx, tenantId, importId, rowNumber, 'rejected', null, 'campus', imp.campusId ? 'campus-scoped import may only target its own campus' : 'unknown or inactive campus code');
        rejectedCount += 1;
        continue;
      }

      // Savepoint: student (+ optional guardian/link) + created-row result are
      // atomic; any failure rolls back just this row.
      try {
        let newStudentId: string | null = null;
        await tx.transaction(async (sp) => {
          const inserted = await sp
            .insert(students)
            .values({
              tenantId,
              studentNo: values.studentNo,
              firstName: values.firstName,
              lastName: values.lastName,
              dateOfBirth: values.dateOfBirth === '' ? null : values.dateOfBirth,
              gender: values.gender === '' ? null : values.gender,
              status: 'applicant',
              primaryCampusId: campusId,
            })
            .returning();
          const studentId = inserted[0]!.id;
          newStudentId = studentId;

          const hasGuardian =
            values.guardianFirstName !== '' || values.guardianLastName !== '' ||
            values.guardianEmail !== '' || values.guardianPhone !== '';
          if (hasGuardian) {
            const guardianId = await ensureGuardian(
              sp,
              tenantId,
              values,
              guardianByEmail,
              guardianByName,
            );
            const isPrimary =
              values.isPrimary !== ''
                ? TRUE_TOKENS.has(values.isPrimary.toLowerCase())
                : !firstGuardianLinked.has(studentId);
            await sp.insert(studentGuardians).values({
              tenantId,
              studentId,
              guardianId,
              relation: values.relation === '' ? 'guardian' : values.relation,
              isPrimary,
              canPickup: false,
            });
            firstGuardianLinked.add(studentId);
          }
        });
        await recordResult(tx, tenantId, importId, rowNumber, 'created', newStudentId, null, null);
        createdCount += 1;
      } catch (err) {
        const pg = err as { code?: string; constraint?: string };
        if (pg.code === '23505' && pg.constraint === 'students_student_no_uq') {
          await recordResult(tx, tenantId, importId, rowNumber, 'conflict', null, 'student_no', 'a live student with this student number already exists');
          conflictCount += 1;
          continue;
        }
        await recordResult(
          tx,
          tenantId,
          importId,
          rowNumber,
          'rejected',
          null,
          null,
          err instanceof Error ? err.message : String(err),
        );
        rejectedCount += 1;
      }
    }

    const outcome =
      rejectedCount > 0 || conflictCount > 0
        ? `${createdCount} created, ${duplicateCount} duplicate, ${conflictCount} conflict, ${rejectedCount} rejected`
        : `${createdCount} created`;

    await tx
      .update(studentImports)
      .set({
        status: 'completed',
        totalRows,
        createdCount,
        duplicateCount,
        conflictCount,
        rejectedCount,
        errorSummary: rejectedCount > 0 || conflictCount > 0 ? outcome : null,
      })
      .where(and(eq(studentImports.tenantId, tenantId), eq(studentImports.id, importId)))
      .execute();

    await writeAudit(tx, {
      scope: 'tenant',
      tenantId,
      actorUserId: null,
      actorType: 'job',
      action: 'student.import.completed',
      resourceType: 'student_import',
      resourceId: importId,
      newValue: { importId, totalRows, createdCount, duplicateCount, conflictCount, rejectedCount },
      requestId: event.correlationId ?? event.id,
    });

    // counts only — never row PII — so consumers can reconcile without a file.
    await enqueueOutbox(tx, {
      tenantId,
      eventType: 'student.import.completed',
      aggregateType: 'student_import',
      aggregateId: importId,
      payload: {
        tenantId,
        importId,
        totalRows,
        createdCount,
        duplicateCount,
        conflictCount,
        rejectedCount,
      },
      causationId: event.id,
    });

    // Best-effort cleanup of the source object (the storage row is no longer
    // needed once results are committed). Never fail the handler on cleanup.
    if (storage) {
      try {
        await storage.deleteObject(tenantId, imp.storageKey);
      } catch (err) {
        log('warn', 'student.import.completed: object cleanup failed', {
          importId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    log('info', 'student.import.submitted completed', { importId, totalRows, createdCount, duplicateCount, conflictCount, rejectedCount });
  };
}

async function failImport(
  tx: Tx,
  log: Logger,
  event: OutboxEvent,
  tenantId: string,
  importId: string,
  reason: string,
  totalRows: number,
  createdCount: number,
  duplicateCount: number,
  conflictCount: number,
  rejectedCount: number,
): Promise<void> {
  await tx
    .update(studentImports)
    .set({
      status: 'failed',
      totalRows,
      createdCount,
      duplicateCount,
      conflictCount,
      rejectedCount,
      errorSummary: reason,
    })
    .where(and(eq(studentImports.tenantId, tenantId), eq(studentImports.id, importId)))
    .execute();
  await writeAudit(tx, {
    scope: 'tenant',
    tenantId,
    actorUserId: null,
    actorType: 'job',
    action: 'student.import.failed',
    resourceType: 'student_import',
    resourceId: importId,
    newValue: { importId, reason },
    requestId: event.correlationId ?? event.id,
  });
  log('error', 'student.import.submitted failed', { importId, reason });
}

function validateRow(values: RowValues): Array<{ field: string; message: string }> {
  const errors: Array<{ field: string; message: string }> = [];
  if (values.studentNo === '') errors.push({ field: 'student_no', message: 'student_no is required' });
  if (values.firstName === '') errors.push({ field: 'first_name', message: 'first_name is required' });
  if (values.lastName === '') errors.push({ field: 'last_name', message: 'last_name is required' });
  if (values.dateOfBirth !== '' && !ISO_DATE.test(values.dateOfBirth)) {
    errors.push({ field: 'date_of_birth', message: 'date_of_birth must be YYYY-MM-DD' });
  }
  if (values.gender !== '' && !GENDERS.has(values.gender)) {
    errors.push({ field: 'gender', message: 'gender must be one of male, female, other' });
  }
  const hasGuardian =
    values.guardianFirstName !== '' || values.guardianLastName !== '' ||
    values.guardianEmail !== '' || values.guardianPhone !== '';
  if (hasGuardian) {
    if (values.guardianFirstName === '' && values.guardianLastName === '' && values.guardianEmail === '') {
      errors.push({ field: 'guardian_first_name', message: 'guardian requires a name (first/last) or an email' });
    }
    if (values.guardianEmail !== '' && !EMAIL.test(values.guardianEmail)) {
      errors.push({ field: 'guardian_email', message: 'guardian_email is not a valid email' });
    }
  }
  return errors;
}

/**
 * Resolves a row's campus code inside the tenant. Returns the campus id, null when
 * the row has no campus, or 'DENIED' when the code is unknown/inactive or violates
 * the import's campus boundary (a campus-scoped upload must target only its campus).
 */
async function resolveCampus(
  tx: Tx,
  tenantId: string,
  importCampusId: string | null,
  code: string,
  cache: Map<string, string | null>,
): Promise<string | null | 'DENIED'> {
  if (code === '') {
    return importCampusId ? 'DENIED' : null;
  }
  const cached = cache.get(code);
  if (cached !== undefined) {
    if (cached === null) return 'DENIED';
    return importCampusId && cached !== importCampusId ? 'DENIED' : cached;
  }
  const campus = await tx
    .select({ id: campuses.id })
    .from(campuses)
    .where(and(eq(campuses.tenantId, tenantId), eq(campuses.code, code), eq(campuses.status, 'active')))
    .limit(1)
    .execute()
    .then((r) => r[0]);
  if (!campus) {
    cache.set(code, null);
    return 'DENIED';
  }
  cache.set(code, campus.id);
  if (importCampusId && campus.id !== importCampusId) return 'DENIED';
  return campus.id;
}

/** Finds (by email, else by first+last) or creates the guardian inside this savepoint. */
async function ensureGuardian(
  sp: Tx,
  tenantId: string,
  values: RowValues,
  byEmail: Map<string, string>,
  byName: Map<string, string>,
): Promise<string> {
  if (values.guardianEmail !== '') {
    const cached = byEmail.get(values.guardianEmail);
    if (cached) return cached;
    const existing = await sp
      .select({ id: guardians.id })
      .from(guardians)
      .where(and(eq(guardians.tenantId, tenantId), eq(guardians.email, values.guardianEmail), isNull(guardians.deletedAt)))
      .limit(1)
      .execute()
      .then((r) => r[0]);
    if (existing) {
      byEmail.set(values.guardianEmail, existing.id);
      return existing.id;
    }
  }
  const nameKey = `${values.guardianFirstName.toLowerCase()}\u0000${values.guardianLastName.toLowerCase()}`;
  const cached = byName.get(nameKey);
  if (cached) return cached;
  if (values.guardianFirstName !== '' || values.guardianLastName !== '') {
    const existing = await sp
      .select({ id: guardians.id })
      .from(guardians)
      .where(
        and(
          eq(guardians.tenantId, tenantId),
          eq(guardians.firstName, values.guardianFirstName),
          eq(guardians.lastName, values.guardianLastName),
          isNull(guardians.deletedAt),
        ),
      )
      .limit(1)
      .execute()
      .then((r) => r[0]);
    if (existing) {
      byName.set(nameKey, existing.id);
      return existing.id;
    }
  }
  const inserted = await sp
    .insert(guardians)
    .values({
      tenantId,
      firstName: values.guardianFirstName,
      lastName: values.guardianLastName,
      email: values.guardianEmail === '' ? null : values.guardianEmail,
      phone: values.guardianPhone === '' ? null : values.guardianPhone,
    })
    .returning();
  const guardianId = inserted[0]!.id;
  if (values.guardianEmail !== '') byEmail.set(values.guardianEmail, guardianId);
  if (values.guardianFirstName !== '' || values.guardianLastName !== '') byName.set(nameKey, guardianId);
  return guardianId;
}