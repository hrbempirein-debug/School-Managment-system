import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { and, asc, count, desc, eq } from 'drizzle-orm';
import { studentImportRows, studentImports, withTenant, type Tx } from '@sms/db';
import { writeAudit } from '@sms/audit';
import { enqueueOutbox } from '@sms/events';
import { requestFingerprint, withIdempotency } from '@sms/idempotency';
import { HttpError, uuidv7, parseCsv, type RequestContext } from '@sms/core';
import { getEnv } from '@sms/config';
import {
  idParamSchema,
  normalizeImportHeader,
  studentImportListQuerySchema,
  studentImportUploadQuerySchema,
  type StudentImport,
  type StudentImportRow,
} from '@sms/contracts';
import {
  requireSession,
  requireTenantContext,
  requirePermission,
  requireCsrf,
} from '../../plugins/auth.js';
import { idempotencyKeyFromHeader, mapDomainError, notFoundError } from './util.js';
import { sanitizeDisplayName } from './student-documents.js';

type ImportRow = typeof studentImports.$inferSelect;
type ImportLineRow = typeof studentImportRows.$inferSelect;

export const IMPORT_CONTENT_TYPES = ['text/csv', 'application/octet-stream'];

/**
 * Student CSV import (Phase 3.5).
 *
 * POST /students/import accepts the file bytes as the raw request body (the
 * established non-multipart convention). Upload acceptance is deliberately
 * shallow and the SAME header rules the worker uses:
 *   1. buffered size within MAX_IMPORT_UPLOAD_BYTES (413);
 *   2. no NUL bytes — text CSV only (415);
 *   3. parsed rows include a header + >= 1 data row, normalized via
 *      normalizeImportHeader: required columns present, no unknown columns,
 *      and data rows within MAX_IMPORT_ROWS (400 / 413);
 *   4. only then is the object stored (key `imports/{uuidv7}-{hash}.csv`) and a
 *      student_imports row inserted in status 'submitted' + audit + outbox
 *      `student.import.submitted`. A DB failure after storage compensates the
 *      object (never orphaned). Per-row parsing, validation, duplicate/conflict
 *      classification and student creation happen asynchronously in the worker.
 */

export function toStudentImport(row: ImportRow): StudentImport {
  return {
    id: row.id,
    tenantId: row.tenantId,
    filename: row.filename,
    status: row.status as StudentImport['status'],
    totalRows: row.totalRows,
    createdCount: row.createdCount,
    duplicateCount: row.duplicateCount,
    conflictCount: row.conflictCount,
    rejectedCount: row.rejectedCount,
    errorSummary: row.errorSummary,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toImportRow(row: ImportLineRow): StudentImportRow {
  return {
    rowNumber: row.rowNumber,
    status: row.status as StudentImportRow['status'],
    field: row.field,
    message: row.message,
  };
}

export interface StudentImportWriteInput {
  filename: string;
  storageKey: string;
  totalRows: number;
  campusId: string | null;
}

export async function insertStudentImport(
  tx: Tx,
  ctx: { userId: string; tenantId: string | null },
  input: StudentImportWriteInput,
  requestId: string,
): Promise<ImportRow> {
  try {
    const rows = await tx
      .insert(studentImports)
      .values({
        tenantId: ctx.tenantId ?? '',
        campusId: input.campusId,
        filename: input.filename,
        storageKey: input.storageKey,
        status: 'submitted',
        totalRows: input.totalRows,
        createdBy: ctx.userId,
      })
      .returning();
    const row = rows[0]!;
    await writeAudit(tx, {
      scope: 'tenant',
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action: 'student.import.submitted',
      resourceType: 'student_import',
      resourceId: row.id,
      newValue: toStudentImport(row),
      requestId,
    });
    await enqueueOutbox(tx, {
      tenantId: ctx.tenantId,
      eventType: 'student.import.submitted',
      aggregateType: 'student_import',
      aggregateId: row.id,
      payload: { tenantId: ctx.tenantId, importId: row.id },
      correlationId: requestId,
    });
    return row;
  } catch (err) {
    throw mapDomainError(err);
  }
}

export default async function studentImportRoutes(app: FastifyInstance) {
  for (const ct of IMPORT_CONTENT_TYPES) {
    try {
      app.addContentTypeParser(ct, { parseAs: 'buffer' }, (_request, body: Buffer, done) => done(null, body));
    } catch {
      // parser already registered by another route on this instance
    }
  }

  app.post(
    '/api/v1/students/import',
    {
      config: { authorization: { kind: 'tenant', permission: 'students.create' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('students.create'), requireCsrf()],
      bodyLimit: getEnv().MAX_IMPORT_UPLOAD_BYTES + 256 * 1024,
    },
    async (request, reply) => {
      const query = studentImportUploadQuerySchema.parse(request.query);
      const ctx = request.ctx!;
      const envMax = getEnv().MAX_IMPORT_UPLOAD_BYTES;

      const declaredLength = Number(request.headers['content-length'] ?? '0');
      if (declaredLength > envMax) {
        throw new HttpError('CSV exceeds the import size limit', { status: 413, code: 'payload_too_large' });
      }
      const body = request.body;
      if (!Buffer.isBuffer(body) || body.byteLength === 0) {
        throw new HttpError('CSV body is required', { status: 400, code: 'validation_error' });
      }
      if (body.byteLength > envMax) {
        throw new HttpError('CSV exceeds the import size limit', { status: 413, code: 'payload_too_large' });
      }
      if (body.includes(0)) {
        throw new HttpError('Import body must be plain CSV text', { status: 415, code: 'unsupported_media_type' });
      }

      const rows = parseCsv(body.toString('utf8'));
      if (rows.length < 2) {
        throw new HttpError('CSV must contain a header row and at least one data row', {
          status: 400,
          code: 'validation_error',
        });
      }
      const header = normalizeImportHeader(rows[0]!);
      if (header.unknown.length > 0) {
        throw new HttpError('CSV contains unsupported columns', {
          status: 400,
          code: 'validation_error',
          details: { columns: header.unknown },
        });
      }
      if (header.missing.length > 0) {
        throw new HttpError('CSV is missing required columns', {
          status: 400,
          code: 'validation_error',
          details: { missing: header.missing },
        });
      }
      const dataRows = rows.slice(1);
      const maxRows = getEnv().MAX_IMPORT_ROWS;
      if (dataRows.length > maxRows) {
        throw new HttpError(`CSV exceeds the ${maxRows} data-row import limit`, {
          status: 413,
          code: 'import_too_many_rows',
        });
      }

      const filename = sanitizeDisplayName(query.filename) ?? 'students-import.csv';
      const contentHash = createHash('sha256').update(body).digest('hex');
      const key = `imports/${uuidv7()}-${contentHash.slice(0, 12)}.csv`;

      const idemKey = idempotencyKeyFromHeader(request.headers);
      const fingerprint = requestFingerprint(request.method, request.url, {
        contentSha256: contentHash,
        totalRows: dataRows.length,
        filename,
      });

      let stored = false;
      try {
        const outcome = await withTenant(app.db, ctx, (tx) =>
          withIdempotency(tx, { tenantId: ctx.tenantId, key: idemKey }, fingerprint, async () => {
            await app.storage.putObject({
              tenantId: ctx.tenantId ?? '',
              key,
              data: body,
              contentType: 'text/csv',
            });
            stored = true;
            const row = await insertStudentImport(
              tx,
              ctx,
              { filename, storageKey: key, totalRows: dataRows.length, campusId: ctx.campusId },
              request.requestId,
            );
            return { status: 202, body: { import: toStudentImport(row) } };
          }),
        );
        return reply.code(outcome.status).send(outcome.body);
      } catch (err) {
        if (stored) {
          app.storage.deleteObject(ctx.tenantId ?? '', key).catch((deleteErr) => {
            request.log.warn({ err: deleteErr, key }, 'failed to remove orphaned import object after DB failure');
          });
        }
        throw err;
      }
    },
  );

  app.get(
    '/api/v1/students/imports',
    {
      config: { authorization: { kind: 'tenant', permission: 'students.read' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('students.read')],
    },
    async (request) => {
      const query = studentImportListQuerySchema.parse(request.query);
      const ctx = request.ctx!;
      const conditions = [eq(studentImports.tenantId, ctx.tenantId ?? '')];
      if (query.status) conditions.push(eq(studentImports.status, query.status));
      const rows = await withTenant(app.db, ctx, (tx) =>
        tx
          .select()
          .from(studentImports)
          .where(and(...conditions))
          .orderBy(desc(studentImports.createdAt), desc(studentImports.id))
          .limit(query.limit)
          .offset(query.offset)
          .execute(),
      );
      const totalRow = await withTenant(app.db, ctx, (tx) =>
        tx
          .select({ total: count() })
          .from(studentImports)
          .where(and(...conditions))
          .execute(),
      );
      return { items: rows.map(toStudentImport), total: totalRow[0]?.total ?? 0 };
    },
  );

  app.get(
    '/api/v1/students/imports/:id',
    {
      config: { authorization: { kind: 'tenant', permission: 'students.read' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('students.read')],
    },
    async (request) => {
      const { id } = idParamSchema.parse(request.params);
      const ctx = request.ctx!;
      const imp = await withTenant(app.db, ctx, (tx) =>
        tx
          .select()
          .from(studentImports)
          .where(and(eq(studentImports.tenantId, ctx.tenantId ?? ''), eq(studentImports.id, id)))
          .limit(1)
          .execute()
          .then((r) => r[0] ?? null),
      );
      if (!imp) throw notFoundError('Student import not found');
      const lines = await withTenant(app.db, ctx, (tx) =>
        tx
          .select()
          .from(studentImportRows)
          .where(and(eq(studentImportRows.tenantId, ctx.tenantId ?? ''), eq(studentImportRows.importId, id)))
          .orderBy(asc(studentImportRows.rowNumber), asc(studentImportRows.id))
          .execute(),
      );
      return { import: toStudentImport(imp), rows: lines.map(toImportRow) };
    },
  );
}