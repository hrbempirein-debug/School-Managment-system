import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { and, asc, eq, gt, isNull, or, sql, type SQL } from 'drizzle-orm';
import { campuses, students, withTenant } from '@sms/db';
import { writeAudit } from '@sms/audit';
import { csvFormulaSafe, serializeCsv, type RequestContext } from '@sms/core';
import { studentExportQuerySchema, type StudentExportQuery } from '@sms/contracts';
import {
  requireSession,
  requireTenantContext,
  requirePermission,
} from '../../plugins/auth.js';

const BATCH_SIZE = 500;

const nameExpr = sql`(${students.firstName} || ' ' || ${students.lastName})`;

const EXPORT_HEADER = [
  'student_no',
  'status',
  'first_name',
  'last_name',
  'date_of_birth',
  'gender',
  'campus_code',
  'created_at',
];

interface ExportRow {
  studentNo: string;
  status: string;
  firstName: string;
  lastName: string;
  dateOfBirth: string | null;
  gender: string | null;
  campusCode: string | null;
  createdAt: string;
}

/** Maps a student row (with its campus code) to an export line, formula-safe. */
export function toExportRow(values: {
  studentNo: string;
  status: string;
  firstName: string;
  lastName: string;
  dateOfBirth: string | null;
  gender: string | null;
  campusCode: string | null;
  createdAt: Date;
}): string[] {
  return [
    csvFormulaSafe(values.studentNo),
    values.status,
    csvFormulaSafe(values.firstName),
    csvFormulaSafe(values.lastName),
    values.dateOfBirth ?? '',
    values.gender ?? '',
    csvFormulaSafe(values.campusCode ?? ''),
    values.createdAt.toISOString(),
  ];
}

/**
 * Batch student export (Phase 3.5). Streams a formula-injection-guarded CSV via a
 * stable (created_at, id) keyset so batched reads are deterministic under writes.
 * Only canonical, PII-safe student columns are published (no internal ids,
 * tenant_id, guardian/phone/email columns, timestamps other than created_at).
 * The audit record (rows exported + applied filters) is written once the stream
 * finishes — including on client abort (generator finally).
 */
export function buildExportRows(
  app: FastifyInstance,
  ctx: RequestContext,
  query: StudentExportQuery,
  requestId: string,
): AsyncGenerator<string> {
  const conditions: SQL[] = [eq(students.tenantId, ctx.tenantId ?? ''), isNull(students.deletedAt)];
  if (query.q) {
    conditions.push(sql`${nameExpr} ILIKE ${`%${query.q}%`}`);
  }
  if (query.status) {
    conditions.push(eq(students.status, query.status));
  }
  const campusFilter = ctx.campusId ?? query.campusId ?? null;
  if (campusFilter) {
    conditions.push(eq(students.primaryCampusId, campusFilter));
  }

  return (async function* () {
    let rowsSent = 0;
    try {
      yield serializeCsv([EXPORT_HEADER]);
      let lastCreatedAt: Date | null = null;
      let lastId: string | null = null;
      for (;;) {
        const batchConditions: SQL[] = [...conditions];
        if (lastCreatedAt && lastId) {
          batchConditions.push(
            or(
              gt(students.createdAt, lastCreatedAt),
              and(eq(students.createdAt, lastCreatedAt), gt(students.id, lastId)),
            )!,
          );
        }
        const batch = await withTenant(app.db, ctx, (tx) =>
          tx
            .select({ student: students, campusCode: campuses.code })
            .from(students)
            .leftJoin(
              campuses,
              and(eq(campuses.tenantId, students.tenantId), eq(campuses.id, students.primaryCampusId)),
            )
            .where(and(...batchConditions))
            .orderBy(asc(students.createdAt), asc(students.id))
            .limit(BATCH_SIZE)
            .execute(),
        );
        if (batch.length === 0) break;
        for (const r of batch) {
          yield serializeCsv([
            toExportRow({
              studentNo: r.student.studentNo,
              status: r.student.status,
              firstName: r.student.firstName,
              lastName: r.student.lastName,
              dateOfBirth: r.student.dateOfBirth,
              gender: r.student.gender,
              campusCode: r.campusCode ?? null,
              createdAt: r.student.createdAt,
            }),
          ]);
          rowsSent += 1;
          lastCreatedAt = r.student.createdAt;
          lastId = r.student.id;
        }
        if (batch.length < BATCH_SIZE) break;
      }
    } finally {
      await withTenant(app.db, ctx, (tx) =>
        writeAudit(tx, {
          scope: 'tenant',
          tenantId: ctx.tenantId,
          actorUserId: ctx.userId,
          action: 'student.exported',
          resourceType: 'student',
          newValue: {
            rows: rowsSent,
            filters: {
              q: query.q ?? null,
              status: query.status ?? null,
              campusId: campusFilter,
            },
          },
          requestId,
        }),
      );
    }
  })();
}

export default async function studentExportRoutes(app: FastifyInstance) {
  app.get(
    '/api/v1/students/export',
    {
      config: { authorization: { kind: 'tenant', permission: 'students.export' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('students.export')],
    },
    async (request, reply) => {
      const query = studentExportQuerySchema.parse(request.query);
      const ctx = request.ctx!;
      const stream = Readable.from(buildExportRows(app, ctx, query, request.requestId));
      reply.header('content-type', 'text/csv; charset=utf-8');
      reply.header('content-disposition', 'attachment; filename="students-export.csv"');
      reply.header('cache-control', 'private, no-store');
      return reply.send(stream);
    },
  );
}