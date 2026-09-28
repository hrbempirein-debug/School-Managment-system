import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { and, asc, count, desc, eq, isNull } from 'drizzle-orm';
import { HttpError, uuidv7, DOCUMENT_EXT, DOCUMENT_MIME, detectDocumentType, type DocumentType, type RequestContext } from '@sms/core';
import { getEnv } from '@sms/config';
import { files, studentDocuments, students, withTenant, type Tx } from '@sms/db';
import { writeAudit } from '@sms/audit';
import { enqueueOutbox } from '@sms/events';
import {
  DOCUMENT_KEY_PATTERN,
  idParamSchema,
  studentDocumentListQuerySchema,
  studentDocumentParamSchema,
  studentDocumentUploadQuerySchema,
  updateStudentDocumentRequestSchema,
  type StudentDocument,
} from '@sms/contracts';
import { requestFingerprint, withIdempotency } from '@sms/idempotency';
import {
  requireSession,
  requireTenantContext,
  requirePermission,
  requireCsrf,
} from '../../plugins/auth.js';
import { idempotencyKeyFromHeader, mapDomainError, notFoundError, assertCampusScope } from './util.js';

/**
 * Student documents (Phase 3.4).
 *
 * Upload follows the established raw-buffer convention (like branding uploads):
 * the request body IS the file bytes, the declared `Content-Type` is the file's
 * MIME, and metadata rides in query params (documentType + optional filename) —
 * no multipart, no JSON envelope, no new dependency. Object keys are
 * server-generated (`documents/{uuidv7}.{ext}`) and the storage provider injects
 * the tenant prefix, so clients can never choose a path.
 *
 * Upload acceptance is layered (FILE_STORAGE.md §6, SECURITY.md §9):
 *   1. declared Content-Length + buffered size must be within the config-driven
 *      MAX_DOCUMENT_UPLOAD_BYTES (413 payload_too_large otherwise);
 *   2. magic-byte sniff must recognize png / jpeg / webp / pdf (415
 *      unsupported_media_type), and a declared content-type must match (415
 *      content_type_mismatch) — no type spoofing, SVG excluded (stored-XSS);
 *   3. the display name is sanitized (reject path traversal, control bytes);
 *   4. only then are bytes stored via the StorageProvider and a files +
 *      student_documents row pair inserted (scoped to `private`, owner =
 *      student, scan_status 'pending', content sha256 recorded), followed by
 *      audit + the `student.document.uploaded` outbox event the worker's scan
 *      hook consumes. A storage write that is followed by a DB failure is
 *      compensated (object deleted) so no orphaned object survives.
 *
 * Download is gated on files.scan_status = 'clean' — pending/blocked/deleted
 * documents are never streamed. Clients cannot set scan_status (files is never
 * written by the API document path beyond the initial row); only the worker
 * scan hook transitions it.
 */

/** Alias for the shared sniff result type; kept for test readability. */
export type StudentDocumentType = DocumentType;

const UPLOAD_CONTENT_TYPES = [
  ...new Set([...Object.values(DOCUMENT_MIME), 'application/octet-stream']),
];

/**
 * Canonicalizes a client-supplied display name for storage in files.original_name.
 * Rejects path separators / traversal (/ \; NUL) and control bytes; returns null
 * when no usable name was provided or the name is invalid. The name is metadata
 * only — never a filesystem path (object keys are server-generated).
 */
export function sanitizeDisplayName(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 255) return null;
  if (trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('\0')) return null;
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return null;
  return trimmed;
}

function headerSafeName(name: string): string {
  return name.replace(/[";\r\n]/g, '');
}

type StudentRow = typeof students.$inferSelect;
type FileRow = typeof files.$inferSelect;
type StudentDocumentRow = typeof studentDocuments.$inferSelect;

export interface DocumentJoined {
  id: string;
  tenantId: string;
  studentId: string;
  documentType: string;
  fileId: string;
  createdAt: Date;
  updatedAt: Date;
  originalName: string;
  mime: string;
  sizeBytes: bigint | number;
  scanStatus: string;
}

export function toStudentDocument(row: DocumentJoined): StudentDocument {
  return {
    id: row.id,
    tenantId: row.tenantId,
    studentId: row.studentId,
    documentType: row.documentType,
    fileId: row.fileId,
    originalName: row.originalName,
    mime: row.mime,
    sizeBytes: Number(row.sizeBytes),
    scanStatus: row.scanStatus as StudentDocument['scanStatus'],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export interface StudentDocumentWriteInput {
  studentId: string;
  documentType: string;
  originalName: string;
  storageKey: string;
  mime: string;
  sizeBytes: number;
  contentHash: string;
}

export async function insertStudentDocument(
  tx: Tx,
  ctx: { userId: string; tenantId: string | null },
  input: StudentDocumentWriteInput,
  requestId: string,
): Promise<DocumentJoined> {
  try {
    const fileRows = await tx
      .insert(files)
      .values({
        tenantId: ctx.tenantId ?? '',
        storageKey: input.storageKey,
        originalName: input.originalName,
        mime: input.mime,
        sizeBytes: BigInt(input.sizeBytes),
        contentHash: input.contentHash,
        visibility: 'private',
        ownerType: 'student',
        ownerId: input.studentId,
        createdBy: ctx.userId,
        scanStatus: 'pending',
      })
      .returning();
    const file = fileRows[0]!;
    const docRows = await tx
      .insert(studentDocuments)
      .values({
        tenantId: ctx.tenantId ?? '',
        studentId: input.studentId,
        documentType: input.documentType,
        fileId: file.id,
      })
      .returning();
    const doc = docRows[0]!;
    const joined: DocumentJoined = {
      id: doc.id,
      tenantId: doc.tenantId,
      studentId: doc.studentId,
      documentType: doc.documentType,
      fileId: doc.fileId,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
      originalName: file.originalName,
      mime: file.mime,
      sizeBytes: file.sizeBytes,
      scanStatus: file.scanStatus,
    };
    await writeAudit(tx, {
      scope: 'tenant',
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action: 'student.document.uploaded',
      resourceType: 'student_document',
      resourceId: doc.id,
      newValue: toStudentDocument(joined),
      requestId,
    });
    await enqueueOutbox(tx, {
      tenantId: ctx.tenantId,
      eventType: 'student.document.uploaded',
      aggregateType: 'student_document',
      aggregateId: doc.id,
      payload: { tenantId: ctx.tenantId, documentId: doc.id, fileId: file.id },
      correlationId: requestId,
    });
    return joined;
  } catch (err) {
    throw mapDomainError(err);
  }
}

export interface StudentDocumentUpdateInput {
  documentType?: string;
  originalName?: string;
}

export async function updateStudentDocument(
  tx: Tx,
  ctx: { userId: string; tenantId: string | null },
  studentId: string,
  documentId: string,
  input: StudentDocumentUpdateInput,
  requestId: string,
): Promise<DocumentJoined | null> {
  try {
    const beforeRows = await tx
      .select()
      .from(studentDocuments)
      .innerJoin(files, and(eq(files.tenantId, studentDocuments.tenantId), eq(files.id, studentDocuments.fileId)))
      .where(
        and(
          eq(studentDocuments.tenantId, ctx.tenantId ?? ''),
          eq(studentDocuments.studentId, studentId),
          eq(studentDocuments.id, documentId),
          isNull(studentDocuments.deletedAt),
        ),
      )
      .limit(1)
      .execute();
    if (beforeRows.length === 0) return null;
    if (input.documentType !== undefined) {
      await tx
        .update(studentDocuments)
        .set({ documentType: input.documentType })
        .where(and(eq(studentDocuments.id, documentId), isNull(studentDocuments.deletedAt)))
        .execute();
    }
    if (input.originalName !== undefined) {
      await tx
        .update(files)
        .set({ originalName: input.originalName })
        .where(and(eq(files.tenantId, ctx.tenantId ?? ''), eq(files.id, beforeRows[0]!.files.id)))
        .execute();
    }
    const afterRows = await tx
      .select()
      .from(studentDocuments)
      .innerJoin(files, and(eq(files.tenantId, studentDocuments.tenantId), eq(files.id, studentDocuments.fileId)))
      .where(
        and(
          eq(studentDocuments.tenantId, ctx.tenantId ?? ''),
          eq(studentDocuments.studentId, studentId),
          eq(studentDocuments.id, documentId),
          isNull(studentDocuments.deletedAt),
        ),
      )
      .limit(1)
      .execute();
    const merged = toJoined(afterRows[0]!);
    const before = toJoined(beforeRows[0]!);
    await writeAudit(tx, {
      scope: 'tenant',
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action: 'student.document.updated',
      resourceType: 'student_document',
      resourceId: documentId,
      oldValue: toStudentDocument(before),
      newValue: toStudentDocument(merged),
      requestId,
    });
    return merged;
  } catch (err) {
    throw mapDomainError(err);
  }
}

export async function deleteStudentDocument(
  tx: Tx,
  ctx: { userId: string; tenantId: string | null },
  studentId: string,
  documentId: string,
  requestId: string,
): Promise<boolean> {
  try {
    const beforeRows = await tx
      .select()
      .from(studentDocuments)
      .innerJoin(files, and(eq(files.tenantId, studentDocuments.tenantId), eq(files.id, studentDocuments.fileId)))
      .where(
        and(
          eq(studentDocuments.tenantId, ctx.tenantId ?? ''),
          eq(studentDocuments.studentId, studentId),
          eq(studentDocuments.id, documentId),
          isNull(studentDocuments.deletedAt),
        ),
      )
      .limit(1)
      .execute();
    if (beforeRows.length === 0) return false;
    const fileId = beforeRows[0]!.files.id;
    const rows = await tx
      .update(studentDocuments)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(studentDocuments.tenantId, ctx.tenantId ?? ''),
          eq(studentDocuments.studentId, studentId),
          eq(studentDocuments.id, documentId),
          isNull(studentDocuments.deletedAt),
        ),
      )
      .returning({ id: studentDocuments.id });
    if (rows.length === 0) return false;
    await tx
      .update(files)
      .set({ deletedAt: new Date() })
      .where(and(eq(files.tenantId, ctx.tenantId ?? ''), eq(files.id, fileId)))
      .execute();
    await writeAudit(tx, {
      scope: 'tenant',
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action: 'student.document.deleted',
      resourceType: 'student_document',
      resourceId: documentId,
      oldValue: toStudentDocument(toJoined(beforeRows[0]!)),
      requestId,
    });
    return true;
  } catch (err) {
    throw mapDomainError(err);
  }
}

function toJoined(r: { student_documents: StudentDocumentRow; files: FileRow }): DocumentJoined {
  return {
    id: r.student_documents.id,
    tenantId: r.student_documents.tenantId,
    studentId: r.student_documents.studentId,
    documentType: r.student_documents.documentType,
    fileId: r.student_documents.fileId,
    createdAt: r.student_documents.createdAt,
    updatedAt: r.student_documents.updatedAt,
    originalName: r.files.originalName,
    mime: r.files.mime,
    sizeBytes: r.files.sizeBytes,
    scanStatus: r.files.scanStatus,
  };
}

export default async function studentDocumentRoutes(app: FastifyInstance) {
  // Raw-buffer parser for the upload allowlist. Register per type and tolerate
  // already-present parsers (the branding route registers the same raster types
  // on the same root instance) — the passthrough behavior is identical.
  for (const ct of UPLOAD_CONTENT_TYPES) {
    try {
      app.addContentTypeParser(ct, { parseAs: 'buffer' }, (_request, body: Buffer, done) => done(null, body));
    } catch {
      // parser already registered by another route on this instance
    }
  }

  app.get(
    '/api/v1/students/:id/documents',
    {
      config: { authorization: { kind: 'tenant', permission: 'student.documents.read' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('student.documents.read')],
    },
    async (request) => {
      const query = studentDocumentListQuerySchema.parse(request.query);
      const { id } = idParamSchema.parse(request.params);
      const ctx = request.ctx!;
      const student = await resolveStudent(app, ctx, id);
      if (!student) throw notFoundError('Student not found');
      assertCampusScopeOr404(ctx, student.primaryCampusId);
      const conditions = [
        eq(studentDocuments.tenantId, ctx.tenantId ?? ''),
        eq(studentDocuments.studentId, id),
        isNull(studentDocuments.deletedAt),
      ];
      if (query.documentType) conditions.push(eq(studentDocuments.documentType, query.documentType));
      const rows = await withTenant(app.db, ctx, (tx) =>
        tx
          .select()
          .from(studentDocuments)
          .innerJoin(files, and(eq(files.tenantId, studentDocuments.tenantId), eq(files.id, studentDocuments.fileId)))
          .where(and(...conditions))
          .orderBy(desc(studentDocuments.createdAt), asc(studentDocuments.id))
          .limit(query.limit)
          .offset(query.offset)
          .execute(),
      );
      const totalRow = await withTenant(app.db, ctx, (tx) =>
        tx
          .select({ total: count() })
          .from(studentDocuments)
          .innerJoin(files, and(eq(files.tenantId, studentDocuments.tenantId), eq(files.id, studentDocuments.fileId)))
          .where(and(...conditions))
          .execute(),
      );
      return { items: rows.map(toJoined).map(toStudentDocument), total: totalRow[0]?.total ?? 0 };
    },
  );

  app.post(
    '/api/v1/students/:id/documents',
    {
      config: { authorization: { kind: 'tenant', permission: 'student.documents.create' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('student.documents.create'), requireCsrf()],
      bodyLimit: getEnv().MAX_DOCUMENT_UPLOAD_BYTES + 256 * 1024,
    },
    async (request, reply) => {
      const query = studentDocumentUploadQuerySchema.parse(request.query);
      const { id } = idParamSchema.parse(request.params);
      const ctx = request.ctx!;

      const student = await resolveStudent(app, ctx, id);
      if (!student) throw notFoundError('Student not found');
      assertCampusScope(ctx, student.primaryCampusId);

      const envMax = getEnv().MAX_DOCUMENT_UPLOAD_BYTES;
      const declaredLength = Number(request.headers['content-length'] ?? '0');
      if (declaredLength > envMax) {
        throw new HttpError('Document exceeds the upload size limit', { status: 413, code: 'payload_too_large' });
      }
      const body = request.body;
      if (!Buffer.isBuffer(body) || body.byteLength === 0) {
        throw new HttpError('Document body is required', { status: 400, code: 'validation_error' });
      }
      if (body.byteLength > envMax) {
        throw new HttpError('Document exceeds the upload size limit', { status: 413, code: 'payload_too_large' });
      }

      const detected = detectDocumentType(body);
      if (!detected) {
        throw new HttpError('Unsupported document (png, jpeg, webp or pdf only)', {
          status: 415,
          code: 'unsupported_media_type',
        });
      }
      const declaredType = headerString(request.headers['content-type']);
      if (declaredType && declaredType !== 'application/octet-stream' && DOCUMENT_MIME[detected] !== declaredType) {
        throw new HttpError('Declared content-type does not match file contents', {
          status: 415,
          code: 'content_type_mismatch',
        });
      }

      const originalName = sanitizeDisplayName(query.filename) ?? `${DOCUMENT_EXT[detected]} document`;
      const key = `documents/${uuidv7()}.${DOCUMENT_EXT[detected]}`;
      const contentHash = createHash('sha256').update(body).digest('hex');

      const idemKey = idempotencyKeyFromHeader(request.headers);
      const fingerprint = requestFingerprint(request.method, request.url, {
        contentSha256: contentHash,
        documentType: query.documentType,
        filename: query.filename ?? null,
      });

      let stored = false;
      try {
        const outcome = await withTenant(app.db, ctx, (tx) =>
          withIdempotency(tx, { tenantId: ctx.tenantId, key: idemKey }, fingerprint, async () => {
            await app.storage.putObject({
              tenantId: ctx.tenantId ?? '',
              key,
              data: body,
              contentType: DOCUMENT_MIME[detected],
            });
            stored = true;
            const row = await insertStudentDocument(tx, ctx, {
              studentId: id,
              documentType: query.documentType,
              originalName,
              storageKey: key,
              mime: DOCUMENT_MIME[detected],
              sizeBytes: body.byteLength,
              contentHash,
            }, request.requestId);
            return { status: 201, body: { document: toStudentDocument(row) } };
          }),
        );
        return reply.code(outcome.status).send(outcome.body);
      } catch (err) {
        if (stored) {
          app.storage.deleteObject(ctx.tenantId ?? '', key).catch((deleteErr) => {
            request.log.warn({ err: deleteErr, key }, 'failed to remove orphaned document object after DB failure');
          });
        }
        throw err;
      }
    },
  );

  app.get(
    '/api/v1/students/:id/documents/:documentId',
    {
      config: { authorization: { kind: 'tenant', permission: 'student.documents.read' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('student.documents.read')],
    },
    async (request) => {
      const { id, documentId } = studentDocumentParamSchema.parse(request.params);
      const ctx = request.ctx!;
      const joined = await resolveDocument(app, ctx, id, documentId);
      if (!joined) throw notFoundError('Document not found');
      return { document: toStudentDocument(joined) };
    },
  );

  app.get(
    '/api/v1/students/:id/documents/:documentId/download',
    {
      config: { authorization: { kind: 'tenant', permission: 'student.documents.read' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('student.documents.read')],
    },
    async (request, reply) => {
      const { id, documentId } = studentDocumentParamSchema.parse(request.params);
      const ctx = request.ctx!;
      const joined = await resolveDocument(app, ctx, id, documentId);
      if (!joined) throw notFoundError('Document not found');
      const file = await withTenant(app.db, ctx, (tx) =>
        tx
          .select({ storageKey: files.storageKey, scanStatus: files.scanStatus, contentHash: files.contentHash })
          .from(files)
          .where(and(eq(files.tenantId, joined.tenantId), eq(files.id, joined.fileId), isNull(files.deletedAt)))
          .limit(1)
          .execute()
          .then((r) => r[0]),
      );
      if (!file) throw notFoundError('Document not found');
      if (file.scanStatus !== 'clean') {
        throw new HttpError('Document is not cleared for download until the scan completes', {
          status: 403,
          code: 'scan_incomplete',
        });
      }
      if (!DOCUMENT_KEY_PATTERN.test(file.storageKey)) {
        throw new HttpError('Document object key is invalid', { status: 404, code: 'not_found' });
      }
      const buffer = await app.storage.readObject(joined.tenantId, file.storageKey);
      const safeName = headerSafeName(joined.originalName);
      reply.header('content-type', joined.mime);
      reply.header('content-length', String(buffer.byteLength));
      reply.header(
        'content-disposition',
        `attachment; filename="${safeName === '' ? 'document' : safeName}"; filename*=UTF-8''${encodeURIComponent(safeName)}`,
      );
      reply.header('cache-control', 'private, no-store');
      return buffer;
    },
  );

  app.patch(
    '/api/v1/students/:id/documents/:documentId',
    {
      config: { authorization: { kind: 'tenant', permission: 'student.documents.update' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('student.documents.update'), requireCsrf()],
    },
    async (request, reply) => {
      const { id, documentId } = studentDocumentParamSchema.parse(request.params);
      const body = updateStudentDocumentRequestSchema.parse(request.body);
      const ctx = request.ctx!;
      const joined = await resolveDocument(app, ctx, id, documentId);
      if (!joined) throw notFoundError('Document not found');
      const originalName =
        body.originalName !== undefined ? (sanitizeDisplayName(body.originalName) ?? joined.originalName) : undefined;
      const idemKey = idempotencyKeyFromHeader(request.headers);
      const fingerprint = requestFingerprint(request.method, request.url, body);
      const outcome = await withTenant(app.db, ctx, (tx) =>
        withIdempotency(tx, { tenantId: ctx.tenantId, key: idemKey }, fingerprint, async () => {
          const row = await updateStudentDocument(tx, ctx, id, documentId, {
            documentType: body.documentType,
            originalName,
          }, request.requestId);
          if (!row) throw notFoundError('Document not found');
          return { status: 200, body: { document: toStudentDocument(row) } };
        }),
      );
      return reply.code(outcome.status).send(outcome.body);
    },
  );

  app.delete(
    '/api/v1/students/:id/documents/:documentId',
    {
      config: { authorization: { kind: 'tenant', permission: 'student.documents.delete' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('student.documents.delete'), requireCsrf()],
    },
    async (request, reply) => {
      const { id, documentId } = studentDocumentParamSchema.parse(request.params);
      const ctx = request.ctx!;
      const joined = await resolveDocument(app, ctx, id, documentId);
      if (!joined) throw notFoundError('Document not found');
      const deleted = await withTenant(app.db, ctx, (tx) => deleteStudentDocument(tx, ctx, id, documentId, request.requestId));
      if (!deleted) throw notFoundError('Document not found');
      return reply.code(204).send();
    },
  );
}

async function resolveStudent(
  app: FastifyInstance,
  ctx: RequestContext,
  studentId: string,
): Promise<Pick<StudentRow, 'id' | 'primaryCampusId'> | null> {
  return withTenant(app.db, ctx, (tx) =>
    tx
      .select({ id: students.id, primaryCampusId: students.primaryCampusId })
      .from(students)
      .where(and(eq(students.tenantId, ctx.tenantId ?? ''), eq(students.id, studentId), isNull(students.deletedAt)))
      .limit(1)
      .execute()
      .then((r) => r[0] ?? null),
  );
}

/** Reads own the two nested identifiers; used by update/delete to avoid touching files first. */
async function resolveDocument(
  app: FastifyInstance,
  ctx: RequestContext,
  studentId: string,
  documentId: string,
): Promise<DocumentJoined | null> {
  const student = await resolveStudent(app, ctx, studentId);
  if (!student) throw notFoundError('Student not found');
  assertCampusScopeOr404(ctx, student.primaryCampusId);
  return withTenant(app.db, ctx, (tx) =>
    tx
      .select()
      .from(studentDocuments)
      .innerJoin(files, and(eq(files.tenantId, studentDocuments.tenantId), eq(files.id, studentDocuments.fileId)))
      .where(
        and(
          eq(studentDocuments.tenantId, ctx.tenantId ?? ''),
          eq(studentDocuments.studentId, studentId),
          eq(studentDocuments.id, documentId),
          isNull(studentDocuments.deletedAt),
        ),
      )
      .limit(1)
      .execute()
      .then((r) => (r[0] ? toJoined(r[0]) : null)),
  );
}

/** Campus-scoped reads/updates hide foreign-campus students as 404 (students.ts convention). */
function assertCampusScopeOr404(
  ctx: { campusId: string | null },
  primaryCampusId: string | null,
): void {
  if (ctx.campusId && primaryCampusId !== ctx.campusId) {
    throw notFoundError('Student not found');
  }
}

function headerString(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}