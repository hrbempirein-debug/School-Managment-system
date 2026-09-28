import type { FastifyInstance } from 'fastify';
import { and, asc, count, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { admissionApplications, campuses, students, withTenant, type Tx } from '@sms/db';
import { writeAudit } from '@sms/audit';
import { enqueueOutbox } from '@sms/events';
import { requestFingerprint, withIdempotency } from '@sms/idempotency';
import { HttpError, type RequestContext } from '@sms/core';
import {
  admissionApplicationListQuerySchema,
  admissionSnapshotSchema,
  createAdmissionApplicationRequestSchema,
  idParamSchema,
  updateAdmissionApplicationRequestSchema,
  type AdmissionApplication,
} from '@sms/contracts';
import {
  requireSession,
  requireTenantContext,
  requirePermission,
  requireCsrf,
} from '../../plugins/auth.js';
import { idempotencyKeyFromHeader, mapDomainError, notFoundError, assertCampusScope } from './util.js';

type AdmissionRow = typeof admissionApplications.$inferSelect;
type StudentRow = typeof students.$inferSelect;

/**
 * Admission applications (Phase 3.5).
 *
 * Lifecycle is explicit and transition-only — `status` is never writable through
 * create or PATCH; each action route owns the ONLY path between two states:
 *   draft        --submit--> submitted --review--> under_review
 *   submitted | under_review --approve--> accepted
 *   submitted | under_review --reject--> rejected
 *   draft | submitted | under_review --withdraw--> withdrawn
 * `accepted`, `rejected` and `withdrawn` are terminal (PATCH is denied).
 *
 * Approve materializes the applicant into a student row (status `applicant`) from
 * the validated snapshot BEFORE flipping to `accepted`. The application row is
 * locked FOR UPDATE, so two concurrent approvals of the same application serialize
 * on the row lock and only the first wins; student_no uniqueness is re-guarded by
 * the tenant-local live students_student_no_uq, and the newly created student is
 * linked back via student_id (admission_applications_student_uq allows at most one
 * live link). A campus on the snapshot resolves by tenants-unique campus CODE
 * inside the caller's tenant and campus-authorization boundary — the API never
 * accepts a raw campus/tenant id in the snapshot.
 */

const EDITABLE_STATUSES = ['draft', 'submitted', 'under_review'] as const;
const APPROVABLE_STATUSES = ['submitted', 'under_review'] as const;
const REVIEWABLE_STATUSES = ['submitted'] as const;
const WITHDRAWABLE_STATUSES = ['draft', 'submitted', 'under_review'] as const;

type AppStatus = AdmissionRow['status'];

function invalidTransition(action: string): HttpError {
  return new HttpError(`Cannot ${action} an admission application in this state`, {
    status: 409,
    code: 'invalid_admission_transition',
  });
}

export function toAdmissionApplication(row: AdmissionRow): AdmissionApplication {
  return {
    id: row.id,
    tenantId: row.tenantId,
    studentId: row.studentId,
    status: row.status as AdmissionApplication['status'],
    snapshot: row.snapshot as AdmissionApplication['snapshot'],
    appliedOn: row.appliedOn,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export interface AdmissionCreateInput {
  snapshot: AdmissionApplication['snapshot'];
  studentId?: string;
  appliedOn?: string;
}

export async function createAdmissionApplication(
  tx: Tx,
  ctx: { userId: string; tenantId: string | null },
  input: AdmissionCreateInput,
  requestId: string,
): Promise<AdmissionRow> {
  try {
    if (input.studentId) {
      const student = await tx
        .select({ id: students.id })
        .from(students)
        .where(
          and(
            eq(students.tenantId, ctx.tenantId ?? ''),
            eq(students.id, input.studentId),
            isNull(students.deletedAt),
          ),
        )
        .limit(1)
        .execute()
        .then((r) => r[0]);
      if (!student) throw notFoundError('Student not found');
    }
    const rows = await tx
      .insert(admissionApplications)
      .values({
        tenantId: ctx.tenantId ?? '',
        studentId: input.studentId ?? null,
        status: 'draft',
        snapshot: input.snapshot,
        appliedOn: input.appliedOn ?? null,
      })
      .returning();
    const row = rows[0]!;
    await writeAudit(tx, {
      scope: 'tenant',
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action: 'admission.application.created',
      resourceType: 'admission_application',
      resourceId: row.id,
      newValue: toAdmissionApplication(row),
      requestId,
    });
    await enqueueOutbox(tx, {
      tenantId: ctx.tenantId,
      eventType: 'admission.application.created',
      aggregateType: 'admission_application',
      aggregateId: row.id,
      payload: { tenantId: ctx.tenantId, applicationId: row.id },
      correlationId: requestId,
    });
    return row;
  } catch (err) {
    throw mapDomainError(err);
  }
}

export interface AdmissionUpdateInput {
  snapshot?: AdmissionApplication['snapshot'];
  appliedOn?: string;
}

export async function updateAdmissionApplication(
  tx: Tx,
  ctx: { userId: string; tenantId: string | null },
  id: string,
  input: AdmissionUpdateInput,
  requestId: string,
): Promise<AdmissionRow | null> {
  try {
    const exists = await tx
      .select({ status: admissionApplications.status })
      .from(admissionApplications)
      .where(and(eq(admissionApplications.tenantId, ctx.tenantId ?? ''), eq(admissionApplications.id, id), isNull(admissionApplications.deletedAt)))
      .limit(1)
      .execute()
      .then((r) => r[0]);
    if (!exists) return null;
    if (!EDITABLE_STATUSES.includes(exists.status as (typeof EDITABLE_STATUSES)[number])) {
      throw new HttpError('Admission application is no longer editable', {
        status: 409,
        code: 'admission_not_editable',
      });
    }
    const rows = await tx
      .update(admissionApplications)
      .set({
        snapshot: input.snapshot,
        appliedOn: input.appliedOn,
      })
      .where(
        and(
          eq(admissionApplications.tenantId, ctx.tenantId ?? ''),
          eq(admissionApplications.id, id),
          inArray(admissionApplications.status, [...EDITABLE_STATUSES]),
          isNull(admissionApplications.deletedAt),
        ),
      )
      .returning();
    const row = rows[0]!;
    await writeAudit(tx, {
      scope: 'tenant',
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action: 'admission.application.updated',
      resourceType: 'admission_application',
      resourceId: id,
      oldValue: { status: exists.status },
      newValue: toAdmissionApplication(row),
      requestId,
    });
    await enqueueOutbox(tx, {
      tenantId: ctx.tenantId,
      eventType: 'admission.application.updated',
      aggregateType: 'admission_application',
      aggregateId: id,
      payload: { tenantId: ctx.tenantId, applicationId: id },
      correlationId: requestId,
    });
    return row;
  } catch (err) {
    throw mapDomainError(err);
  }
}

/**
 * Single-winner status transition. Returns null when no live application matches;
 * throws 409 `invalid_admission_transition` when it exists but is not in an
 * allowed source state (e.g. concurrent submit already moved it on).
 */
export async function transitionAdmissionApplication(
  tx: Tx,
  ctx: { userId: string; tenantId: string | null },
  id: string,
  allowed: readonly string[],
  target: AppStatus,
  eventType: 'admission.application.submitted' | 'admission.application.review_started' | 'admission.application.rejected' | 'admission.application.withdrawn',
  action: string,
  requestId: string,
): Promise<AdmissionRow | null> {
  try {
    const rows = await tx
      .update(admissionApplications)
      .set({ status: target })
      .where(
        and(
          eq(admissionApplications.tenantId, ctx.tenantId ?? ''),
          eq(admissionApplications.id, id),
          inArray(admissionApplications.status, [...allowed]),
          isNull(admissionApplications.deletedAt),
        ),
      )
      .returning();
    if (rows.length === 0) {
      const exists = await tx
        .select({ id: admissionApplications.id })
        .from(admissionApplications)
        .where(
          and(
            eq(admissionApplications.tenantId, ctx.tenantId ?? ''),
            eq(admissionApplications.id, id),
            isNull(admissionApplications.deletedAt),
          ),
        )
        .limit(1)
        .execute()
        .then((r) => r[0]);
      if (!exists) return null;
      throw invalidTransition(action);
    }
    const row = rows[0]!;
    await writeAudit(tx, {
      scope: 'tenant',
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action: eventType,
      resourceType: 'admission_application',
      resourceId: id,
      newValue: { status: target },
      requestId,
    });
    await enqueueOutbox(tx, {
      tenantId: ctx.tenantId,
      eventType,
      aggregateType: 'admission_application',
      aggregateId: id,
      payload: { tenantId: ctx.tenantId, applicationId: id },
      correlationId: requestId,
    });
    return row;
  } catch (err) {
    throw mapDomainError(err);
  }
}

export interface AdmissionApprovalResult {
  application: AdmissionRow;
  student: StudentRow | null;
}

/**
 * Approve an application. The row is locked FOR UPDATE first, so concurrent
 * approvals serialize and the second one observes `accepted` and fails with 409 —
 * a single-winner guarantee without relying on the update guard alone. The
 * applicant student (status `applicant`) is created from the validated snapshot
 * and linked back; a student_no conflict rolls the whole approval back.
 */
export async function approveAdmission(
  tx: Tx,
  ctx: { userId: string; tenantId: string | null; campusId: string | null },
  id: string,
  requestId: string,
): Promise<AdmissionApprovalResult | null> {
  try {
    const locked = await tx
      .select()
      .from(admissionApplications)
      .where(
        and(
          eq(admissionApplications.tenantId, ctx.tenantId ?? ''),
          eq(admissionApplications.id, id),
          isNull(admissionApplications.deletedAt),
        ),
      )
      .limit(1)
      .for('update')
      .execute();
    const current = locked[0];
    if (!current) return null;
    if (!APPROVABLE_STATUSES.includes(current.status as (typeof APPROVABLE_STATUSES)[number])) {
      throw invalidTransition('approve');
    }

    let studentId = current.studentId;
    let createdStudent: StudentRow | null = null;
    if (!studentId) {
      const snapshot = admissionSnapshotSchema.parse(current.snapshot);
      const campusId = await resolveCampusId(tx, ctx.tenantId, snapshot);
      assertCampusScope(ctx, campusId);
      const inserted = await tx
        .insert(students)
        .values({
          tenantId: ctx.tenantId ?? '',
          studentNo: snapshot.studentNo,
          firstName: snapshot.firstName,
          lastName: snapshot.lastName,
          dateOfBirth: snapshot.dateOfBirth ?? null,
          gender: snapshot.gender ?? null,
          status: 'applicant',
          primaryCampusId: campusId,
        })
        .returning();
      createdStudent = inserted[0]!;
      studentId = createdStudent.id;
      await writeAudit(tx, {
        scope: 'tenant',
        tenantId: ctx.tenantId,
        actorUserId: ctx.userId,
        action: 'student.created',
        resourceType: 'student',
        resourceId: createdStudent.id,
        newValue: {
          studentId: createdStudent.id,
          studentNo: createdStudent.studentNo,
          firstName: createdStudent.firstName,
          lastName: createdStudent.lastName,
          status: createdStudent.status,
        },
        requestId,
      });
      await enqueueOutbox(tx, {
        tenantId: ctx.tenantId,
        eventType: 'student.created',
        aggregateType: 'student',
        aggregateId: createdStudent.id,
        payload: {
          tenantId: ctx.tenantId,
          studentId: createdStudent.id,
          studentNo: createdStudent.studentNo,
          status: createdStudent.status,
        },
        correlationId: requestId,
      });
    }

    const flipped = await tx
      .update(admissionApplications)
      .set({ status: 'accepted', studentId })
      .where(
        and(
          eq(admissionApplications.tenantId, ctx.tenantId ?? ''),
          eq(admissionApplications.id, id),
          inArray(admissionApplications.status, [...APPROVABLE_STATUSES]),
          isNull(admissionApplications.deletedAt),
        ),
      )
      .returning();
    const row = flipped[0]!;
    await writeAudit(tx, {
      scope: 'tenant',
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action: 'admission.application.approved',
      resourceType: 'admission_application',
      resourceId: id,
      oldValue: { status: current.status },
      newValue: toAdmissionApplication(row),
      requestId,
    });
    await enqueueOutbox(tx, {
      tenantId: ctx.tenantId,
      eventType: 'admission.application.approved',
      aggregateType: 'admission_application',
      aggregateId: id,
      payload: { tenantId: ctx.tenantId, applicationId: id, studentId },
      correlationId: requestId,
    });
    return { application: row, student: createdStudent };
  } catch (err) {
    throw mapDomainError(err);
  }
}

/** Resolves snapshot.campusCode (tenants-unique campus code) inside the tenant, active only. */
async function resolveCampusId(
  tx: Tx,
  tenantId: string | null,
  snapshot: { campusCode?: string },
): Promise<string | null> {
  if (!snapshot.campusCode) return null;
  const campus = await tx
    .select({ id: campuses.id })
    .from(campuses)
    .where(and(eq(campuses.tenantId, tenantId ?? ''), eq(campuses.code, snapshot.campusCode), eq(campuses.status, 'active')))
    .limit(1)
    .execute()
    .then((r) => r[0]);
  if (!campus) {
    throw new HttpError('Admission snapshot references an unknown or inactive campus code', {
      status: 422,
      code: 'admission_campus_not_found',
    });
  }
  return campus.id;
}

async function resolveApplication(
  app: FastifyInstance,
  ctx: RequestContext,
  id: string,
): Promise<AdmissionRow | null> {
  return withTenant(app.db, ctx, (tx) =>
    tx
      .select()
      .from(admissionApplications)
      .where(and(eq(admissionApplications.tenantId, ctx.tenantId ?? ''), eq(admissionApplications.id, id), isNull(admissionApplications.deletedAt)))
      .limit(1)
      .execute()
      .then((r) => r[0] ?? null),
  );
}

export default async function admissionApplicationRoutes(app: FastifyInstance) {
  app.get(
    '/api/v1/admission-applications',
    {
      config: { authorization: { kind: 'tenant', permission: 'admission.read' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('admission.read')],
    },
    async (request) => {
      const query = admissionApplicationListQuerySchema.parse(request.query);
      const ctx = request.ctx!;
      const conditions = [eq(admissionApplications.tenantId, ctx.tenantId ?? ''), isNull(admissionApplications.deletedAt)];
      if (query.status) conditions.push(eq(admissionApplications.status, query.status));
      if (query.q) {
        conditions.push(
          sql`(${admissionApplications.snapshot}->>'first_name' || ' ' || ${admissionApplications.snapshot}->>'last_name') ILIKE ${`%${query.q}%`}`,
        );
      }
      const byStatus = [desc(admissionApplications.createdAt), asc(admissionApplications.id)];
      const rows = await withTenant(app.db, ctx, (tx) =>
        tx
          .select()
          .from(admissionApplications)
          .where(and(...conditions))
          .orderBy(...byStatus)
          .limit(query.limit)
          .offset(query.offset)
          .execute(),
      );
      const totalRow = await withTenant(app.db, ctx, (tx) =>
        tx
          .select({ total: count() })
          .from(admissionApplications)
          .where(and(...conditions))
          .execute(),
      );
      return { items: rows.map(toAdmissionApplication), total: totalRow[0]?.total ?? 0 };
    },
  );

  app.post(
    '/api/v1/admission-applications',
    {
      config: { authorization: { kind: 'tenant', permission: 'admission.create' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('admission.create'), requireCsrf()],
    },
    async (request, reply) => {
      const body = createAdmissionApplicationRequestSchema.parse(request.body);
      const ctx = request.ctx!;
      const idemKey = idempotencyKeyFromHeader(request.headers);
      const fingerprint = requestFingerprint(request.method, request.url, body);
      const outcome = await withTenant(app.db, ctx, (tx) =>
        withIdempotency(tx, { tenantId: ctx.tenantId, key: idemKey }, fingerprint, async () => {
          const row = await createAdmissionApplication(tx, ctx, body, request.requestId);
          return { status: 201, body: { application: toAdmissionApplication(row) } };
        }),
      );
      return reply.code(outcome.status).send(outcome.body);
    },
  );

  app.get(
    '/api/v1/admission-applications/:id',
    {
      config: { authorization: { kind: 'tenant', permission: 'admission.read' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('admission.read')],
    },
    async (request) => {
      const { id } = idParamSchema.parse(request.params);
      const ctx = request.ctx!;
      const row = await resolveApplication(app, ctx, id);
      if (!row) throw notFoundError('Admission application not found');
      return { application: toAdmissionApplication(row) };
    },
  );

  app.patch(
    '/api/v1/admission-applications/:id',
    {
      config: { authorization: { kind: 'tenant', permission: 'admission.update' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('admission.update'), requireCsrf()],
    },
    async (request, reply) => {
      const { id } = idParamSchema.parse(request.params);
      const body = updateAdmissionApplicationRequestSchema.parse(request.body);
      const ctx = request.ctx!;
      const idemKey = idempotencyKeyFromHeader(request.headers);
      const fingerprint = requestFingerprint(request.method, request.url, body);
      const outcome = await withTenant(app.db, ctx, (tx) =>
        withIdempotency(tx, { tenantId: ctx.tenantId, key: idemKey }, fingerprint, async () => {
          const row = await updateAdmissionApplication(tx, ctx, id, body, request.requestId);
          if (!row) throw notFoundError('Admission application not found');
          return { status: 200, body: { application: toAdmissionApplication(row) } };
        }),
      );
      return reply.code(outcome.status).send(outcome.body);
    },
  );

  app.post(
    '/api/v1/admission-applications/:id/submit',
    {
      config: { authorization: { kind: 'tenant', permission: 'admission.review' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('admission.review'), requireCsrf()],
    },
    async (request, reply) => {
      const { id } = idParamSchema.parse(request.params);
      const ctx = request.ctx!;
      const idemKey = idempotencyKeyFromHeader(request.headers);
      const fingerprint = requestFingerprint(request.method, request.url, {});
      const outcome = await withTenant(app.db, ctx, (tx) =>
        withIdempotency(tx, { tenantId: ctx.tenantId, key: idemKey }, fingerprint, async () => {
          const row = await transitionAdmissionApplication(
            tx,
            ctx,
            id,
            ['draft'],
            'submitted',
            'admission.application.submitted',
            'submit',
            request.requestId,
          );
          if (!row) throw notFoundError('Admission application not found');
          return { status: 200, body: { application: toAdmissionApplication(row) } };
        }),
      );
      return reply.code(outcome.status).send(outcome.body);
    },
  );

  app.post(
    '/api/v1/admission-applications/:id/review',
    {
      config: { authorization: { kind: 'tenant', permission: 'admission.review' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('admission.review'), requireCsrf()],
    },
    async (request, reply) => {
      const { id } = idParamSchema.parse(request.params);
      const ctx = request.ctx!;
      const idemKey = idempotencyKeyFromHeader(request.headers);
      const fingerprint = requestFingerprint(request.method, request.url, {});
      const outcome = await withTenant(app.db, ctx, (tx) =>
        withIdempotency(tx, { tenantId: ctx.tenantId, key: idemKey }, fingerprint, async () => {
          const row = await transitionAdmissionApplication(
            tx,
            ctx,
            id,
            REVIEWABLE_STATUSES,
            'under_review',
            'admission.application.review_started',
            'start the review of',
            request.requestId,
          );
          if (!row) throw notFoundError('Admission application not found');
          return { status: 200, body: { application: toAdmissionApplication(row) } };
        }),
      );
      return reply.code(outcome.status).send(outcome.body);
    },
  );

  app.post(
    '/api/v1/admission-applications/:id/approve',
    {
      config: { authorization: { kind: 'tenant', permission: 'admission.review' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('admission.review'), requireCsrf()],
    },
    async (request, reply) => {
      const { id } = idParamSchema.parse(request.params);
      const ctx = request.ctx!;
      const idemKey = idempotencyKeyFromHeader(request.headers);
      const fingerprint = requestFingerprint(request.method, request.url, {});
      const outcome = await withTenant(app.db, ctx, (tx) =>
        withIdempotency(tx, { tenantId: ctx.tenantId, key: idemKey }, fingerprint, async () => {
          const result = await approveAdmission(tx, ctx, id, request.requestId);
          if (!result) throw notFoundError('Admission application not found');
          return { status: 200, body: { application: toAdmissionApplication(result.application) } };
        }),
      );
      return reply.code(outcome.status).send(outcome.body);
    },
  );

  app.post(
    '/api/v1/admission-applications/:id/reject',
    {
      config: { authorization: { kind: 'tenant', permission: 'admission.review' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('admission.review'), requireCsrf()],
    },
    async (request, reply) => {
      const { id } = idParamSchema.parse(request.params);
      const ctx = request.ctx!;
      const idemKey = idempotencyKeyFromHeader(request.headers);
      const fingerprint = requestFingerprint(request.method, request.url, {});
      const outcome = await withTenant(app.db, ctx, (tx) =>
        withIdempotency(tx, { tenantId: ctx.tenantId, key: idemKey }, fingerprint, async () => {
          const row = await transitionAdmissionApplication(
            tx,
            ctx,
            id,
            APPROVABLE_STATUSES,
            'rejected',
            'admission.application.rejected',
            'reject',
            request.requestId,
          );
          if (!row) throw notFoundError('Admission application not found');
          return { status: 200, body: { application: toAdmissionApplication(row) } };
        }),
      );
      return reply.code(outcome.status).send(outcome.body);
    },
  );

  app.post(
    '/api/v1/admission-applications/:id/withdraw',
    {
      config: { authorization: { kind: 'tenant', permission: 'admission.review' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('admission.review'), requireCsrf()],
    },
    async (request, reply) => {
      const { id } = idParamSchema.parse(request.params);
      const ctx = request.ctx!;
      const idemKey = idempotencyKeyFromHeader(request.headers);
      const fingerprint = requestFingerprint(request.method, request.url, {});
      const outcome = await withTenant(app.db, ctx, (tx) =>
        withIdempotency(tx, { tenantId: ctx.tenantId, key: idemKey }, fingerprint, async () => {
          const row = await transitionAdmissionApplication(
            tx,
            ctx,
            id,
            WITHDRAWABLE_STATUSES,
            'withdrawn',
            'admission.application.withdrawn',
            'withdraw',
            request.requestId,
          );
          if (!row) throw notFoundError('Admission application not found');
          return { status: 200, body: { application: toAdmissionApplication(row) } };
        }),
      );
      return reply.code(outcome.status).send(outcome.body);
    },
  );
}